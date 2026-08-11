/**
 * 台帳（DynamoDB）への書き込み。**状態を書き換えてよいのはこの層だけ**（CLAUDE.md §5・§7）。
 *
 * 同期API側の ledger.ts とは意図的に分けている。あちらは config.ts（環境変数7本）を
 * 読むので、非同期Lambdaから import すると初期化に失敗する。
 * `queryRevisions` だけは同じ Query を書くことになるが、共通化のために
 * どちらかがもう一方の設定を読む形にするほうが害が大きい。
 *
 * ---
 *
 * **この4つの関数は、条件式がそのまま状態遷移の規律になっている。**
 * 実装を読まなくても、条件式を読めば「どこからどこへ進めるか」が分かるように書く。
 * 条件不成立（`ConditionalCheckFailedException`）は失敗ではなく
 * **「他の実行が先に済ませた」という正常な結果**として false / null を返す。
 * S3イベントは at-least-once で、PDF とエクセルは2並列で届く（CLAUDE.md §5）。
 */

import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { revisionPrefix } from '../../../shared/documentNo';
import type { DocumentRecord } from '../../../shared/types';
import { documentClient } from '../dynamodb';
import type { FileType } from '../s3Key';
import { asyncConfig } from './config';

/** 種別と台帳の属性名の対応。`shared/types.ts` の `DocumentRecord` に合わせる */
const KEY_ATTRIBUTE: Record<FileType, 's3KeyPdf' | 's3KeyExcel'> = {
  pdf: 's3KeyPdf',
  excel: 's3KeyExcel',
};

/**
 * 段1 — S3キーを記録する。更新後のレコード全体を返す。条件不成立なら null。
 *
 * **書く値が決定的なので、自然に冪等になる。** キーは文書番号から一意に決まるため、
 * 同じイベントが2回届いても2回目は同じ値を書くだけで結果が変わらない。
 *
 * 条件式は3つ。
 *
 *   attribute_exists(sortKey)
 *     `UpdateItem` は**既定でレコードを新規作成する**。これが無いと、台帳に無い
 *     文書番号のオブジェクトが置かれたときに、S3キーだけを持つ壊れたレコードが生える
 *     （採番も担当者も発行日も無い）。実在するレコードにしか書かないことを表す。
 *
 *   #status <> '旧版'
 *     **再帰の遮断がこれの主な役目。** 段3-D が旧版のファイルを Glacier へ
 *     `CopyObject` するので、通知フィルタが破れてコピーのイベントが返ってきたときに、
 *     ここで1ホップ目を止める。副次的に、旧版の中身の差し替えも防ぐ。
 *
 *   #status <> '削除済み'
 *     消した版の実体が台帳に載るのを防ぐ。同期APIが 409 で弾いているので
 *     通常は届かないが、サーバー側の検証を1か所に頼らない（CLAUDE.md §7）。
 *
 * **`ReturnValues: ALL_NEW` を使うのが要点。** 「書いてから `GetItem` で読み直す」と、
 * PDF とエクセルの2実行が**同じ姿を同時に観測**しうる（＝両方が「両方揃った」と判断する）。
 * `ALL_NEW` は自分の書き込みが反映された姿を1回だけ返すので、判断の根拠がぶれない。
 */
export async function recordS3Key(
  productCode: string,
  sortKey: string,
  fileType: FileType,
  s3Key: string,
): Promise<DocumentRecord | null> {
  try {
    const response = await documentClient.send(
      new UpdateCommand({
        TableName: asyncConfig.ledgerTable,
        Key: { productCode, sortKey },
        UpdateExpression: 'SET #key = :s3Key',
        ConditionExpression:
          'attribute_exists(sortKey) AND #status <> :archived AND #status <> :deleted',
        ExpressionAttributeNames: {
          '#key': KEY_ATTRIBUTE[fileType],
          '#status': 'status',
        },
        ExpressionAttributeValues: {
          ':s3Key': s3Key,
          ':archived': '旧版',
          ':deleted': '削除済み',
        },
        ReturnValues: 'ALL_NEW',
      }),
    );

    return (response.Attributes ?? null) as DocumentRecord | null;
  } catch (error) {
    if (error instanceof ConditionalCheckFailedException) return null;
    throw error;
  }
}

/**
 * 段2A — 「最新」へ進める。書けたら true、他の実行が先に済ませていたら false。
 *
 * 条件式が CLAUDE.md §5 の規律をそのまま表している。
 *
 *   attribute_exists(s3KeyPdf) AND attribute_exists(s3KeyExcel)
 *     段1 の `ALL_NEW` を見て「両方ある」と判断してから、**もう一度 DynamoDB 側でも
 *     確かめる**。読んでからこの更新を出すまでの間は開いているので、
 *     判断の根拠を条件式にも書いておく。
 *
 *   #status = 'ファイル未登録' OR #status = '一部登録'
 *     **逆方向の遷移はない。** 「旧版」からも「削除済み」からも「最新」には入れない。
 *     「一部登録 → 最新」を許すのは、未登録の種別を後から足せるようにしたため
 *     （要件定義書 F-01・8/10 の決定）。
 */
export async function promoteToLatest(productCode: string, sortKey: string): Promise<boolean> {
  return await applyStatus({
    productCode,
    sortKey,
    next: '最新',
    condition:
      'attribute_exists(s3KeyPdf) AND attribute_exists(s3KeyExcel)' +
      ' AND (#status = :unregistered OR #status = :partial)',
    values: { ':unregistered': 'ファイル未登録', ':partial': '一部登録' },
  });
}

/**
 * 段2B — 「一部登録」へ進める。
 *
 * 条件は「ファイル未登録であること」だけ。
 * 「一部登録」を条件に含めないのは、含めても書く値が同じで無意味なうえ、
 * **「最新」から「一部登録」へ落とす経路を絶対に作らない**ことを条件式で示すため。
 */
export async function markPartiallyRegistered(
  productCode: string,
  sortKey: string,
): Promise<boolean> {
  return await applyStatus({
    productCode,
    sortKey,
    next: '一部登録',
    condition: '#status = :unregistered',
    values: { ':unregistered': 'ファイル未登録' },
  });
}

/**
 * 段3-B — 前リビジョンを「旧版」へ落とす（F-04）。
 *
 * 条件は「まだ最新であること」。**ここも先勝ち**で、複数の実行が同じ前リビジョンを
 * 落としにきても書けるのは1つだけ。この戻り値が「Glacier へ送る権利」を兼ねる
 * … ようにはしていない（それだと落ちたときに誰も送らなくなる）。
 * 段3-D は台帳の状態から対象を決め直す（transition.ts の `revisionsAlreadyArchived`）。
 */
export async function archiveRevision(productCode: string, sortKey: string): Promise<boolean> {
  return await applyStatus({
    productCode,
    sortKey,
    next: '旧版',
    condition: '#status = :latest',
    values: { ':latest': '最新' },
  });
}

/** 上の3つの共通部分。条件式と目標の状態だけが違う */
async function applyStatus(params: {
  productCode: string;
  sortKey: string;
  next: DocumentRecord['status'];
  condition: string;
  values: Record<string, string>;
}): Promise<boolean> {
  try {
    await documentClient.send(
      new UpdateCommand({
        TableName: asyncConfig.ledgerTable,
        Key: { productCode: params.productCode, sortKey: params.sortKey },
        UpdateExpression: 'SET #status = :next',
        ConditionExpression: params.condition,
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: { ...params.values, ':next': params.next },
      }),
    );
    return true;
  } catch (error) {
    if (error instanceof ConditionalCheckFailedException) return false;
    throw error;
  }
}

/**
 * 同じ文書IDの全リビジョン。段3 が前リビジョンを探すのに使う。
 *
 * **強い整合性で読む。** 直前に自分が書いた「最新」が見えないまま前リビジョンを
 * 探すと、状況の判断が1手ぶん古くなる。件数はリビジョンの数（多くても2桁）なので、
 * 1 RCU に上がっても誤差。
 *
 * 前方一致に `#` を含める理由は shared/documentNo.ts の `revisionPrefix`
 * （工程1 と 工程10 の取り違え）。
 */
export async function queryRevisions(
  productCode: string,
  documentId: string,
): Promise<DocumentRecord[]> {
  const response = await documentClient.send(
    new QueryCommand({
      TableName: asyncConfig.ledgerTable,
      KeyConditionExpression: 'productCode = :pk AND begins_with(sortKey, :prefix)',
      ExpressionAttributeValues: {
        ':pk': productCode,
        ':prefix': revisionPrefix(documentId),
      },
      ConsistentRead: true,
    }),
  );

  return (response.Items ?? []) as DocumentRecord[];
}
