/**
 * 後続で使う値。
 *
 * 8/7 の公開層（CloudFront・API Gateway・Lambda）と、
 * scripts/ のデプロイスクリプトが参照する。
 */

output "files_bucket_name" {
  description = "S3 bucket that stores PDF and Excel files"
  value       = aws_s3_bucket.files.id
}

output "frontend_bucket_name" {
  description = "S3 bucket that serves the SPA (deploy target of scripts/deploy-frontend.sh)"
  value       = aws_s3_bucket.frontend.id
}

output "ledger_table_name" {
  description = "DynamoDB table for the document ledger"
  value       = aws_dynamodb_table.ledger.name
}

output "masters_table_name" {
  description = "DynamoDB table for the selection masters"
  value       = aws_dynamodb_table.masters.name
}

output "api_role_arn" {
  description = "IAM role for the synchronous API Lambda"
  value       = aws_iam_role.api.arn
}

output "async_role_arn" {
  description = "IAM role for the asynchronous (S3 event) Lambda"
  value       = aws_iam_role.async.arn
}

output "cloudfront_domain_name" {
  description = "Domain name of the SPA distribution (open this in a browser)"
  value       = aws_cloudfront_distribution.frontend.domain_name
}

output "cloudfront_distribution_id" {
  description = "Distribution ID used by scripts/deploy-frontend.sh for cache invalidation"
  value       = aws_cloudfront_distribution.frontend.id
}

output "api_invoke_url" {
  description = "Base URL of the API (set as VITE_API_BASE_URL in the frontend)"
  value       = aws_api_gateway_stage.prod.invoke_url
}

output "passphrase_parameter_name" {
  description = "SSM parameter that holds the passphrase (value is set via AWS CLI, not Terraform)"
  value       = aws_ssm_parameter.passphrase.name
}
