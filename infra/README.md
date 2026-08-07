# infra

Q-documents の AWS インフラ（Terraform）。

**構成はルートモジュール1つ・state 1本。** 環境が1つ・リージョンが1つ・開発者が1人で
再利用の機会がないため、モジュール化はしない。ファイルはリソース種別で分ける。

| ファイル | 内容 |
| --- | --- |
| `main.tf` | プロバイダ・backend・共通タグ・バケット名の suffix |
| `variables.tf` | 変数定義 |
| `s3.tf` | ファイル用／画面用のバケット・CORS |
| `dynamodb.tf` | 文書台帳・選択肢マスタ |
| `iam.tf` | 同期API用／非同期Lambda用の実行ロール |
| `ssm.tf` | 合言葉のパラメータ（入れ物だけ） |
| `budgets.tf` | 月額の予算アラート |
| `cloudfront.tf` | 画面の配信（OAC・ディストリビューション・IP制限の関数・画面バケットのポリシー） |
| `functions/ip-allowlist.js.tftpl` | CloudFront Functions のコード（許可CIDRを埋め込むテンプレート） |
| `apigateway.tf` | REST API・リソースポリシー・`ANY /{proxy+}`・ステージ |
| `lambda.tf` | 同期API の Lambda・ロググループ・API Gateway からの invoke 許可 |
| `outputs.tf` | デプロイスクリプトと画面が使う値 |

---

## 初回セットアップ

### 1. state 用バケットを作る（Terraform より先に）

state を置くバケットは Terraform では作れない（作る対象が state の置き場所になるため）。
AWS CLI で先に作る。**この手順は初回の1回だけ。**

```bash
BUCKET="q-documents-tfstate-$(openssl rand -hex 4)"   # 生成された名前を控える

aws s3api create-bucket --bucket "$BUCKET" --region ap-northeast-1 \
  --create-bucket-configuration LocationConstraint=ap-northeast-1

# state を壊したときに戻せるようにする。state バケットでは必須
aws s3api put-bucket-versioning --bucket "$BUCKET" \
  --versioning-configuration Status=Enabled

aws s3api put-public-access-block --bucket "$BUCKET" \
  --public-access-block-configuration \
  BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true

aws s3api put-bucket-encryption --bucket "$BUCKET" \
  --server-side-encryption-configuration \
  '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"}}]}'
```

バケット名にランダムな suffix を付けるのは、S3 のバケット名が全世界で一意である一方、
アカウントIDを名前に含めると public リポジトリに載ってしまうため。

### 2. 変数ファイルを用意する

```bash
cp terraform.tfvars.example terraform.tfvars
```

`terraform.tfvars` を開いて2つとも記入する。

| 変数 | 値 |
| --- | --- |
| `allowed_cidrs` | **画面・API へのアクセスを許可するグローバルIP。** 自分のIPは `curl -s https://checkip.amazonaws.com` で確認できる（単一なら `"x.x.x.x/32"`）。社内で運用するときは社内のレンジに差し替える |
| `budget_notification_email` | AWS Budgets のアラート送り先 |

> **`allowed_cidrs` を例のまま apply しないこと。**
> 例に入れてある `203.0.113.0/24` は RFC 5737 のドキュメント用アドレスで、実在の通信には使われない。
> **書き換えないと apply は成功したまま、画面もAPIも自分自身が 403 になる。**
> しかもこの変数は `sensitive` なので plan の差分に値が出ず、原因が見えにくい。
>
> **家庭用回線のグローバルIPは変わり得る。** デモや動作確認の前に必ず上記のコマンドで確認する
> （`docs/ip-restriction-verification.md`）。変わっていたら書き換えて apply（数分）。

### 3. init

バケット名は `backend "s3" {}` に直書きせず、`-backend-config` で渡す。

```bash
terraform init \
  -backend-config="bucket=<STATE_BUCKET>" \
  -backend-config="key=q-documents/terraform.tfstate" \
  -backend-config="region=ap-northeast-1"
```

`<STATE_BUCKET>` は手順1で控えた名前。

state のロックは Terraform 1.11 以降の S3 ネイティブロック（`use_lockfile = true`）を使う。
ロック専用の DynamoDB テーブルは要らない。

### 4. 合言葉を入れる（apply の後）

合言葉の値は Terraform で管理しない。**渡した値は state に平文で残る**ため
（CLAUDE.md §8-1）。`ssm.tf` は入れ物だけ作り、値は CLI で入れる。

```bash
aws ssm put-parameter --name /q-documents/passphrase \
  --type SecureString --value '<合言葉>' --overwrite
```

`ignore_changes = [value]` を付けてあるので、以降の `terraform apply` が
この値をプレースホルダに戻すことはない。

---

## 通常の操作

```bash
terraform fmt -check
terraform validate
terraform plan
terraform apply
```

**インフラの PR は「ブランチ上で apply → 成功を確認 → マージ」の順序**（CLAUDE.md §11）。
適用してみないと通るか分からないため、apply が通ったコードだけを main に入れる。

---

## 意図的に「書いていない」もの

読んだときに抜けと誤解しやすいので、理由とともに残す。

| 書いていないもの | 理由 |
| --- | --- |
| S3 のライフサイクルルール | ストレージクラスの割り当ては状態遷移に連動し、非同期Lambdaが `CopyObject` で行う（CLAUDE.md §6）。Terraform のライフサイクルは時間ベースなので、まだ最新の文書が Glacier に落ちる |
| S3 のバージョニング | 同一キーへの `CopyObject` でクラスだけ変える運用のため、クラス変更のたびにバージョンが増えてコストが読めなくなる |
| S3 のバケットポリシー（`s3.tf` に無い理由） | OAC からの読み取り許可には CloudFront ディストリビューションの ARN が要るため、`cloudfront.tf` に置いた |
| CloudFront のアクセスログ | ログ用バケットと保管費用が増える。要件が求める記録（誰がエクセル・旧版を取得したか）は Lambda が CloudWatch Logs に書く（CLAUDE.md §8-7）。誰が画面を開いたかの記録は要件にない |
| API Gateway のアクセスログ | 実行ログの有効化にはアカウント単位の CloudWatch ロール設定が要り、同じリージョンの他の API にも影響する |
| API Gateway / CloudFront の TLS バージョン指定 | 独自ドメインを持たない構成では設定できない。実測結果と扱いは `docs/ip-restriction-verification.md`「TLS の実測」 |
| 個別のエンドポイント定義 | `ANY /{proxy+}` の1本にまとめ、パスの振り分けは Lambda 側で行う。パスの正は `docs/API.md` |
| DynamoDB の `server_side_encryption` | DynamoDB は保管時暗号化が常に有効で無効にできない。何も書かなければ AWS 所有キーで暗号化され追加費用ゼロ。`enabled = true` は「暗号化をオンにする」ではなく「AWS マネージドキーに切り替える」意味で、強度は変わらず KMS の課金だけ増える。**書かないことが要件（`docs/要件定義書.md` §7-2）を最も安く満たす** |
| DynamoDB のロックテーブル | S3 ネイティブロックを使うため不要 |
| 合言葉の値 | state に平文で残るため。上記「4. 合言葉を入れる」を参照 |
