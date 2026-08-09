/**
 * 同期API の Lambda。
 *
 * 中身は backend/ の TypeScript を esbuild で1ファイルにまとめたもの。
 * 疎通確認用の Hello World（backend/hello/index.mjs）から差し替えた。
 * **関数・ロググループ・実行ロールは作ったときのまま使っている**（変わったのはコードだけ）。
 *
 * 実行ロールは iam.tf の同期API用（台帳・マスタ・S3・SSM）。
 *
 * 非同期Lambda（S3イベント）はここに書かない。S3 通知の設定とセットで週3に作る。
 */

/**
 * zip は Terraform 側で作る。
 * source_code_hash に zip の中身のハッシュを入れておくと、
 * バンドルを作り直しただけで apply が更新を検知する。
 *
 * **参照先はビルド成果物なので、apply の前に `npm run build` が必要。**
 * dist/ は .gitignore の対象でリポジトリには入らない。ビルドせずに plan を実行すると
 * 「ファイルが無い」というエラーで止まる（手順は infra/README.md）。
 *
 * TypeScript のソースを直接 zip にしない理由は、Lambda が TypeScript を実行できないため。
 * esbuild が1ファイルの .mjs にまとめる。**AWS SDK はバンドルに同梱する**
 * （ランタイム同梱の SDK は AWS の都合で更新され、こちらが変更していないのに
 * 挙動が変わりうるため）。同梱に伴う createRequire の banner を含め、理由は backend/build.js。
 */
data "archive_file" "api" {
  type        = "zip"
  source_file = "${path.module}/../backend/dist/index.mjs"
  output_path = "${path.module}/build/api.zip"
}

/**
 * ロググループを明示的に作る。
 *
 * 作らなくても Lambda が自動で作るが、その場合の保持期間は「無期限」になり、
 * ログが増え続けてコスト要件（月1,000円）をじわじわ圧迫する。
 * 先に作っておけば保持期間を指定できる。
 *
 * 名前は /aws/lambda/<関数名> でなければ Lambda が別のグループを作ってしまう。
 *
 * **保持期間を1年にしているのは、このグループが監査記録を兼ねるため。**
 * エクセル・旧版の取得時に氏名・文書番号・ファイル種別・日時を書く（CLAUDE.md §8-7）。
 * 2週間で消えると「誰が持ち出したか」を後から追えず、記録として機能しない。
 * ログ量はごく小さいので、伸ばしてもコスト要件には影響しない。
 */
resource "aws_cloudwatch_log_group" "api" {
  name              = "/aws/lambda/q-documents-api"
  retention_in_days = 365
}

resource "aws_lambda_function" "api" {
  function_name = "q-documents-api"
  description   = "Synchronous API handler"
  role          = aws_iam_role.api.arn

  runtime = "nodejs22.x"
  handler = "index.handler"

  filename         = data.archive_file.api.output_path
  source_code_hash = data.archive_file.api.output_base64sha256

  # 署名付きURLの発行と DynamoDB の読み書きが主な処理。長時間の処理はない
  timeout     = 10
  memory_size = 256

  /**
   * ハンドラに直書きせず環境変数で渡す。
   *
   * ALLOWED_ORIGIN — 画面と API はドメインが違う（CloudFront と execute-api）ため、
   *   ブラウザからの呼び出しはすべてクロスオリジンになる。許可するのは画面のオリジンだけで、
   *   ワイルドカードは使わない（docs/API.md §補足：セキュリティ）。
   *   直書きしないのは、ディストリビューションを作り直すとドメインが変わるため。
   *
   * **秘密の値そのものはここに置かない。** Lambda の環境変数はコンソールから平文で見え、
   * Terraform state にも残る（CLAUDE.md §8-1）。渡すのは SSM の**パラメータ名**だけで、
   * 値は実行時に SSM から読む。
   *
   * TOKEN_TTL_SECONDS — 合言葉トークンの有効期間。2時間。
   *   画面側の「30分の無操作で自動ロック」とは目的が違うので同じ値にしない。
   *     画面側 = 席を立った隙に使われないための離席対策
   *     ここ   = 盗まれたトークンが使われ続けないための上限
   *   同じ30分にすると、30分続けて操作している最中に切れてしまう。
   */
  environment {
    variables = {
      ALLOWED_ORIGIN     = "https://${aws_cloudfront_distribution.frontend.domain_name}"
      MASTERS_TABLE      = aws_dynamodb_table.masters.name
      LEDGER_TABLE       = aws_dynamodb_table.ledger.name
      PASSPHRASE_PARAM   = aws_ssm_parameter.passphrase.name
      TOKEN_SECRET_PARAM = aws_ssm_parameter.token_secret.name
      TOKEN_TTL_SECONDS  = "7200"
    }
  }

  # ロググループを先に作らせる。関数が先だと Lambda 側が保持期間なしで作ってしまう
  depends_on = [aws_cloudwatch_log_group.api]
}

/**
 * API Gateway から呼べるようにする。
 *
 * IAM ロール（Lambda が何をできるか）とは別に、**誰がこの関数を呼べるか**を
 * リソースベースのポリシーで許可する必要がある。これがないと 500 になる。
 *
 * API Gateway が Lambda を呼ぶときの ARN は次の形になる。
 *
 *   arn:aws:execute-api:<region>:<account>:<api-id>/prod/GET/hello
 *                                                  ステージ/メソッド/パス
 *
 * IAM の照合では * が / を含む任意の文字列に一致する
 * （S3 の bucket/* が bucket/a/b/c に一致するのと同じ）。
 * そのため末尾のワイルドカードは、2つ並べても1つだけでも一致する範囲は変わらない。
 * 2つにしているのは「ステージ / それ以降」と読めるようにするためで、
 * 絞り込みが強くなっているわけではない。
 *
 * **ステージまで絞って /prod/* とはしない。**
 * source_arn が防いでいるのは「別のAPIから呼ばれること」（混乱した代理人問題）で、
 * それは <api-id> を含んでいる時点で達成できている。自分の別ステージは脅威ではない。
 * 一方でステージを固定すると、あとから別のステージを足したときに
 * そこからの呼び出しだけが 500 で落ち、画面には Internal server error としか出ない。
 * 増える安全がほぼ無いのに、原因の見えにくい故障の種だけが増える。
 */
resource "aws_lambda_permission" "api_gateway" {
  statement_id  = "AllowExecutionFromAPIGateway"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.api.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_api_gateway_rest_api.api.execution_arn}/*/*"
}
