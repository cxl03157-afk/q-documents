/**
 * 選択肢マスタ（DynamoDB）の読み出し。
 *
 * テーブルは PK = 項目種別（category）/ SK = コード番号（code）
 * （docs/DynamoDBテーブル設計.md）。型は shared/types.ts を正とする。
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';
import type { MasterRecord } from '../../shared/types';
import { config } from './config';

const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));

/**
 * 担当者マスタに、その氏名が有効な状態で存在するか。
 *
 * **氏名で引いている。** 画面（S-2）のプルダウンが氏名を値にしているため。
 * コードで引くほうがキー1本で済むが、それには GET /masters が氏名とコードの対を
 * 画面へ渡している必要があり、それは 8/11 の実装になる。
 *
 * 照合する理由は、氏名がログに残る唯一の識別子だから（CLAUDE.md §8-7）。
 * 自由入力を通すと「誰がエクセルを持ち出したか」の記録が意味を失う。
 * 合言葉は個人を認証しないので、これは本人性の確認ではなく
 * 「実在する担当者の名前しか記録に入らない」ことの担保にとどまる（docs/API.md）。
 *
 * 無効化された担当者を弾くのは、無効化が「今後この人を選ばせない」という意思表示のため。
 * 検索（S-1）で無効マスタも選択肢に出すのとは向きが逆で、ここは登録側と同じ扱いにする。
 */
export async function isActiveOwner(userName: string): Promise<boolean> {
  const response = await client.send(
    new QueryCommand({
      TableName: config.mastersTable,
      KeyConditionExpression: '#category = :category',
      ExpressionAttributeNames: { '#category': 'category' },
      ExpressionAttributeValues: { ':category': '担当者' },
    })
  );

  const items = (response.Items ?? []) as MasterRecord[];
  return items.some((item) => item.name === userName && item.status === '有効');
}
