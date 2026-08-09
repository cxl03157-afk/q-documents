/**
 * 選択肢マスタ（DynamoDB）の読み出し。
 *
 * テーブルは PK = 項目種別（category）/ SK = コード番号（code）
 * （docs/DynamoDBテーブル設計.md）。型は shared/types.ts を正とする。
 *
 * **判定はここに書かない。** 「有効か」「共通コードか」「その製品で選べる文書種類は何か」は
 * shared/masters.ts の純粋関数が持つ。画面側と同じ判定を使うためで、
 * このファイルの責務は「配列を取ってくる」ことだけに絞る。
 */

import { ScanCommand } from '@aws-sdk/lib-dynamodb';
import type { MasterRecord } from '../../shared/types';
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
