/**
 * 選択肢マスタ（DynamoDB）へのアクセス。
 *
 * テーブルは PK = 項目種別（category）/ SK = コード番号（code）
 * （docs/DynamoDBテーブル設計.md）。型は shared/types.ts を正とする。
 *
 * **判定はここに書かない。** 「有効か」「共通コードか」「その製品で選べる文書種類は何か」
 * 「工程単位の文書種類が他に無いか」は shared/masters.ts の純粋関数が持つ。
 * 画面側と同じ判定を使うためで、このファイルの責務は DynamoDB とのやり取りに絞る。
 */

import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { PutCommand, ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import type { MasterCategory, MasterPatch, MasterRecord } from '../../shared/types';
import { config } from './config';
import { documentClient } from './dynamodb';

/**
 * マスタを全件読む。
 *
 * **キャッシュしない。** S-6 で追加したマスタが S-3 の選択肢にすぐ出ないと、
 * screens.md S-3 の「マスタ管理で追加してから戻る」という導線が成立しない。
 * マスタは4種別あわせて数十件の想定なので、リクエストごとに1回 Scan しても
 * 読み込みは 1 RCU 前後に収まる。
 *
 * Scan は1回の応答が 1MB で切れるため、続きがある限り読み進める。
 * 現在の規模では1回で収まるが、切れたことに気づけないまま
 * 「選択肢に出ない製品コードがある」という形で表面化するのは避けたい。
 */
export async function loadMasters(): Promise<MasterRecord[]> {
  const items: MasterRecord[] = [];
  let startKey: Record<string, unknown> | undefined;

  do {
    const response = await documentClient.send(
      new ScanCommand({
        TableName: config.mastersTable,
        ExclusiveStartKey: startKey,
      }),
    );

    items.push(...((response.Items ?? []) as MasterRecord[]));
    startKey = response.LastEvaluatedKey;
  } while (startKey !== undefined);

  return items;
}

/**
 * 新しいマスタ項目を書く。既に同じキー（category + code）があれば書かずに false を返す。
 *
 * コード重複の防止は2段構え。呼び出し側（createMaster.ts）が `loadMasters()` の結果で
 * 事前にチェックするが、それだけでは同時実行のレースが残る。ここでも条件付き書き込みで
 * 先勝ちを保証する（CLAUDE.md §5「二重実行を前提に書く」と同じ考え方）。
 *
 * **「工程単位の文書種類は1つまで」はここでは保証できない。** DynamoDB の条件式は
 * 書き込み対象アイテム自身の属性しか見られず、他のアイテムを横断した制約を表せないため。
 * 呼び出し側の事前チェック（`hasAnotherProcessScopedDocumentType`）のみに頼る。
 * マスタの追加は低頻度な管理操作なので、その間の同時実行レースは許容する。
 */
export async function putNewMaster(record: MasterRecord): Promise<boolean> {
  try {
    await documentClient.send(
      new PutCommand({
        TableName: config.mastersTable,
        Item: record,
        ConditionExpression: 'attribute_not_exists(code)',
      }),
    );
    return true;
  } catch (error) {
    if (error instanceof ConditionalCheckFailedException) return false;
    throw error;
  }
}

/**
 * マスタ項目を部分更新し、更新後のレコードを返す。存在しなければ null。
 *
 * `patch` に含まれる項目だけを `SET` する。`name` と `status` は DynamoDB の予約語なので
 * `ExpressionAttributeNames` で退避する（ledger.ts の `#status` と同じ理由）。
 *
 * **`patch` は空でない前提。** 呼び出し側（updateMaster.ts）が「最低1項目」を検証してから渡す。
 * 空で呼ぶと `UpdateExpression` が `SET` だけの不正な形になり DynamoDB 側で弾かれる。
 */
export async function updateMasterRecord(
  category: MasterCategory,
  code: string,
  patch: MasterPatch,
): Promise<MasterRecord | null> {
  const names: Record<string, string> = {};
  const values: Record<string, unknown> = {};
  const sets: string[] = [];

  if (patch.name !== undefined) {
    names['#name'] = 'name';
    values[':name'] = patch.name;
    sets.push('#name = :name');
  }
  if (patch.status !== undefined) {
    names['#status'] = 'status';
    values[':status'] = patch.status;
    sets.push('#status = :status');
  }
  if (patch.numberingRule !== undefined) {
    values[':numberingRule'] = patch.numberingRule;
    sets.push('numberingRule = :numberingRule');
  }
  if (patch.isCommon !== undefined) {
    values[':isCommon'] = patch.isCommon;
    sets.push('isCommon = :isCommon');
  }

  try {
    const response = await documentClient.send(
      new UpdateCommand({
        TableName: config.mastersTable,
        Key: { category, code },
        UpdateExpression: `SET ${sets.join(', ')}`,
        ConditionExpression: 'attribute_exists(code)',
        ExpressionAttributeNames: Object.keys(names).length > 0 ? names : undefined,
        ExpressionAttributeValues: values,
        ReturnValues: 'ALL_NEW',
      }),
    );
    return (response.Attributes as MasterRecord | undefined) ?? null;
  } catch (error) {
    if (error instanceof ConditionalCheckFailedException) return null;
    throw error;
  }
}
