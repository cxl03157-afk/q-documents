/**
 * DELETE /documents/{docNo}?productCode=... — 台帳レコードの論理削除（F-13 / F-18 / docs/API.md）。
 *
 * **物理削除はしない。** 状態を「削除済み」にするだけで、レコードも S3 のファイルも残す
 * （CLAUDE.md §5）。消してしまうと、S3 に残ったファイルが誰のものか分からなくなる。
 *
 * ---
 *
 * **この操作は取り消せない。**
 *
 * 削除前の状態を保存していないうえ、状態の再計算は非同期Lambdaの仕事なので、
 * 「元の状態に戻す」手段が設計上どこにもない（§5）。誤って消した場合の逃げ道は
 * **同じ文書番号で発行し直すこと**で、`putNewDocument` の条件式
 * （`OR #status = :deleted`）と、採番の重複チェックが削除済みを数えないことの
 * 2つがそれを支えている。
 *
 * そのため**削除前の状態をログに残す**（`previousStatus`）。台帳の上からは
 * 何が消えたのかが分からなくなるので、ここが唯一の手掛かりになる。
 */

import type { APIGatewayProxyResult } from 'aws-lambda';
import { buildSortKey } from '../../../shared/documentNo';
import { errorResponse, jsonResponse } from '../http';
import { ALREADY_DELETED, getDocument, softDeleteDocument } from '../ledger';
import type { AuthedContext } from './context';

export async function deleteDocument(context: AuthedContext): Promise<APIGatewayProxyResult> {
  const documentNo = context.params.docNo ?? '';
  const productCode = context.query.productCode ?? '';

  if (productCode === '') {
    return errorResponse(context.origin, 400, 'リクエストの形式が正しくありません');
  }

  const sortKey = buildSortKey(documentNo);
  if (sortKey === null) {
    return errorResponse(context.origin, 400, '文書番号の形式が正しくありません');
  }

  /**
   * 先に読むのは、**削除前の状態をログに残す**ためと、二重削除に
   * 分かりやすい文言を返すため。原子的な保証は `softDeleteDocument` の条件式が持つ。
   *
   * `documentNo` の一致まで見る理由は updateDocument.ts と同じ
   * （PK は文書番号から導けないので、別の製品コードで別レコードを掴ませない）。
   */
  const current = await getDocument(productCode, sortKey);
  if (current === undefined || current.documentNo !== documentNo) {
    return errorResponse(context.origin, 404, 'この文書番号は台帳に登録されていません');
  }
  if (current.status === '削除済み') {
    return errorResponse(context.origin, 409, ALREADY_DELETED);
  }

  /**
   * **どの状態からでも削除できる**（§5 の遷移図）。「最新」も止めない。
   *
   * 「一部登録」で詰まったレコードの唯一の逃げ道がこれで（docs/screens.md S-7）、
   * 状態で制限すると復旧手段が消える。「最新」を消すとその文書IDに最新が
   * 1行も無くなるが、それは同じ番号で発行し直すことで解消する。
   */
  const deleted = await softDeleteDocument(productCode, sortKey);
  if (deleted === null) {
    // 読んでから書くまでの間に別の誰かが削除した場合（条件式が止めた）
    return errorResponse(context.origin, 409, ALREADY_DELETED);
  }

  console.log(
    JSON.stringify({
      message: 'document deleted',
      documentNo,
      // 取り消せない操作なので、何を消したのかを残す唯一の場所
      previousStatus: current.status,
      owner: deleted.owner,
      operator: context.identity.userName,
    }),
  );

  return jsonResponse(context.origin, 200, { document: deleted });
}
