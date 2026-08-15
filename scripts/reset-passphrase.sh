#!/usr/bin/env bash
#
# 合言葉をリセットする（F-20 の復旧手段）。
#
#   ./scripts/reset-passphrase.sh
#
# 画面（S-8）から合言葉を変更できるが、**打ち間違いや意図しない変更で誰も解除できなく
# なった場合の戻し方が、画面の中には存在しない**。合言葉を知らないと画面の変更機能も
# 使えないため。
#
# **リセットをアプリの中に置くことはできない。** 合言葉を要求すれば締め出された状況では
# 使えず、要求しなければ社内IPの内側にいる誰でも合言葉を変えられてしまい、F-18 の前提が
# 崩れる。したがってこれは「AWS の資格情報を持つ人の操作」であり、それが正しい置き場所。
#
# 手順書に書くよりスクリプトにしたほうが守られる（CLAUDE.md §10）。
#
# **値は Terraform にも state にも渡さない**（CLAUDE.md §8-1）。SSM へ直接書き込む。
# 引数でも受け取らない — シェルの履歴に残るため、実行時に伏字で入力させる。
# （書き込みの一瞬だけ aws コマンドの引数として現れるので、共用マシンでは `ps` から
#  見えうる。開発者個人のマシンで実行する前提の運用とし、値をファイルに落とすより
#  こちらを選んだ。infra/ssm.tf に書いてある手作業の手順と同じ扱い）

set -euo pipefail

PASSPHRASE_PARAM="/q-documents/passphrase"
TOKEN_SECRET_PARAM="/q-documents/token-secret"

# shared/passphrasePolicy.ts と同じ要件。画面から変更したものと、ここで戻したものとで
# 通る値が違うと運用が混乱する
MIN_LENGTH=8
MAX_LENGTH=20

# --- 1. どこへ書こうとしているのかを見せて確認する ---------------------------
#
# **これを飛ばさない。** aws CLI は複数のアカウント・リージョンを切り替えて使うため、
# プロファイルの選び違いに気づかないまま別環境のパラメータを壊しうる。
# 復旧のための操作で別のものを壊すのがいちばん避けたい失敗。

echo "==> 書き込み先の確認"

IDENTITY_JSON="$(aws sts get-caller-identity --output json)"
ACCOUNT_ID="$(printf '%s' "${IDENTITY_JSON}" | jq -r '.Account')"
CALLER_ARN="$(printf '%s' "${IDENTITY_JSON}" | jq -r '.Arn')"

REGION="${AWS_REGION:-${AWS_DEFAULT_REGION:-$(aws configure get region 2>/dev/null || true)}}"
if [ -z "${REGION}" ]; then
  echo "エラー: リージョンが決まらない。AWS_REGION を設定するか aws configure で既定を入れること" >&2
  exit 1
fi

# 値は復号しない（describe-parameters は値を返さない）。版と更新日時だけを見せる
parameter_summary() {
  aws ssm describe-parameters \
    --region "${REGION}" \
    --parameter-filters "Key=Name,Option=Equals,Values=$1" \
    --query 'Parameters[0].[Version,LastModifiedDate]' \
    --output text 2>/dev/null || echo "取得できず"
}

echo "    アカウント    : ${ACCOUNT_ID}"
echo "    実行者        : ${CALLER_ARN}"
echo "    リージョン    : ${REGION}"
echo "    合言葉        : ${PASSPHRASE_PARAM}（版・更新日時: $(parameter_summary "${PASSPHRASE_PARAM}")）"
echo "    署名鍵        : ${TOKEN_SECRET_PARAM}（版・更新日時: $(parameter_summary "${TOKEN_SECRET_PARAM}")）"
echo

read -r -p "このアカウント・リージョンの上記パラメータを書き換えます。続けますか? [y/N] " answer
if [ "${answer}" != "y" ] && [ "${answer}" != "Y" ]; then
  echo "中止した"
  exit 0
fi

# --- 2. 新しい合言葉の入力 ---------------------------------------------------
#
# **2回入力させる。** 打ち間違えたまま書き込むと、次に入力するときに再現できず
# 誰も解除できなくなる。それはこのスクリプトが直そうとしている状況そのもの。

read -r -s -p "新しい合言葉: " NEW_PASSPHRASE
echo
read -r -s -p "新しい合言葉（確認）: " NEW_PASSPHRASE_CONFIRM
echo

if [ "${NEW_PASSPHRASE}" != "${NEW_PASSPHRASE_CONFIRM}" ]; then
  echo "エラー: 2つの入力が一致しない" >&2
  exit 1
fi
unset NEW_PASSPHRASE_CONFIRM

# 要件の確認（shared/passphrasePolicy.ts と同じ）。
# **値は標準入力で渡す** — 引数にすると ps から見えるため。
# 文字数はコードポイントで数える（`wc -m` はロケール依存で、絵文字の扱いもずれる）
if ! printf '%s' "${NEW_PASSPHRASE}" | python3 -c "
import sys
value = sys.stdin.read()
length = len(value)
if length < ${MIN_LENGTH} or length > ${MAX_LENGTH}:
    sys.exit('エラー: 合言葉は${MIN_LENGTH}〜${MAX_LENGTH}文字にすること（いまは%d文字）' % length)
if value != value.strip():
    sys.exit('エラー: 前後に空白を含めないこと（見えない文字が入ると再現できず、誰も解除できなくなる）')
"; then
  exit 1
fi

# --- 3. 署名鍵も更新するか --------------------------------------------------
#
# 目的によって答えが変わるので既定を置かずに尋ねる。
#   更新する   — 解除中の端末をすべて切る。誰かに変えられた場合の復旧はこちら
#   更新しない — 解除中の端末はそのまま。自分の打ち間違いを戻すだけならこちら

read -r -p "署名鍵も更新して、解除中の端末をすべて終了させますか? [Y/n] " rotate_answer
ROTATE_SECRET=true
if [ "${rotate_answer}" = "n" ] || [ "${rotate_answer}" = "N" ]; then
  ROTATE_SECRET=false
fi

# --- 4. 書き込み -------------------------------------------------------------
#
# **合言葉を先に書く。** アプリ側（changePassphrase.ts）は署名鍵を先に書くが、
# あちらの目的は「部分的に失敗しても『合言葉は元のまま』と言い切れること」。
# こちらの目的は**まず入れるようにすること**なので、順序が逆になる。
# 合言葉さえ戻れば、署名鍵の更新に失敗しても解除はできる。

echo "==> ${PASSPHRASE_PARAM} を更新"
aws ssm put-parameter \
  --region "${REGION}" \
  --name "${PASSPHRASE_PARAM}" \
  --type SecureString \
  --value "${NEW_PASSPHRASE}" \
  --overwrite \
  --output text --query Version >/dev/null
unset NEW_PASSPHRASE
echo "    完了"

if [ "${ROTATE_SECRET}" = true ]; then
  echo "==> ${TOKEN_SECRET_PARAM} を更新"
  aws ssm put-parameter \
    --region "${REGION}" \
    --name "${TOKEN_SECRET_PARAM}" \
    --type SecureString \
    --value "$(openssl rand -base64 32)" \
    --overwrite \
    --output text --query Version >/dev/null
  echo "    完了（解除中の端末はすべて終了する）"
fi

# --- 5. 反映を待つ -----------------------------------------------------------
#
# Lambda の実行環境は SSM の値を5分間キャッシュする（backend/src/auth/secrets.ts）。
# **待つのが通常の手順。** リクエストのたびに SSM を読むとレート上限に先に当たるため、
# キャッシュ自体は必要な仕組みで、待ち時間はその代償として受け入れている。

cat <<'EOS'

==> 反映について

  新しい合言葉が全体に行き渡るまで最大5分かかります。それまでの間は、
  古い合言葉でも解除できることがあります（実行環境ごとに切り替わるため）。

  5分待ってから、画面で新しい合言葉での解除を確認してください。

EOS
