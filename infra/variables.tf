variable "region" {
  description = "AWS region for all resources"
  type        = string
  default     = "ap-northeast-1"
}

/**
 * 画面・API へのアクセスを許可するグローバルIPのリスト（CIDR 表記）。
 *
 * public リポジトリのため、値はコードに書かず terraform.tfvars から渡す
 * （*.tfvars は .gitignore 済み。CLAUDE.md §8-2）。default を置かないのは、
 * 未設定のまま apply して「全開放」になる事故を防ぐため。
 *
 * このリストは2か所で使う。守る対象が別なので、片方だけでは要件を満たさない。
 *   画面 — CloudFront Functions（cloudfront.tf）
 *   API  — API Gateway のリソースポリシー（apigateway.tf）
 *
 * 社内IPで運用するときは、この変数の値を差し替えて apply するだけでよい
 * （docs/ip-restriction-verification.md「社内IPの扱いについて」）。
 *
 * sensitive = true は plan / apply の**出力**を伏せるためのもの。
 * この値は CloudFront Function のコードと API Gateway のリソースポリシーに埋め込まれ、
 * そこから plan の差分に出る。出力を PR や Issue に貼った瞬間に公開されるため、
 * 表示の側で塞いでおく。
 *
 * **state に平文で残ることは防げない**（sensitive は表示の制御であって暗号化ではない）。
 * state バケットは非公開・BPA 全項目 true で、そこは CLAUDE.md §8-2 の許容範囲。
 */
variable "allowed_cidrs" {
  description = "Global IP ranges (CIDR) allowed to reach the SPA and the API"
  type        = list(string)
  sensitive   = true

  validation {
    condition = alltrue([
      for cidr in var.allowed_cidrs : can(cidrnetmask(cidr))
    ])
    error_message = "allowed_cidrs must contain IPv4 CIDR blocks such as 203.0.113.0/24."
  }

  validation {
    condition     = length(var.allowed_cidrs) > 0
    error_message = "allowed_cidrs must not be empty (an empty list would block everyone)."
  }
}

/**
 * AWS Budgets の通知先。
 * public リポジトリにメールアドレスを載せられないため、terraform.tfvars から渡す
 * （*.tfvars は .gitignore 済み）。default を置かず、未設定なら plan で止まるようにする。
 */
variable "budget_notification_email" {
  description = "Email address that receives AWS Budgets alerts"
  type        = string

  validation {
    condition     = can(regex("^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$", var.budget_notification_email))
    error_message = "budget_notification_email must be a valid email address."
  }
}

/**
 * 月額の上限。要件は「月1,000円以内」（docs/要件定義書.md）。
 * AWS Budgets の通貨はアカウントの請求通貨に従うため、USD で持つ。
 * 1,000円 ≒ 6 USD（1USD=160円で換算）。為替が動いたら調整する。
 */
variable "monthly_budget_usd" {
  description = "Monthly cost budget in USD (JPY 1,000 is roughly USD 6)"
  type        = number
  default     = 6
}
