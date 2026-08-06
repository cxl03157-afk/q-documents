/**
 * 合言葉（F-18）を置く SSM Parameter Store のパラメータ。
 *
 * **値は Terraform で管理しない。**
 * variable 経由でも tfvars 経由でも、Terraform に渡した値は state に平文で残る。
 * state は S3 にあり暗号化もされているが、「コード・Terraform state・リポジトリに
 * 平文で置かない」という不変条件（CLAUDE.md §8-1）に反する。
 *
 * そこで入れ物だけ作り、実際の値は AWS CLI で後から入れる:
 *
 *   aws ssm put-parameter --name /q-documents/passphrase \
 *     --type SecureString --value '<合言葉>' --overwrite
 *
 * ignore_changes で value を無視するため、CLI で入れた値を terraform apply が
 * プレースホルダに戻すことはない。
 */
resource "aws_ssm_parameter" "passphrase" {
  name        = "/q-documents/passphrase"
  description = "Shared passphrase for the production engineering mode (F-18)"
  type        = "SecureString"

  # 作成時に必須なので置く。実値は AWS CLI で上書きする
  value = "PLACEHOLDER_SET_VIA_CLI"

  lifecycle {
    ignore_changes = [value]
  }
}
