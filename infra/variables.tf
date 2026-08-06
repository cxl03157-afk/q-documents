variable "region" {
  description = "AWS region for all resources"
  type        = string
  default     = "ap-northeast-1"
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
