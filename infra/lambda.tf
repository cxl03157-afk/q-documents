/**
 * Lambda 2つと、それぞれの起動経路。
 *
 *   同期API      — API Gateway から。ファイル前半
 *   非同期Lambda — S3 通知から。ファイル後半（S3 通知の設定もそちらに置く）
 *
 * 中身は backend/ の TypeScript を esbuild でまとめたもの（1回のビルドで2本出る）。
 * 実行ロールは iam.tf で分けてある。責務の境界をそのまま権限の境界にしている（CLAUDE.md §7）。
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
   * FILES_BUCKET — 署名付きURLを発行する対象のバケット。名前にランダムな接尾辞が入るので
   *   直書きできない。**IAM 側は既に `s3:PutObject` / `s3:GetObject` を許可済み**（iam.tf）で、
   *   署名付きURLはこのロールの権限をそのまま引き継ぐ。
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
      FILES_BUCKET       = aws_s3_bucket.files.bucket
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

# --- 非同期Lambda（S3イベント）---------------------------------------------

/**
 * S3 に実体が置かれたあとの処理を担う（CLAUDE.md §7）。
 *
 *   S3キーの記録 / 状態遷移 / 旧版のストレージクラス変更
 *
 * **クライアントから直接呼ばれる口を持たない。** 起動経路は S3 通知だけで、
 * API Gateway からは呼べない（aws_lambda_permission が S3 にしか出ていない）。
 *
 * 同期API とはバンドルも実行ロールも分けてある。合言葉もトークンも扱わないので
 * SSM の読み取り権限を持たず、マスタテーブルにも手が届かない（iam.tf）。
 */
data "archive_file" "async" {
  type        = "zip"
  source_file = "${path.module}/../backend/dist/async.mjs"
  output_path = "${path.module}/build/async.zip"
}

/**
 * 保持期間の理由は同期API側と同じ（監査記録を兼ねる・CLAUDE.md §8-7）。
 * こちらには「どのファイルがいつ旧版になり、どのストレージクラスへ移ったか」が残る。
 * 台帳は現在の姿しか持たないので、経緯を追えるのはこのログだけ。
 */
resource "aws_cloudwatch_log_group" "async" {
  name              = "/aws/lambda/q-documents-async"
  retention_in_days = 365
}

resource "aws_lambda_function" "async" {
  function_name = "q-documents-async"
  description   = "S3 event handler: records keys, advances status, archives old revisions"
  role          = aws_iam_role.async.arn

  runtime = "nodejs22.x"
  handler = "async.handler"

  filename         = data.archive_file.async.output_path
  source_code_hash = data.archive_file.async.output_base64sha256

  # DynamoDB の書き込みと CopyObject。CopyObject はサーバー側で完結するが、
  # 前リビジョンが複数あると数回繰り返すため同期API（10秒）より長く取る
  timeout     = 60
  memory_size = 256

  /**
   * **`reserved_concurrent_executions` は設定しない。**
   *
   * 当初は再帰の三次防御として 5 を予約する計画だったが、apply が
   * `InvalidParameterValueException` で失敗した。
   * **このアカウントの Lambda 同時実行上限が 10** で（既定の 1000 ではなく
   * 新規アカウントの縮小枠）、予約は「予約後の未予約枠が 10 以上」を要求するため、
   * 正の値はどれも設定できない。
   *
   * **外して構わないと判断した。** 上限 10 がそのまま天井として働くので、
   * 万一再帰しても同時に走るのは最大 10 で、5 を予約した場合と桁は変わらない。
   * そもそも再帰は発生源で断ってある（通知フィルタが Post のみ）うえ、
   * 段1の状態ガードとストレージクラスの事前確認が 1 ホップで止める。
   *
   * 引き換えに失うものが1つある。予約が無いので、非同期Lambdaが枠を使い切ると
   * **同期API（画面）がスロットリングされうる**。1文書あたり PDF とエクセルの
   * 2並列で、同時に何十件も登録する使い方をしないため実害は想定していない。
   *
   * **緊急停止は S3 通知を外す**（下の aws_s3_bucket_notification を消して apply）。
   * 関数を消さずに起動経路だけを断てる。
   * 上限を引き上げたい場合は Service Quotas の「Concurrent executions」に申請する。
   */

  /**
   * **同期API とは渡す環境変数が違う。** ALLOWED_ORIGIN も SSM のパラメータ名も要らない。
   * 余分に渡さないのは、この関数が何に触れるかを定義から読めるようにするため。
   */
  environment {
    variables = {
      LEDGER_TABLE = aws_dynamodb_table.ledger.name
      FILES_BUCKET = aws_s3_bucket.files.bucket
    }
  }

  depends_on = [aws_cloudwatch_log_group.async]
}

/**
 * S3 から呼べるようにする。
 *
 * **source_account を併記する。** S3 の source_arn（`arn:aws:s3:::バケット名`）は
 * リージョンもアカウントIDも含まないため、これだけだと「そのバケット名からの通知」
 * としか言えない。バケットを消したあと同じ名前を他人に取られた場合に、
 * その通知でこの関数が呼ばれうる（混乱した代理人問題）。
 */
resource "aws_lambda_permission" "async_s3" {
  statement_id   = "AllowExecutionFromS3"
  action         = "lambda:InvokeFunction"
  function_name  = aws_lambda_function.async.function_name
  principal      = "s3.amazonaws.com"
  source_arn     = aws_s3_bucket.files.arn
  source_account = data.aws_caller_identity.current.account_id
}

/**
 * S3 通知。**バケット側の設定だが、Lambda と対で読めるようにこちらに置く**
 * （バケットポリシーを cloudfront.tf に置いているのと同じ考え方）。
 *
 * ---
 *
 * **`s3:ObjectCreated:Post` だけに絞るのが再帰の一次防御**（Issue #19）。
 *
 * アップロードは presigned POST なので `Post` で届く。一方、非同期Lambda自身が行う
 * ストレージクラス変更は `CopyObject` なので `Copy` になり、**発火しない**。
 * `ObjectCreated:*` にすると自分の書き込みで自分が起動する経路が開く。
 *
 * AWS 側にも Lambda の recursive loop detection（2024/10 から S3 も対象・既定オン）が
 * あるが、約16回回ってから止まり通知は最大3.5時間遅れる。しかも Glacier IR への
 * 同一キーコピーは置き換えのたびに90日ぶんの early deletion 料金が乗るので、
 * 16回でも安くない。**AWS 側の検出は最後の網**という位置づけにする。
 *
 * 権限が無い状態で通知を設定しようとすると S3 が拒否するので、順序を明示する。
 */
resource "aws_s3_bucket_notification" "files" {
  bucket = aws_s3_bucket.files.id

  lambda_function {
    lambda_function_arn = aws_lambda_function.async.arn
    events              = ["s3:ObjectCreated:Post"]
  }

  depends_on = [aws_lambda_permission.async_s3]
}
