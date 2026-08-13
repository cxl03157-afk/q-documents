/**
 * 文書台帳（DynamoDB）へのアクセス。
 *
 * PK = 製品コード（productCode）/ SK = 文書ID#リビジョン（sortKey）
 * （docs/DynamoDBテーブル設計.md）。型は shared/types.ts を正とする。
 *
 * **状態を書き換える処理は、CLAUDE.md §5 が認めた2つ以外は置かない。**
 * 状態遷移は非同期Lambdaの責務で、同期APIが書いてよいのは次の2つに限る。
 *
 *   1. 新規作成時の「ファイル未登録」（`putNewDocument`）
 *   2. 論理削除の「削除済み」（`softDeleteDocument`）— §5 が明示した唯一の例外
 *
 * それ以外の遷移（一部登録・最新・旧版）を書く式をこのファイルに作らないこと。
 * 手で「最新」にできると、ファイルが存在しないのに最新になり
 * F-04 のアーカイブ判定が狂う。`updateDocumentRecord` が `owner` / `issuedAt` しか
 * SET しないのはそのため。
 */

import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import {
  GetCommand,
  PutCommand,
  QueryCommand,
  ScanCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { revisionPrefix } from '../../shared/documentNo';
import type { DocumentPatch, DocumentRecord } from '../../shared/types';
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

/**
 * S-7 の修正（`PATCH /documents/{docNo}`）。更新後のレコードを返す。
 * 対象が無い、または既に削除済みなら `null`。
 *
 * **`SET` するのは `owner` と `issuedAt` だけ。** `DocumentPatch` が2項目に絞られている
 * （shared/types.ts）以上、`status` を書く式をここに作らない。式の組み立てが自由だと、
 * 呼び出し側の1行で状態遷移の規律が破れてしまう（CLAUDE.md §5・§7）。
 *
 * **条件式に `#status <> :deleted` を入れている理由。**
 * 呼び出し側（updateDocument.ts）が `getDocument` で削除済みを弾いているが、
 * 読んでから書くまでの間に別の誰かが論理削除する余地が残る。そこを通すと
 * **削除済みレコードの担当者を書き換えてしまう** — 論理削除は取り消せない（§5）ので、
 * 消えた行が静かに書き換わるのは台帳として困る。採番の2層防御と同じ考え方で、
 * 事前チェック（分かりやすい文言）と条件式（原子的な保証）の両方を置く。
 *
 * **担当者マスタの有効性との競合はここでは守れない。** DynamoDB の条件式は
 * 書き込み対象アイテム自身の属性しか見られず、別テーブル（マスタ）の `status` を
 * 条件にできないため。`TransactWriteItems` の `ConditionCheck` なら技術的には可能だが
 * 採らない（docs/context.md 8/11 の決定）。**この競合に負けても台帳は壊れない** —
 * 生まれるのは「無効な担当者が担当のレコード」で、無効化は新規発行を止める操作にすぎず
 * 過去の記録には普通に存在しうる状態だから（8/6 の決定）。採番の重複と違い、
 * 負けたときの結果が不整合ではないので2層目を要求しない。
 */
export async function updateDocumentRecord(
  productCode: string,
  sortKey: string,
  patch: DocumentPatch,
): Promise<DocumentRecord | null> {
  try {
    const response = await documentClient.send(
      new UpdateCommand({
        TableName: config.ledgerTable,
        Key: { productCode, sortKey },
        UpdateExpression: 'SET #owner = :owner, issuedAt = :issuedAt',
        ConditionExpression: 'attribute_exists(sortKey) AND #status <> :deleted',
        // owner・status とも DynamoDB の予約語なので退避する
        ExpressionAttributeNames: { '#owner': 'owner', '#status': 'status' },
        ExpressionAttributeValues: {
          ':owner': patch.owner,
          ':issuedAt': patch.issuedAt,
          ':deleted': '削除済み',
        },
        ReturnValues: 'ALL_NEW',
      }),
    );
    return (response.Attributes as DocumentRecord | undefined) ?? null;
  } catch (error) {
    // 条件不成立だけを「断られた」として扱う。権限不足・スロットリング・
    // テーブル不在などは握りつぶさず投げ、index.ts が 500 にしてログに残す
    if (error instanceof ConditionalCheckFailedException) return null;
    throw error;
  }
}

/**
 * S-7 の論理削除（`DELETE /documents/{docNo}`）。更新後のレコードを返す。
 * 対象が無い、または既に削除済みなら `null`。
 *
 * **同期APIが状態を書いてよい唯一の例外**（CLAUDE.md §5「状態を書き換えられるのは
 * 非同期Lambdaだけ（`削除済み` を除く）」）。削除はファイルの有無から導けるものではなく、
 * 人の判断でしか起きないため、S3イベントを起点にする非同期Lambdaでは表せない。
 *
 * **どの状態からでも削除できる**（§5 の遷移図）。「最新」を消すとその文書IDに
 * 「最新」が1行も無くなるが、それは仕様どおり — 復旧は同じ番号での発行し直しで、
 * `putNewDocument` の条件式（`OR #status = :deleted`）が既に受け入れる形になっている。
 *
 * **物理削除はしない。** レコードを消すと、S3 に残ったファイルの持ち主が分からなくなる。
 *
 * `#status <> :deleted` を条件に入れているのは二重削除を弾くため。冪等に 200 を返す案も
 * あるが、**論理削除は取り消せない操作なので「2回目は空振りだった」ことを
 * 呼び出し側に伝えたい**（1回目が誰の操作だったかはログにしか残らない）。
 */
export async function softDeleteDocument(
  productCode: string,
  sortKey: string,
): Promise<DocumentRecord | null> {
  try {
    const response = await documentClient.send(
      new UpdateCommand({
        TableName: config.ledgerTable,
        Key: { productCode, sortKey },
        UpdateExpression: 'SET #status = :deleted',
        ConditionExpression: 'attribute_exists(sortKey) AND #status <> :deleted',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: { ':deleted': '削除済み' },
        ReturnValues: 'ALL_NEW',
      }),
    );
    return (response.Attributes as DocumentRecord | undefined) ?? null;
  } catch (error) {
    if (error instanceof ConditionalCheckFailedException) return null;
    throw error;
  }
}
