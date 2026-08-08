#!/usr/bin/env bash
#
# 選択肢マスタに初期データを入れる。
#
# 画面（frontend/src/mock/masters.ts）と同じ値を入れている。モックと実データがずれると、
# S-2 のプルダウンで選んだ氏名をサーバーが「存在しない」と判定して解除できなくなる。
#
# 冪等。同じキー（category + code）への put-item は上書きになるので、何度実行してもよい。
#
# マスタの CRUD は F-10（8/11 予定）で画面から行えるようにする。それまでの投入手段。
#
#   使い方:  ./scripts/seed-masters.sh
#
set -euo pipefail

TABLE="${MASTERS_TABLE:-q-documents-masters}"
REGISTERED_AT="2026-01-10"

export AWS_PAGER=""

put() {
  local category="$1" code="$2" name="$3"
  aws dynamodb put-item \
    --table-name "$TABLE" \
    --item "{
      \"category\":     {\"S\": \"${category}\"},
      \"code\":         {\"S\": \"${code}\"},
      \"name\":         {\"S\": \"${name}\"},
      \"status\":       {\"S\": \"有効\"},
      \"registeredAt\": {\"S\": \"${REGISTERED_AT}\"}
    }" >/dev/null
  echo "  ${category} / ${code} / ${name}"
}

echo "テーブル ${TABLE} に投入します"

# 担当者マスタ。登録するのは生産技術の担当者のみ（docs/DynamoDBテーブル設計.md）。
# 合言葉の解除（F-18）で氏名の照合に使う
echo "担当者:"
put "担当者" "E001" "山田太郎"
put "担当者" "E002" "佐藤花子"

echo "完了"
