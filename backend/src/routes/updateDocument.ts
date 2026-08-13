/**
 * PATCH /documents/{docNo}?productCode=... — 台帳レコードの修正（F-13 / F-18 / docs/API.md）。
 *
 * 誤登録の訂正だけを目的とする。**編集できるのは担当者と文書発行日の2項目**で、
 * それは `DocumentPatch`（shared/types.ts）がその2つしか持たないことで型として表れている。
 *
 * 文書番号を構成する項目（製品コード・文書種類・工程番号・工程名・リビジョン）は
 * 変更できない。変えれば別の文書番号・別の SK になり、それは修正ではなく別文書の作成だから。
 * 状態も変更できない — 手で「最新」にできると、ファイルが存在しないのに最新になり
 * F-04 のアーカイブ判定が狂う（CLAUDE.md §5・docs/screens.md S-7）。
 *
 * ---
 *
 * **`productCode` はボディではなくクエリで受ける。**
 *
 * これは台帳の PK であってレコードを特定するための値で、変更内容ではない。
 * パス（`{docNo}`）と合わせて「どのレコードか」を表し、ボディは「何に変えるか」だけを持つ。
 * `DELETE /documents/{docNo}` は本文を持てないのでどのみちクエリになり、
 * `GET /documents/{docNo}/download-url` も既にクエリで受けている。
 * 同じレコードの指し方を3本で揃える。
 */

import type { APIGatewayProxyResult } from 'aws-lambda';
import { buildSortKey } from '../../../shared/documentNo';
import { ownerChangeRejection } from '../../../shared/masters';
import type { DocumentPatch } from '../../../shared/types';
import { errorResponse, jsonResponse } from '../http';
import { getDocument, updateDocumentRecord } from '../ledger';
import { loadMasters } from '../masters';
import { isValidIssuedAt, parseJsonObject, requiredString } from '../validate';
import type { AuthedContext } from './context';

/** 既に消えているものを直そうとした場合の文言。DELETE 側と揃える */
export const ALREADY_DELETED = 'この文書は既に論理削除されています';

export async function patchDocument(context: AuthedContext): Promise<APIGatewayProxyResult> {
  const documentNo = context.params.docNo ?? '';
  const productCode = context.query.productCode ?? '';

  if (productCode === '') {
    return errorResponse(context.origin, 400, 'リクエストの形式が正しくありません');
  }

  const source = parseJsonObject(context.body);
  if (source === null) {
    return errorResponse(context.origin, 400, 'リクエストの形式が正しくありません');
  }

  /**
   * **両方とも必須にする。** 部分更新（送られた項目だけ変える）にはしない。
   *
   * S-7 のフォームは常に2項目とも持って送るので、片方だけ送られてくるのは
   * 画面を経由していない呼び出しに限られる。受け付ける形を1つに絞っておけば、
   * 「送らなかったのか、空にしたかったのか」を推測する分岐が要らない。
   */
  const owner = requiredString(source, 'owner');
  const issuedAt = requiredString(source, 'issuedAt');
  if (owner === null || issuedAt === null) {
    return errorResponse(context.origin, 400, 'リクエストの形式が正しくありません');
  }
  if (!isValidIssuedAt(issuedAt)) {
    return errorResponse(context.origin, 400, '文書発行日の形式が正しくありません');
  }

  const sortKey = buildSortKey(documentNo);
  if (sortKey === null) {
    return errorResponse(context.origin, 400, '文書番号の形式が正しくありません');
  }

  /**
   * 現在のレコードを先に読む。**担当者の判定に「今の担当者が誰か」が要る**ため。
   *
   * `documentNo` の一致まで見るのは、`productCode` がクエリで来るから。
   * SK は文書番号から導けるが PK は導けない（`Q001_P-0001_01` は製品単位なら
   * 製品コード `P-0001`、工程単位として読めば `Q001`・CLAUDE.md §4）ので、
   * 別の製品コードを添えて別レコードを掴ませない。
   */
  const current = await getDocument(productCode, sortKey);
  if (current === undefined || current.documentNo !== documentNo) {
    return errorResponse(context.origin, 404, 'この文書番号は台帳に登録されていません');
  }
  if (current.status === '削除済み') {
    return errorResponse(context.origin, 409, ALREADY_DELETED);
  }

  /**
   * 担当者は**変更するときだけ**有効であることを求める（shared/masters.ts に理由）。
   *
   * 新規発行・リビジョンアップの「常に有効のみ」とは規律が違う。据え置きなら
   * 引き継ぐ値なので、担当者が退職して無効化されていても発行日だけ直せる。
   */
  const masters = await loadMasters();
  const rejection = ownerChangeRejection(masters, current.owner, owner);
  if (rejection !== null) {
    return errorResponse(context.origin, 400, rejection);
  }

  const patch: DocumentPatch = { owner, issuedAt };
  const updated = await updateDocumentRecord(productCode, sortKey, patch);
  if (updated === null) {
    // 上で削除済みを弾いているので、ここに来るのは読んでから書くまでの間に
    // 誰かが論理削除した場合（ledger.ts の条件式が原子的に止めている）
    return errorResponse(context.origin, 409, ALREADY_DELETED);
  }

  console.log(
    JSON.stringify({
      message: 'document updated',
      documentNo,
      // 何がどう変わったかを残す。担当者の付け替えは事後に追えないと困る
      previousOwner: current.owner,
      owner: updated.owner,
      previousIssuedAt: current.issuedAt,
      issuedAt: updated.issuedAt,
      // 誰が操作したか。書き込み系のログはこのキー名で揃えている
      operator: context.identity.userName,
    }),
  );

  return jsonResponse(context.origin, 200, { document: updated });
}
