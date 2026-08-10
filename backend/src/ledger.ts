/**
 * 文書台帳（DynamoDB）へのアクセス。
 *
 * PK = 製品コード（productCode）/ SK = 文書ID#リビジョン（sortKey）
 * （docs/DynamoDBテーブル設計.md）。型は shared/types.ts を正とする。
 *
 * **状態を書き換える処理はここに置かない。** 状態遷移は非同期Lambdaの責務で、
 * 同期API が書いてよいのは新規作成時の「ファイル未登録」だけ（CLAUDE.md §5・§7）。
 */

import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { GetCommand, PutCommand, QueryCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { revisionPrefix } from '../../shared/documentNo';
import type { DocumentRecord } from '../../shared/types';
import { config } from './config';
import { documentClient } from './dynamodb';

/**
 * 同じ文書IDの全リビジョンを取る。
 *
 * 採番の重複チェックがこれを使う。前方一致に `#` を含める理由は
 * shared/documentNo.ts の `revisionPrefix` を見ること（工程1 と 工程10 の取り違え）。
 *
 * ページングしないのは、1つの文書IDに対するリビジョンが最大でも2桁に収まり、
 * 1件あたり数百バイトなので 1MB の応答上限に遠く届かないため。
 */
export async function queryRevisions(
  productCode: string,
  documentId: string,
): Promise<DocumentRecord[]> {
  const response = await documentClient.send(
    new QueryCommand({
      TableName: config.ledgerTable,
      KeyConditionExpression: 'productCode = :pk AND begins_with(sortKey, :prefix)',
      ExpressionAttributeValues: {
        ':pk': productCode,
        ':prefix': revisionPrefix(documentId),
      },
    }),
  );

  return (response.Items ?? []) as DocumentRecord[];
}

/**
 * 1件引く。**強い整合性で読む。**
 *
 * DynamoDB の既定は結果整合性で、直前の書き込みが見えないことがある。
 * ここを既定のままにすると `POST /documents/{docNo}/upload-url` が壊れる。
 *
 *   非同期Lambdaが s3KeyPdf を記録した直後にもう一度アップロードを要求されると、
 *   古い値（キー未記録）が返り、「まだ登録されていない」と判断して
 *   **配布済みのPDFを差し替えられる署名付きURLを発行してしまう。**
 *
 * 採番（createRevision.ts）が既定のままでも壊れなかったのは、読んだあとに
 * 条件付き `PutItem` という第2層があるから。**upload-url の「書き込み」は S3 で起きるので、
 * DynamoDB の条件式では守れない。第2層が無い分、読みの正しさに寄りかかっている。**
 *
 * コストは 1件あたり 0.5 → 1 RCU。この規模では誤差なので、呼び出し側で
 * 使い分けさせずに常に強い整合性で読む。
 *
 * **これで消えない競合が1つ残る。** 2つのリクエストがほぼ同時に来ると、
 * どちらも「未登録」を読んでURLが2本出る。閉じるには台帳側に予約を書く必要があり、
 * そこまではしない（同一人物の二度押しが主で、S-5 はボタンを無効化する）。
 */
export async function getDocument(
  productCode: string,
  sortKey: string,
): Promise<DocumentRecord | undefined> {
  const response = await documentClient.send(
    new GetCommand({
      TableName: config.ledgerTable,
      Key: { productCode, sortKey },
      ConsistentRead: true,
    }),
  );

  return response.Item as DocumentRecord | undefined;
}

/**
 * 台帳の全件。`GET /documents` が使う。
 *
 * 絞り込み・関連導出・CSV は画面側が行う設計なので、ここは全件返す（docs/API.md）。
 * **論理削除の除外もここではしない** — トークンの有無で見せ方が変わるのは
 * ハンドラの判断で、この層は「台帳に何があるか」だけを答える。
 *
 * Scan は 1MB で切れるので続きを読み進める。台帳が数千件を超えると
 * 全件を画面へ返す設計自体が重くなるが、それは絞り込みをサーバー側へ移す判断であって
 * ここで黙って打ち切ってよい理由にはならない。
 */
export async function scanDocuments(): Promise<DocumentRecord[]> {
  const items: DocumentRecord[] = [];
  let startKey: Record<string, unknown> | undefined;

  do {
    const response = await documentClient.send(
      new ScanCommand({
        TableName: config.ledgerTable,
        ExclusiveStartKey: startKey,
      }),
    );

    items.push(...((response.Items ?? []) as DocumentRecord[]));
    startKey = response.LastEvaluatedKey;
  } while (startKey !== undefined);

  return items;
}

/**
 * 新しいレコードを書く。既に生きているレコードがあれば書かずに false を返す。
 *
 * **条件式が、採番の規律をそのまま表している**（CLAUDE.md §5）。
 *
 *   attribute_not_exists(sortKey)  — 誰も使っていないキーなら書いてよい
 *   OR #status = '削除済み'          — 論理削除したものは同じ番号で発行し直せる
 *
 * 呼び出し前に `queryRevisions` で重複を調べているが、それだけでは足りない。
 * 調べてから書くまでの間に別のリクエストが同じキーを埋める余地があり、
 * その場合は後から来たほうが黙って上書きする（DynamoDB の Put は既定で上書き）。
 * 担当者や発行日を書いた本人の記録が消えるので、条件式で弾いて 409 を返す。
 *
 * 逆に、事前の Query だけを頼りにもできない。Query が見るのは「同じ文書IDの
 * 別リビジョン」まで含む広い範囲で、条件式が見るのは「まったく同じキー」1件だけ。
 * 守れる範囲が違うので両方要る。
 */
export async function putNewDocument(record: DocumentRecord): Promise<boolean> {
  try {
    await documentClient.send(
      new PutCommand({
        TableName: config.ledgerTable,
        Item: record,
        ConditionExpression: 'attribute_not_exists(sortKey) OR #status = :deleted',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: { ':deleted': '削除済み' },
      }),
    );
    return true;
  } catch (error) {
    if (error instanceof ConditionalCheckFailedException) return false;
    throw error;
  }
}
