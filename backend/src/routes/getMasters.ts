/**
 * GET /masters — 選択肢マスタの全件取得（F-10 / docs/API.md）。
 *
 * 合言葉は要らない。マスタは全画面のプルダウンの元になり、S-1（一覧・検索）は
 * ロック状態でも使える必要があるため（docs/API.md「読み取り専用のGET」）。
 *
 * **無効なマスタも含めて返す。** 絞り込みは画面側の責務で、用途によって扱いが
 * 逆になるため（登録 S-3 は有効のみ、検索 S-1 は `（無効）` 付きで出す）。
 * サーバー側で先に落とすと、S-1 が廃番になった製品の文書へ到達できなくなる
 * （docs/context.md 8/6 の決定）。
 */

import type { APIGatewayProxyResult } from 'aws-lambda';
import { jsonResponse } from '../http';
import { loadMasters } from '../masters';
import type { PublicContext } from './context';

export async function getMasters(context: PublicContext): Promise<APIGatewayProxyResult> {
  const masters = await loadMasters();
  return jsonResponse(context.origin, 200, { masters });
}
