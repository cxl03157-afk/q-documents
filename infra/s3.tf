/**
 * S3 バケット2本。
 *
 * files    — PDF・エクセルの実体
 * frontend — 画面の静的ファイル
 *
 * どちらも Block Public Access を全項目 true にし、直接アクセスさせない（CLAUDE.md §8-5）。
 *
 * **バケットポリシー（OAC からの読み取り許可）はここに書かない。**
 * CloudFront ディストリビューションの ARN を条件に入れる必要があり、
 * そのディストリビューションは 8/7 の公開層で作るため。
 *
 * **ライフサイクルルールも書かない。**
 * ストレージクラスの割り当て（CLAUDE.md §6）は「最新になったら Standard-IA」
 * 「旧版になったら Glacier IR」という状態遷移に連動する制御で、非同期Lambdaが
 * CopyObject で行う。Terraform のライフサイクルは「N日経過したら」という時間ベースの
 * ため、まだ最新の文書が Glacier に落ちる。
 *
 * **バージョニングも有効にしない。**
 * 同一キーへの CopyObject でクラスだけ変える運用なので、クラス変更のたびに
 * バージョンが増えてコストが読めなくなる。
 */

# --- ファイル用 -------------------------------------------------------------

resource "aws_s3_bucket" "files" {
  bucket = "q-documents-files-${random_id.suffix.hex}"
}

resource "aws_s3_bucket_public_access_block" "files" {
  bucket = aws_s3_bucket.files.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

/**
 * 保管時の暗号化は SSE-S3（AES256）。KMS の CMK は使わない。
 * CMK は1本あたり月 $1 かかり、月1,000円の要件の15%を占める。
 * 保管時の暗号化という目的は SSE-S3 で満たせて、こちらは追加費用がない。
 *
 * bucket_key_enabled は指定しない。あれは KMS へのリクエスト数を減らす設定で、
 * KMS を呼ばない SSE-S3 では効果がない。
 */
resource "aws_s3_bucket_server_side_encryption_configuration" "files" {
  bucket = aws_s3_bucket.files.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

# --- 画面用 -----------------------------------------------------------------

resource "aws_s3_bucket" "frontend" {
  bucket = "q-documents-frontend-${random_id.suffix.hex}"
}

resource "aws_s3_bucket_public_access_block" "frontend" {
  bucket = aws_s3_bucket.frontend.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "frontend" {
  bucket = aws_s3_bucket.frontend.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}
