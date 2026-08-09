/**
 * API の入口（API Gateway REST API + リソースポリシー）。
 *
 * HTTP API ではなく REST API を使うのは、**HTTP API がリソースポリシーに対応しない**ため。
 * 無料でIP制限を実現できる唯一の選択肢がこれだった（docs/tech-stack.md §不採用）。
 *
 * **画面と同じ CloudFront の後ろには置かない。**
 * CloudFront を挟むと API Gateway から見た送信元が CloudFront のIPになり、
 * リソースポリシーの aws:SourceIp が機能しなくなる。かといって関数側だけで守ると、
 * execute-api のURLを直接叩く経路が空いたままになる。
 * 入口ごとに、その入口で塞げる手段で塞ぐ（CLAUDE.md §7）。
 *
 * ブラウザからは別オリジンへのリクエストになるため、CORS は Lambda が応答ヘッダーで返す。
 */

resource "aws_api_gateway_rest_api" "api" {
  name        = "q-documents-api"
  description = "Synchronous API for q-documents (numbering, ledger, presigned URLs)"

  endpoint_configuration {
    /**
     * REGIONAL ＋ IPv4（申し送り2）。
     * edge-optimized は前段に CloudFront が入り、aws:SourceIp が何を指すかの
     * 切り分けが増える。デュアルスタックは IPv6 経路を開けてしまい、
     * IPv4 の許可リストをすり抜ける。
     */
    types           = ["REGIONAL"]
    ip_address_type = "ipv4"
  }
}

/**
 * IP制限のリソースポリシー。
 *
 * Allow（全体）＋ 条件付き Deny の2文構成にする。Allow だけを条件付きにすると、
 * 条件から外れたリクエストは「暗黙の拒否」で落ち、拒否の理由がレスポンスに出ない。
 * 明示的な Deny なら "with an explicit deny in a resource-based policy" が返り、
 * 切り分けができる（7/31 の検証で実測）。
 *
 * rest_api_id を参照するだけで循環しないのは、API 本体がこのポリシーを参照しないため。
 */
data "aws_iam_policy_document" "api_resource_policy" {
  statement {
    sid    = "AllowInvokeFromAnywhere"
    effect = "Allow"

    principals {
      type        = "AWS"
      identifiers = ["*"]
    }

    actions   = ["execute-api:Invoke"]
    resources = ["${aws_api_gateway_rest_api.api.execution_arn}/*"]
  }

  statement {
    sid    = "DenyInvokeOutsideAllowedCidrs"
    effect = "Deny"

    principals {
      type        = "AWS"
      identifiers = ["*"]
    }

    actions   = ["execute-api:Invoke"]
    resources = ["${aws_api_gateway_rest_api.api.execution_arn}/*"]

    condition {
      test     = "NotIpAddress"
      variable = "aws:SourceIp"
      values   = var.allowed_cidrs
    }
  }
}

/**
 * sensitive() で包む理由。
 *
 * var.allowed_cidrs に sensitive = true を付けても、**data ソースを経由すると
 * Terraform は sensitive のマークを引き継がない。**
 * 実際、包まずに apply したところ plan の差分に
 * ~ "aws:SourceIp" = "203.0.113.0/24" -> "<実IP>/32" と出た。
 * public リポジトリなので、この出力を PR や Issue に貼ると公開される。
 *
 * ここで付け直すと、差分は (sensitive value) になる。
 * templatefile() を通す CloudFront Function 側はマークが伝わるため、包む必要がない。
 */
resource "aws_api_gateway_rest_api_policy" "api" {
  rest_api_id = aws_api_gateway_rest_api.api.id
  policy      = sensitive(data.aws_iam_policy_document.api_resource_policy.json)
}

# --- ルーティング -----------------------------------------------------------

/**
 * ANY /{proxy+} の1本にまとめ、パスの振り分けは Lambda 側で行う。
 *
 * docs/API.md の12エンドポイントを個別のリソース・メソッド・統合として書くと
 * Terraform 側が40リソース近くになり、エンドポイントを1本足すたびに apply が要る。
 * 引き換えに「どのパスが実在するか」は Terraform を見ても分からない。
 * パスの正は docs/API.md（CLAUDE.md §2）。
 *
 * ルート（/）は {proxy+} に一致しないが、docs/API.md にルート直下の
 * エンドポイントはないため作らない。
 */
resource "aws_api_gateway_resource" "proxy" {
  rest_api_id = aws_api_gateway_rest_api.api.id
  parent_id   = aws_api_gateway_rest_api.api.root_resource_id
  path_part   = "{proxy+}"
}

/**
 * authorization = "NONE" は「誰でも通す」ではない。
 * 手前でリソースポリシーがIPを見ており、合言葉の検証は Lambda が行う（CLAUDE.md §7）。
 * IAM 認証は社内利用者に AWS 認証情報を配ることになるため使わない。
 */
resource "aws_api_gateway_method" "proxy_any" {
  rest_api_id   = aws_api_gateway_rest_api.api.id
  resource_id   = aws_api_gateway_resource.proxy.id
  http_method   = "ANY"
  authorization = "NONE"
}

/**
 * Lambda プロキシ統合。
 * integration_http_method が POST 固定なのは、クライアントのメソッドに関わらず
 * API Gateway が Lambda を呼ぶときは常に POST で Invoke API を叩くため。
 * リクエストの実際のメソッドは event.httpMethod に入って渡る。
 */
resource "aws_api_gateway_integration" "proxy_any" {
  rest_api_id = aws_api_gateway_rest_api.api.id
  resource_id = aws_api_gateway_resource.proxy.id
  http_method = aws_api_gateway_method.proxy_any.http_method

  type                    = "AWS_PROXY"
  integration_http_method = "POST"
  uri                     = aws_lambda_function.api.invoke_arn
}

# --- デプロイとステージ ------------------------------------------------------

/**
 * **REST API は「作った・変えた」だけでは反映されない。ステージへのデプロイが要る。**
 * リソースポリシーの変更も同じで、検証時に最も引っかかった点（申し送り7）。
 *
 * triggers に構成のハッシュを入れて、内容が変わったときだけ再デプロイさせる。
 * ここにリソースポリシーを含めているのは、許可IPを差し替えたときに
 * 再デプロイを忘れて「変えたのに効かない」状態になるのを防ぐため。
 *
 * **参照するのは data ソースの json であって、リソースの policy 属性ではない。**
 * 最初は aws_api_gateway_rest_api_policy.api.policy を参照して失敗した
 * （Provider produced inconsistent final plan）。
 * 同じ apply の中でそのポリシー自身が更新され、AWS が返す正規化後の JSON が
 * 設定に書いた文字列と一致しないため、plan 時のハッシュと apply 中のハッシュがずれる。
 * data ソースの値は plan 時に確定して apply 中に変わらないので、この問題が起きない。
 *
 * 参照先を変えると「ポリシー更新 → デプロイ」の順序の保証が消えるため、
 * depends_on で明示する。順序が逆だと、更新前のポリシーをデプロイして
 * 「変えたのに効かない」状態が残る。
 *
 * create_before_destroy は、新しいデプロイを作ってから古いものを消すため。
 * 逆順だと、入れ替えの一瞬だけステージがデプロイを失って 500 を返す。
 */
resource "aws_api_gateway_deployment" "api" {
  rest_api_id = aws_api_gateway_rest_api.api.id

  triggers = {
    redeployment = sha1(jsonencode([
      aws_api_gateway_resource.proxy.id,
      aws_api_gateway_method.proxy_any.id,
      aws_api_gateway_integration.proxy_any.id,
      data.aws_iam_policy_document.api_resource_policy.json,
    ]))
  }

  depends_on = [aws_api_gateway_rest_api_policy.api]

  lifecycle {
    create_before_destroy = true
  }
}

/**
 * ステージ名は URL に入る（https://<id>.execute-api.<region>.amazonaws.com/prod/...）。
 * 環境は1つしかないので、環境名で分けるつもりはない。
 *
 * アクセスログは出さない。API Gateway の実行ログにはアカウント単位の
 * CloudWatch ロール設定が要り、リージョン内の他の API にも影響する。
 * 要件が求める記録（誰がエクセル・旧版を取得したか）は Lambda 側で書く（CLAUDE.md §8-7）。
 */
resource "aws_api_gateway_stage" "prod" {
  rest_api_id   = aws_api_gateway_rest_api.api.id
  deployment_id = aws_api_gateway_deployment.api.id
  stage_name    = "prod"
}

/**
 * スロットリング。
 *
 * **これは総当たり対策ではない。** 合言葉は役割単位の共有値なので理屈上は総当たりが効くが、
 * API Gateway のリソースポリシーで社内IPからしか到達できない以上、到達できる相手が
 * そもそも限られている。実効的な防御はIP制限のほうで、ここで秒あたりを数十絞っても差は小さい。
 *
 * **付ける目的は、最悪ケースの桁を下げること。** 未設定だとアカウント既定の 10,000 req/s が
 * 上限になり、画面側のループ不具合や連打で理論上1日 $3,000 規模の請求が立つ。
 * 50 req/s なら同じ状況で $15 程度に収まる。コスト要件（月1,000円）を守っているのは
 * 予算アラート（budgets.tf・6 USD）のほうで、ここはその手前の歯止めにすぎない。
 *
 * **パスごとには絞れない。** `ANY /{proxy+}` の1本構成なので、この API に存在する
 * メソッドは1つだけ。method_path を指定しても対象は同じになる。
 * /auth/unlock だけを絞りたくなったら、置き場所は API Gateway ではなく
 * Lambda + DynamoDB のカウンタになる（状態が要る）。
 *
 * burst を 200 にしているのは、一覧のまとめてダウンロード（上限50件・F-11）が
 * 署名付きURLの発行を最大50件まとめて呼ぶため。50 にすると
 * **正常な操作がちょうどバケットを空にし、同時に走る他の要求が 429 で落ちる。**
 * スロットリングはクライアント単位ではなく API 全体で共有されるので、
 * 同じ社内IPの背後にいる他の利用者も巻き込む。4倍の余裕を持たせた。
 */
resource "aws_api_gateway_method_settings" "prod" {
  rest_api_id = aws_api_gateway_rest_api.api.id
  stage_name  = aws_api_gateway_stage.prod.stage_name
  method_path = "*/*"

  settings {
    throttling_rate_limit  = 50
    throttling_burst_limit = 200
  }
}
