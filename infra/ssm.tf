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

/**
 * 合言葉トークンの署名鍵（F-18）。
 *
 * **合言葉とは別の値にする。** 合言葉をそのまま署名鍵に使うと、合言葉を変えた瞬間に
 * 解除中のセッションが全部無効になり、作業の途中で突然ロックされる。
 * 分けておけば、合言葉の差し替えとセッションの継続が互いに影響しない。
 *
 * 人が覚える必要はないのでランダムでよい。合言葉と同じく値は CLI で入れる:
 *
 *   aws ssm put-parameter --name /q-documents/token-secret \
 *     --type SecureString --value "$(openssl rand -base64 32)" --overwrite
 *
 * この鍵を変えると、解除中のセッションはすべて切れて再解除が要る。
 * 個別のセッションだけを失効させる手段は無い（合言葉は役割単位の共有値で
 * 個人を認証しないため、個別失効に意味がない・docs/API.md）。
 */
resource "aws_ssm_parameter" "token_secret" {
  name        = "/q-documents/token-secret"
  description = "HMAC signing key for unlock tokens (F-18)"
  type        = "SecureString"

  value = "PLACEHOLDER_SET_VIA_CLI"

  lifecycle {
    ignore_changes = [value]
  }
}
