/**
 * 同期API の Lambda。
 *
 * 今日入れるのは疎通確認用の Hello World（backend/hello/index.mjs）で、
 * 8/9 以降に本物のハンドラへ差し替える。**関数とロググループはそのまま使う。**
 * 先に器を作っておくと、差し替えのときに変わるのがコードだけになる。
 *
 * 実行ロールは iam.tf の同期API用（台帳・マスタ・S3・SSM）をそのまま使う。
 * Hello World には過剰な権限だが、今日のためだけにロールを作ると
 * 差し替え時に権限の付け替えが要る。
 *
 * 非同期Lambda（S3イベント）はここに書かない。S3 通知の設定とセットで週3に作る。
 */

/**
 * zip は Terraform 側で作る。
 * source_code_hash に zip の中身のハッシュを入れておくと、
 * index.mjs を編集しただけで apply が更新を検知する。
 */
data "archive_file" "hello" {
  type        = "zip"
  source_file = "${path.module}/../backend/hello/index.mjs"
  output_path = "${path.module}/build/hello.zip"
}

/**
 * ロググループを明示的に作る。
 *
 * 作らなくても Lambda が自動で作るが、その場合の保持期間は「無期限」になり、
 * ログが増え続けてコスト要件（月1,000円）をじわじわ圧迫する。
 * 先に作っておけば保持期間を指定できる。
 *
 * 名前は /aws/lambda/<関数名> でなければ Lambda が別のグループを作ってしまう。
 */
resource "aws_cloudwatch_log_group" "api" {
  name              = "/aws/lambda/q-documents-api"
  retention_in_days = 14
}

resource "aws_lambda_function" "api" {
  function_name = "q-documents-api"
  description   = "Synchronous API handler (placeholder: hello world)"
  role          = aws_iam_role.api.arn

  runtime = "nodejs22.x"
  handler = "index.handler"

  filename         = data.archive_file.hello.output_path
  source_code_hash = data.archive_file.hello.output_base64sha256

  # 署名付きURLの発行と DynamoDB の読み書きが主な処理。長時間の処理はない
  timeout     = 10
  memory_size = 256

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
