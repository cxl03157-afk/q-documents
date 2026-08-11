/**
 * S3 バケット2本。
 *
 * files    — PDF・エクセルの実体
 * frontend — 画面の静的ファイル
 *
 * どちらも Block Public Access を全項目 true にし、直接アクセスさせない（CLAUDE.md §8-5）。
 *
 * **バケットポリシー（OAC からの読み取り許可）はここに書かない。**
 * CloudFront ディストリビューションの ARN を条件に入れる必要があるため、
 * ディストリビューションと同じ cloudfront.tf に置いている。
 * **S3 通知（非同期Lambdaの起動）も同じ理由で lambda.tf に置いている。**
 *
 * **ライフサイクルルールも書かない。**
 * ストレージクラスの割り当て（CLAUDE.md §6）は状態に連動する制御で、
 * 「旧版になったら Glacier IR」は非同期Lambdaが CopyObject で行い、
 * 「エクセルは Standard-IA」はアップロード時の署名条件で決まる。
 * Terraform のライフサイクルは「N日経過したら」という時間ベースのため、
 * まだ最新の文書が Glacier に落ちる。
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

/**
 * CORS。署名付きURLでブラウザから S3 へ直接 PUT・GET するために要る。
 *
 * 許可するのは画面のオリジン（CloudFront のドメイン）だけで、ワイルドカードは使わない
 * （docs/API.md §補足：セキュリティ）。
 *
 * CORS はブラウザ側の制約であって、アクセス制御ではない。
 * 実際に S3 への操作を許しているのは署名付きURLで、その有効期限は15分以内、
 * アップロード用は Content-Type とサイズ上限を署名条件に含める（CLAUDE.md §8-3・8-4）。
 *
 * ExposeHeaders に ETag を入れているのは、PUT の完了確認にブラウザから読めるようにするため。
 */
resource "aws_s3_bucket_cors_configuration" "files" {
  bucket = aws_s3_bucket.files.id

  /**
   * アップロードは **presigned POST**（8/10 に確定）。
   * CLAUDE.md §8-4 の `content-length-range`（サイズ上限の強制）は
   * presigned POST のポリシーでしか表現できず、presigned PUT には手段がない。
   * PUT も残してあるが、現時点で使っている経路は無い。
   */
  cors_rule {
    allowed_origins = ["https://${aws_cloudfront_distribution.frontend.domain_name}"]
    allowed_methods = ["GET", "PUT", "POST", "HEAD"]
    allowed_headers = ["*"]
    expose_headers  = ["ETag"]
    max_age_seconds = 3000
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
