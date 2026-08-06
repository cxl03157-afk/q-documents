/**
 * DynamoDB テーブル2本（docs/DynamoDBテーブル設計.md）。
 *
 * 属性名は shared/types.ts に合わせる。型の単一の正はあちらで、
 * ここで別名を付けるとアプリ側と二重管理になる（CLAUDE.md §7）。
 *
 * billing_mode は PAY_PER_REQUEST。プロビジョンドは使わなくても課金され、
 * この規模ではオンデマンドのほうが確実に安い。キャパシティ設計も不要になる。
 *
 * **保管時暗号化（docs/要件定義書.md §7-2）は、あえて何も書かないことで満たしている。**
 * DynamoDB は保管時暗号化が常に有効で、そもそも無効にできない。
 * 何も指定しなければ「AWS 所有キー」で暗号化され、追加費用はゼロ。
 *
 * server_side_encryption { enabled = true } は「暗号化をオンにする」ではなく
 * 「AWS 所有キーから AWS マネージドキー（aws/dynamodb）に切り替える」という意味で、
 * 暗号化の強度は変わらないまま KMS API 呼び出しの課金だけが増える。
 * 得られるのは CloudTrail でキー使用を追える点だけなので、今回は採らない。
 */

/**
 * 文書台帳。PK = 製品コード / SK = 文書ID#リビジョン
 *
 * SK を「文書ID#リビジョン」にしているのは、採番（同じ文書IDの現行Revを知る）と
 * 関連導出（製品コードで全件引く）の両方を1本で賄うため。
 * 文書IDの前方一致 Query で、その文書の全リビジョンが Rev 順に並ぶ。
 */
resource "aws_dynamodb_table" "ledger" {
  name         = "q-documents-ledger"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "productCode"
  range_key    = "sortKey"

  attribute {
    name = "productCode"
    type = "S"
  }

  attribute {
    name = "sortKey"
    type = "S"
  }

  /**
   * 台帳はこのシステムの正。どのファイルが存在するかを他から復元できない
   * （S3 を舐めれば実体は分かるが、状態・担当者・発行日は台帳にしかない）。
   * 保存するのはメタデータだけで容量が小さく、費用は月あたり数十円に収まる。
   */
  point_in_time_recovery {
    enabled = true
  }
}

/**
 * 選択肢マスタ。PK = 項目種別 / SK = コード番号
 *
 * 種別ごとにテーブルを分けない。プルダウンで引くだけで種別間の関連がなく、
 * 4本に分けると GET /masters のたびに4回引くことになる。
 */
resource "aws_dynamodb_table" "masters" {
  name         = "q-documents-masters"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "category"
  range_key    = "code"

  attribute {
    name = "category"
    type = "S"
  }

  attribute {
    name = "code"
    type = "S"
  }

  # マスタを失うと過去の文書が参照するコードの表示名が引けなくなる
  point_in_time_recovery {
    enabled = true
  }
}
