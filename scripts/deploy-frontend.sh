#!/usr/bin/env bash
#
# 画面を S3 へ配置し、CloudFront のキャッシュを削除する。
#
#   ./scripts/deploy-frontend.sh
#
# 手順書に書くよりスクリプトにしたほうが守られる（CLAUDE.md §10）。
# バケット名とディストリビューションIDは Terraform の出力から取る。控えを持たない。

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INFRA_DIR="${REPO_ROOT}/infra"
DIST_DIR="${REPO_ROOT}/frontend/dist"

# --- 1. 配置先と API のURLを Terraform から取る -------------------------------

echo "==> 配置先の確認"
BUCKET="$(terraform -chdir="${INFRA_DIR}" output -raw frontend_bucket_name)"
DISTRIBUTION_ID="$(terraform -chdir="${INFRA_DIR}" output -raw cloudfront_distribution_id)"
DOMAIN="$(terraform -chdir="${INFRA_DIR}" output -raw cloudfront_domain_name)"
API_BASE_URL="$(terraform -chdir="${INFRA_DIR}" output -raw api_invoke_url)"

echo "    バケット      : ${BUCKET}"
echo "    ディストリビュー: ${DISTRIBUTION_ID}"
echo "    API           : ${API_BASE_URL}"

# --- 2. ビルド --------------------------------------------------------------
#
# lint / test だけでは型エラーを検出できない（CLAUDE.md §10）。
# デプロイの直前に必ずビルドを通す。
#
# **VITE_API_BASE_URL はビルド時に画面へ埋め込まれる。**
# 個人の .env.local に頼ると、値が手元にしか無く、間違った API を指したまま
# デプロイしても気づけない。バケット名やディストリビューションIDと同じく
# Terraform の出力を正とする（控えを持たない）。
# .env.local はローカル開発（npm run dev）用に残す。

echo "==> ビルド"
(cd "${REPO_ROOT}/frontend" && VITE_API_BASE_URL="${API_BASE_URL}" npm run build)

if [ ! -f "${DIST_DIR}/index.html" ]; then
  echo "エラー: ${DIST_DIR}/index.html がない。ビルドに失敗している" >&2
  exit 1
fi

# --- 3. dryrun で差分を見せる ------------------------------------------------
#
# 本実行の前に必ず --dryrun で確認する（CLAUDE.md §10）。
#
# --delete は使わない。ハッシュ付きのアセットを消すと、
# 画面を開いたままの利用者が次の遷移で 404 を踏む。
# 残っても数十KBなので、増えすぎたときに手で消せばよい。

#
# 1年キャッシュにしてよいのは assets/ だけ。
# **ファイル名にビルドのハッシュが入るものに限る。**
# public/ 由来の favicon.svg や icons.svg はハッシュが付かないため、
# immutable にすると差し替えても既訪問者に最大1年届かない。
# create-invalidation は CloudFront のキャッシュを消すだけで、ブラウザには効かない。

echo "==> dryrun（assets/ = ハッシュ付き・1年キャッシュ）"
aws s3 sync "${DIST_DIR}/assets" "s3://${BUCKET}/assets" \
  --cache-control "public, max-age=31536000, immutable" \
  --dryrun

echo "==> dryrun（その他 = index.html・favicon など・no-cache）"
aws s3 sync "${DIST_DIR}" "s3://${BUCKET}" \
  --exclude "assets/*" \
  --cache-control "no-cache" \
  --dryrun

read -r -p "上記の内容で本実行しますか? [y/N] " answer
if [ "${answer}" != "y" ] && [ "${answer}" != "Y" ]; then
  echo "中止した"
  exit 0
fi

# --- 4. 本実行 --------------------------------------------------------------
#
# assets/ を先、index.html を含む残りを後に置く。
# 逆順だと、新しい index.html がまだ存在しないアセットを参照する瞬間ができる。

echo "==> アップロード（assets/）"
aws s3 sync "${DIST_DIR}/assets" "s3://${BUCKET}/assets" \
  --cache-control "public, max-age=31536000, immutable"

echo "==> アップロード（その他）"
aws s3 sync "${DIST_DIR}" "s3://${BUCKET}" \
  --exclude "assets/*" \
  --cache-control "no-cache"

# --- 5. キャッシュ削除 --------------------------------------------------------

echo "==> CloudFront のキャッシュ削除"
INVALIDATION_ID="$(aws cloudfront create-invalidation \
  --distribution-id "${DISTRIBUTION_ID}" \
  --paths "/*" \
  --query 'Invalidation.Id' --output text)"

echo "    invalidation: ${INVALIDATION_ID}（反映まで1〜3分）"
echo
echo "完了: https://${DOMAIN}/"
