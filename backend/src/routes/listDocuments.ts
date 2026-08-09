/**
 * GET /documents — 台帳の取得（F-05 / F-06 / F-08 / F-11 / docs/API.md）。
 *
 * 絞り込み・関連文書の導出・CSV出力は画面側が行うので、ここは**旧版も含めて全件**返す。
 *
 * **論理削除だけはトークンの有無で変わる。**
 *   トークン無し — 除いて返す。削除済みは既定では一覧に出ない（受け入れ基準）
 *   トークン有り — 含めて返す。文書管理者が何を消したかを追えるようにするため
 *
 * この分岐をサーバー側に置くのは、画面側だけで隠しても開発者ツールから見えてしまい、
 * 「既定では表示されない」が制御として成立しないため（CLAUDE.md §7）。
 *
 * なお、行を出すかどうかとファイルを取れるかどうかは別の話で、削除済みの取得は
 * エクセルに限る（PDFは配布物なので、消した版を現場に出さない）。その制御は
 * 署名付きURLの発行側が持つ（週3）。
 */

import type { APIGatewayProxyResult } from 'aws-lambda';
import { jsonResponse } from '../http';
import { scanDocuments } from '../ledger';
import type { MaybeAuthedContext } from './context';

export async function listDocuments(
  context: MaybeAuthedContext,
): Promise<APIGatewayProxyResult> {
  const documents = await scanDocuments();

  const visible =
    context.identity === null
      ? documents.filter((document) => document.status !== '削除済み')
      : documents;

  return jsonResponse(context.origin, 200, { documents: visible });
}
