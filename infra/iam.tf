/**
 * Lambda 実行ロール2つ。
 *
 * CLAUDE.md §7 の責務分担を、そのまま権限の境界にする。
 * 分けておくと、片方が壊れてももう片方の担当範囲には手が届かない。
 *
 *   同期API Lambda     — 合言葉の検証・採番・照合・台帳記録・署名付きURL発行
 *   非同期Lambda（S3イベント） — S3キーの記録・状態遷移・ストレージクラス変更
 *
 * 非同期Lambda にマスタへの権限は与えない。マスタを触る仕事がないため。
 *
 * ---
 *
 * **ポリシーの付け方を2種類使い分けている。**
 *
 *   aws_iam_role_policy            — インラインポリシー。自作の権限に使う
 *   aws_iam_role_policy_attachment — 管理ポリシーのアタッチ。AWS 管理のものに使う
 *
 * 自作の権限をインラインにする理由は3つ。
 *
 *   1. 再利用しない。この2つの権限セットは各ロール専用で、共有したら
 *      責務を分けた意味がなくなる（CLAUDE.md §7）
 *   2. 孤児が出ない。ロールを消せばポリシーも一緒に消える。
 *      顧客管理ポリシーだと本体とアタッチメントが別リソースになり、消し忘れが起きる
 *   3. 1対1の対応が1リソースで読める。顧客管理だと定義とアタッチメントを行き来する
 *
 * ログ出力だけ AWS 管理ポリシー（AWSLambdaBasicExecutionRole）に乗せるのは、
 * 中身を AWS が保守してくれるため。自分で書き写すと、AWS 側で必要な権限が
 * 増えたときに追随できない。ログ出力は全 Lambda で共通の関心事でもある。
 *
 * 同じ権限を3つ目のロールにも付けたくなったら、そのとき顧客管理ポリシーに切り替える。
 */

data "aws_iam_policy_document" "lambda_assume_role" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

# --- 同期API Lambda ---------------------------------------------------------

resource "aws_iam_role" "api" {
  name               = "q-documents-api-role"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume_role.json
}

# CloudWatch Logs への書き込み。AWS 管理ポリシーで足りる範囲
resource "aws_iam_role_policy_attachment" "api_logs" {
  role       = aws_iam_role.api.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

data "aws_iam_policy_document" "api" {
  # 台帳: 照合・採番・一覧・記録・論理削除
  # 一覧（F-05）は全件返す設計のため Scan が要る（docs/API.md）
  statement {
    sid = "LedgerReadWrite"
    actions = [
      "dynamodb:GetItem",
      "dynamodb:Query",
      "dynamodb:Scan",
      "dynamodb:PutItem",
      "dynamodb:UpdateItem",
    ]
    resources = [aws_dynamodb_table.ledger.arn]
  }

  # マスタ: CRUD（F-10）。物理削除はしないので DeleteItem は与えない
  statement {
    sid = "MastersReadWrite"
    actions = [
      "dynamodb:GetItem",
      "dynamodb:Query",
      "dynamodb:Scan",
      "dynamodb:PutItem",
      "dynamodb:UpdateItem",
    ]
    resources = [aws_dynamodb_table.masters.arn]
  }

  /**
   * 署名付きURLは、発行した実行ロールの権限を引き継ぐ。
   * アップロード用に PutObject、ダウンロード用に GetObject が要る。
   * バケットそのものへの操作（削除・設定変更）は与えない。
   */
  statement {
    sid       = "FilesPresignedUrl"
    actions   = ["s3:PutObject", "s3:GetObject"]
    resources = ["${aws_s3_bucket.files.arn}/*"]
  }

  # 合言葉の読み出し（F-18）
  statement {
    sid       = "ReadPassphrase"
    actions   = ["ssm:GetParameter"]
    resources = [aws_ssm_parameter.passphrase.arn]
  }

  /**
   * SecureString の復号。AWS 管理キー（alias/aws/ssm）は ARN を参照できないため
   * resources を絞れない。代わりに「SSM 経由の呼び出しに限る」条件を付ける。
   */
  statement {
    sid       = "DecryptViaSsm"
    actions   = ["kms:Decrypt"]
    resources = ["*"]

    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values   = ["ssm.${var.region}.amazonaws.com"]
    }
  }
}

resource "aws_iam_role_policy" "api" {
  name   = "q-documents-api-policy"
  role   = aws_iam_role.api.id
  policy = data.aws_iam_policy_document.api.json
}

# --- 非同期Lambda（S3イベント） ---------------------------------------------

resource "aws_iam_role" "async" {
  name               = "q-documents-async-role"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume_role.json
}

resource "aws_iam_role_policy_attachment" "async_logs" {
  role       = aws_iam_role.async.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

data "aws_iam_policy_document" "async" {
  /**
   * 台帳: S3キーの記録と状態遷移。
   * Query が要るのは、新しい Rev が「最新」になったときに前の Rev を「旧版」へ
   * 落とすため（同じ文書IDの他リビジョンを探す）。
   * PutItem は与えない。この Lambda がレコードを新規に作ることはない。
   */
  statement {
    sid = "LedgerUpdate"
    actions = [
      "dynamodb:GetItem",
      "dynamodb:Query",
      "dynamodb:UpdateItem",
    ]
    resources = [aws_dynamodb_table.ledger.arn]
  }

  /**
   * ストレージクラスの変更は同一キーへの CopyObject で行う（CLAUDE.md §6）。
   * CopyObject はコピー元の GetObject とコピー先の PutObject を必要とする。
   * DeleteObject は与えない。この Lambda が実体を消すことはない。
   */
  statement {
    sid       = "FilesCopyForStorageClass"
    actions   = ["s3:GetObject", "s3:PutObject"]
    resources = ["${aws_s3_bucket.files.arn}/*"]
  }
}

resource "aws_iam_role_policy" "async" {
  name   = "q-documents-async-policy"
  role   = aws_iam_role.async.id
  policy = data.aws_iam_policy_document.async.json
}
