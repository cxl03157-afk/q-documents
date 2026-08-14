/**
 * POST /documents — 文書番号を確定し台帳に記録する（F-02 / F-07 / docs/API.md）。
 *
 * 合言葉が要る。台帳に行を増やす操作で、誰でも実行できると採番が荒らされるため
 * （docs/API.md「書き込み系すべて」）。
 *
 * **番号は number-preview と同じ導出をやり直す。** 画面が見せた番号を送り返す方式にしない。
 * 送られてきた番号を信じるなら結局こちらで命名ルールを検証し直すことになり、
 * 生成と検証で規則が二重管理になる。マスタが間に変わっていれば導出結果も変わるが、
 * そのときは新しいマスタに従うのが正しい。
 */

import type { APIGatewayProxyResult } from 'aws-lambda';
import { activeOwnerRejection } from '../../../shared/masters';
import type { DocumentRecord } from '../../../shared/types';
import { errorResponse, jsonResponse } from '../http';
import { putNewDocument } from '../ledger';
import { loadMasters } from '../masters';
import { isValidIssuedAt, parseJsonObject, requiredString } from '../validate';
import type { AuthedContext } from './context';
import { resolveNewNumber } from './numbering';

export async function postDocument(context: AuthedContext): Promise<APIGatewayProxyResult> {
  const source = parseJsonObject(context.body);
  if (source === null) {
    return errorResponse(context.origin, 400, 'リクエストの形式が正しくありません');
  }

  const owner = requiredString(source, 'owner');
  const issuedAt = requiredString(source, 'issuedAt');
  if (owner === null || issuedAt === null) {
    return errorResponse(context.origin, 400, 'リクエストの形式が正しくありません');
  }
  if (!isValidIssuedAt(issuedAt)) {
    return errorResponse(context.origin, 400, '文書発行日の形式が正しくありません');
  }

  const masters = await loadMasters();

  /**
   * 担当者は**有効なものだけ**受け付ける（docs/screens.md S-4・shared/masters.ts）。
   *
   * 解除した本人（`context.identity.userName`）とは別物なので混同しない。
   * 担当者は「この文書の責任者は誰か」で、画面で選ばせる値。
   * 解除した本人は「誰がこの操作をしたか」で、記録に残す値。
   * 代理で登録することがあるため、同じにしてしまうと台帳が事実と食い違う。
   *
   * **未登録と無効化を書き分ける。** 直し方が正反対（マスタに追加する／別の人を選ぶ）で、
   * 同じ文言だと無効化された担当者を選んだ人が S-6 を探し回ることになる。
   * 担当者の一覧と状態は `GET /masters` が誰にでも返しているので、
   * 書き分けても新しく漏れる情報はない。
   */
  const ownerRejection = activeOwnerRejection(masters, owner);
  if (ownerRejection !== null) {
    return errorResponse(context.origin, 400, ownerRejection);
  }

  const outcome = await resolveNewNumber(masters, context.body);
  if (!outcome.ok) {
    const { status, message, extra } = outcome.error;
    return errorResponse(context.origin, status, message, extra);
  }

  const derived = outcome.value;

  const record: DocumentRecord = {
    productCode: derived.productCode,
    sortKey: derived.sortKey,
    documentNo: derived.documentNo,
    documentType: derived.documentType,
    processNo: derived.processNo,
    processName: derived.processName,
    revision: derived.revision,
    owner,
    issuedAt,
    registeredAt: new Date().toISOString(),

    /**
     * 状態を書き換えられるのは非同期Lambdaだけで、同期APIが書いてよいのは
     * この「新規作成時のファイル未登録」だけ（CLAUDE.md §5・§7）。
     * ここ以外で status を組み立てないこと。
     */
    status: 'ファイル未登録',
  };

  const written = await putNewDocument(record);
  if (!written) {
    /**
     * 直前の重複チェックを通ったのにここで弾かれた＝ほぼ同時に同じ番号が登録された。
     * 上書きせずに知らせる。黙って上書きすると、先に登録した人の担当者と発行日が
     * 消えたことに誰も気づけない。
     */
    return errorResponse(
      context.origin,
      409,
      'この文書番号は既に登録されています。一覧を確認してください',
    );
  }

  console.log(
    JSON.stringify({
      message: 'document created',
      documentNo: record.documentNo,
      owner: record.owner,
      // 誰が操作したか。氏名は記録に残る唯一の識別子（CLAUDE.md §8-7）
      operator: context.identity.userName,
    }),
  );

  return jsonResponse(context.origin, 201, { document: record });
}
