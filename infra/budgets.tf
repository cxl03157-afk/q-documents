/**
 * 月額の予算アラート。要件は「月1,000円以内」（docs/要件定義書.md §7）。
 *
 * 通知は2段階にする。
 *   実績80%   — 使いすぎに気づく。まだ止められる
 *   予測100%  — このペースだと超える、という予告
 *
 * 実績100%だけにすると、超えたことを超えてから知ることになる。
 */
resource "aws_budgets_budget" "monthly" {
  name         = "q-documents-monthly"
  budget_type  = "COST"
  limit_amount = var.monthly_budget_usd
  limit_unit   = "USD"
  time_unit    = "MONTHLY"

  # このプロジェクトのタグが付いたリソースだけを数える。
  # 同じアカウントで他のものを動かしても混ざらない
  cost_filter {
    name   = "TagKeyValue"
    values = ["user:Project$q-documents"]
  }

  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 80
    threshold_type             = "PERCENTAGE"
    notification_type          = "ACTUAL"
    subscriber_email_addresses = [var.budget_notification_email]
  }

  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 100
    threshold_type             = "PERCENTAGE"
    notification_type          = "FORECASTED"
    subscriber_email_addresses = [var.budget_notification_email]
  }
}
