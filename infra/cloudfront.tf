/**
 * 画面の配信（CloudFront + OAC + Functions）。
 *
 * S3 の静的ウェブサイトホスティングは HTTPS に対応しないため、要件 §5.1-① を
 * 満たすには CloudFront が要る（docs/tech-stack.md）。
 * S3 は Block Public Access のままにして、OAC 経由の読み取りだけを許可する。
 *
 * **us-east-1 のプロバイダは要らない。**
 * us-east-1 が必須になるのは ACM 証明書（独自ドメイン）と Lambda@Edge で、
 * どちらも使わない。CloudFront Functions はリージョンを持たず、
 * デフォルト証明書（*.cloudfront.net）も証明書リソースを作らない。
 *
 * **アクセスログは有効にしない。** ログ用のバケットと保管費用が増える一方、
 * 要件が求める記録（エクセル・旧版の取得者）は Lambda が CloudWatch Logs に書く
 * （CLAUDE.md §8-7）。誰が画面を開いたかの記録は要件にない。
 */

# --- OAC（S3 へのアクセス経路） ---------------------------------------------

/**
 * Origin Access Control。CloudFront が S3 を読むときに SigV4 で署名する。
 * 旧方式の OAI ではなく OAC を使うのは、OAI が新規利用非推奨で、
 * SSE-KMS や POST に対応しないため（今回は SSE-S3 だが、経路は新しい方に寄せる）。
 */
resource "aws_cloudfront_origin_access_control" "frontend" {
  name                              = "q-documents-frontend-oac"
  description                       = "OAC for the q-documents SPA bucket"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

# --- IP制限の関数 -----------------------------------------------------------

/**
 * 許可CIDRは templatefile で関数のコードに埋め込む。
 * 変数の値が変わると code が変わり、Terraform が新しいバージョンを発行する。
 *
 * publish = true にしないと LIVE に上がらず、関連付けても効かない
 * （検証時に「保存しただけでは効かない」ことを実測している。申し送り7）。
 */
resource "aws_cloudfront_function" "ip_allowlist" {
  name    = "q-documents-ip-allowlist"
  runtime = "cloudfront-js-2.0"
  comment = "Allow only the office global IP ranges to reach the SPA"
  publish = true

  code = templatefile("${path.module}/functions/ip-allowlist.js.tftpl", {
    allowed_cidrs_json = jsonencode(var.allowed_cidrs)
  })
}

# --- ディストリビューション --------------------------------------------------

/**
 * AWS 管理のキャッシュポリシー。自前で作らないのは、
 * 「静的ファイルを普通にキャッシュする」以上の要件がないため。
 */
data "aws_cloudfront_cache_policy" "caching_optimized" {
  name = "Managed-CachingOptimized"
}

resource "aws_cloudfront_distribution" "frontend" {
  enabled             = true
  comment             = "q-documents SPA"
  default_root_object = "index.html"

  /**
   * **必ず false にする。**（申し送り1）
   * 既定の IPv6 有効のままだと event.viewer.ip に IPv6 が入り、
   * IPv4 の許可リストが一致しなくなる。IPv6 で接続できる利用者だけが
   * 403 になるという、原因の見えにくい形で出る。
   */
  is_ipv6_enabled = false

  /**
   * 日本を含む最小の価格クラス。PriceClass_100 は北米・欧州・イスラエルのみで
   * 日本が入らない。利用者は社内からのみなので、全世界に配る PriceClass_All は要らない。
   */
  price_class = "PriceClass_200"

  origin {
    domain_name              = aws_s3_bucket.frontend.bucket_regional_domain_name
    origin_id                = "frontend-s3"
    origin_access_control_id = aws_cloudfront_origin_access_control.frontend.id
  }

  default_cache_behavior {
    target_origin_id = "frontend-s3"

    # 受け入れ基準「HTTPでアクセスするとHTTPSにリダイレクトまたは拒否される」
    viewer_protocol_policy = "redirect-to-https"

    # 画面は静的ファイルの取得だけ。書き込み系のメソッドは通さない
    allowed_methods = ["GET", "HEAD"]
    cached_methods  = ["GET", "HEAD"]

    cache_policy_id = data.aws_cloudfront_cache_policy.caching_optimized.id

    function_association {
      event_type   = "viewer-request"
      function_arn = aws_cloudfront_function.ip_allowlist.arn
    }
  }

  /**
   * 地理的な制限はかけない。IP の許可リストで足りており、
   * 国単位の制限を重ねても守れる範囲は増えない。
   */
  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  /**
   * 独自ドメインを持たないため *.cloudfront.net のデフォルト証明書を使う。
   *
   * このとき minimum_protocol_version は選べず、TLSv1 に固定される
   * （デフォルト証明書ではこの値以外を CloudFront が受け付けない）。
   * 申し送り6「TLS 1.2 以上を選ぶ」は、独自ドメイン + ACM 証明書の構成でのみ選べる項目。
   *
   * **ただし TLSv1 は設定上のラベルであって、実際に成立する下限とは別。**
   * 何で接続できるかは apply 後に openssl s_client で実測し、
   * docs/ip-restriction-verification.md に記録する。
   *
   * API Gateway 側は事情が異なる。あちらは値が固定されるのではなく
   * **設定項目そのものが無い**（security_policy は aws_api_gateway_domain_name の属性で、
   * 既定の execute-api エンドポイントには存在しない）。同じく実測で確かめる。
   */
  viewer_certificate {
    cloudfront_default_certificate = true
  }
}

# --- 画面用バケットのポリシー ------------------------------------------------

/**
 * OAC からの読み取りだけを許可する。
 *
 * s3.tf ではなくここに置いているのは、条件にディストリビューションの ARN が要るため。
 * バケット側ではなく「誰が読めるか」を決める側に置いたほうが、経路が1か所で読める。
 *
 * SourceArn で自分のディストリビューションに限定する。これがないと、
 * 別のアカウントの CloudFront からも読めてしまう（混乱した代理人問題）。
 */
data "aws_iam_policy_document" "frontend_bucket" {
  statement {
    sid       = "AllowCloudFrontServicePrincipalReadOnly"
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.frontend.arn}/*"]

    principals {
      type        = "Service"
      identifiers = ["cloudfront.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "AWS:SourceArn"
      values   = [aws_cloudfront_distribution.frontend.arn]
    }
  }
}

resource "aws_s3_bucket_policy" "frontend" {
  bucket = aws_s3_bucket.frontend.id
  policy = data.aws_iam_policy_document.frontend_bucket.json
}
