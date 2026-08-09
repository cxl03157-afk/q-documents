/**
 * POST /documents/number-preview — 文書番号案の生成（F-02 / docs/API.md）。
 *
 * **台帳には何も書かない。** 画面が番号を確認してから `[登録]` を押す2段構えのため
 * （docs/screens.md S-3）。採番した番号を文書本体とファイル名に書き写す作業があるので、
 * 押した瞬間に登録される作りにはしない。
 *
 * 合言葉は要らない。番号を見るだけでは台帳が変わらないため（docs/API.md）。
 * 書き込みは `POST /documents` が受け持ち、そちらはトークンを要求する。
 */

import type { APIGatewayProxyResult } from 'aws-lambda';
import { errorResponse, jsonResponse } from '../http';
import { loadMasters } from '../masters';
import type { PublicContext } from './context';
import { resolveNewNumber } from './numbering';

export async function postNumberPreview(
  context: PublicContext,
): Promise<APIGatewayProxyResult> {
  const masters = await loadMasters();
  const outcome = await resolveNewNumber(masters, context.body);

  if (!outcome.ok) {
    const { status, message, extra } = outcome.error;
    return errorResponse(context.origin, status, message, extra);
  }

  const { documentNo, documentId, revision, processName } = outcome.value;

  return jsonResponse(context.origin, 200, {
    documentNo,
    documentId,
    revision,
    processName,
  });
}
