/**
 * POST /documents/{docNo}/revisions — リビジョンアップ（F-03 / F-07 / docs/API.md）。
 *
 * 現行文書のリビジョンを1つ進め、新しいレコードを「ファイル未登録」で作る。
 * 旧版へのアーカイブは新Revのファイルが揃った時点で非同期Lambdaが行う（F-04）。
 * **ここでは既存のレコードに一切触れない。** 状態遷移は同期APIの責務ではない（CLAUDE.md §5・§7）。
 */

import type { APIGatewayProxyResult } from 'aws-lambda';
import { buildSortKey, nextRevision, parseDocumentNo } from '../../../shared/documentNo';
import { findOwnerByName } from '../../../shared/masters';
import type { DocumentRecord } from '../../../shared/types';
import { errorResponse, jsonResponse } from '../http';
import { getDocument, putNewDocument } from '../ledger';
import { loadMasters } from '../masters';
import { isValidIssuedAt, parseJsonObject, requiredString } from '../validate';
import type { AuthedContext } from './context';

export async function postRevision(context: AuthedContext): Promise<APIGatewayProxyResult> {
  const documentNo = context.params.docNo ?? '';

  const source = parseJsonObject(context.body);
  if (source === null) {
    return errorResponse(context.origin, 400, 'リクエストの形式が正しくありません');
  }

  /**
   * `productCode` を受け取るのは、DynamoDB の GetItem に PK が要るため。
   *
   * 文書番号から製品コードを切り出す方式は採らない。製品単位（`文書種類_製品コード_Rev`）と
   * 工程単位（`製品コード_工程番号_工程名_Rev`）で位置が違ううえ、製品コードに `_` が
   * 入った瞬間に切り出しが壊れる。
   *
   * 誤った製品コードを送られても危険はない。キーが合わなければ何も引けず 404 になる。
   */
  const productCode = requiredString(source, 'productCode');
  const owner = requiredString(source, 'owner');
  const issuedAt = requiredString(source, 'issuedAt');

  if (productCode === null || owner === null || issuedAt === null) {
    return errorResponse(context.origin, 400, 'リクエストの形式が正しくありません');
  }
  if (!isValidIssuedAt(issuedAt)) {
    return errorResponse(context.origin, 400, '文書発行日の形式が正しくありません');
  }

  const parsed = parseDocumentNo(documentNo);
  const sortKey = buildSortKey(documentNo);
  if (parsed === null || sortKey === null) {
    return errorResponse(context.origin, 400, '文書番号の形式が正しくありません');
  }

  const masters = await loadMasters();

  /**
   * 新しいリビジョンは新規発行にあたるので、担当者は有効なものだけ受け付ける。
   * 現行の担当者が無効化されていれば、画面側は既定値を置かず選び直させる
   * （docs/screens.md S-4）。
   *
   * **この画面で無効化に当たるのは現実的に起こる。** 既定値が現行リビジョンの担当者で、
   * その人が後から無効化されている場合があるため。文言を分けておかないと、
   * 既定のまま押した利用者に「登録されていません」と出て、何を直せばよいか分からない。
   */
  const ownerMaster = findOwnerByName(masters, owner);
  if (ownerMaster === undefined) {
    return errorResponse(context.origin, 400, '担当者がマスタに登録されていません');
  }
  if (ownerMaster.status !== '有効') {
    return errorResponse(
      context.origin,
      400,
      'この担当者は無効化されています。有効な担当者を選んでください',
    );
  }

  const current = await getDocument(productCode, sortKey);
  if (current === undefined || current.documentNo !== documentNo) {
    return errorResponse(context.origin, 404, 'この文書番号は台帳に登録されていません');
  }

  /**
   * 旧版からは進めない（docs/screens.md S-4）。
   * 旧版になっているということは、より新しい Rev が既にあるということで、
   * そこから1つ進めると既存の番号と衝突する。
   */
  if (current.status === '旧版') {
    return errorResponse(
      context.origin,
      409,
      'このリビジョンは旧版です。最新のリビジョンからリビジョンアップしてください',
    );
  }

  /**
   * 削除済みからも進めない。
   * 論理削除は取り消せず、同じ文書番号で発行し直すのが復旧手段（CLAUDE.md §5）。
   * 消した版から次の版を生やすと、生きていない系列の続きができる。
   */
  if (current.status === '削除済み') {
    return errorResponse(
      context.origin,
      409,
      'このリビジョンは削除済みです。新規発行でやり直してください',
    );
  }

  const newRevision = nextRevision(parsed.revision);
  const newDocumentNo = `${parsed.documentId}_${newRevision}`;
  const newSortKey = buildSortKey(newDocumentNo);
  if (newSortKey === null) {
    return errorResponse(context.origin, 400, '文書番号を組み立てられませんでした');
  }

  /**
   * 番号を構成する項目は現行レコードから引き継ぐ。リクエストからは受け取らない。
   * 変えれば別の文書になるため、S-4 では変更できない（docs/screens.md S-4）。
   *
   * **S3キーは引き継がない。** 引き継ぐと非同期Lambdaが「両方揃った」と判断して
   * ファイルが1つも無い Rev を「最新」にしてしまう。
   * オブジェクトを新しく組み立てているので、書き忘れではなく意図的に無い。
   */
  const record: DocumentRecord = {
    productCode: current.productCode,
    sortKey: newSortKey,
    documentNo: newDocumentNo,
    documentType: current.documentType,
    processNo: current.processNo,
    processName: current.processName,
    revision: newRevision,
    owner,
    issuedAt,
    registeredAt: new Date().toISOString(),
    status: 'ファイル未登録',
  };

  const written = await putNewDocument(record);
  if (!written) {
    return errorResponse(
      context.origin,
      409,
      `Rev ${newRevision} は既に台帳にあります`,
    );
  }

  console.log(
    JSON.stringify({
      message: 'revision created',
      from: documentNo,
      documentNo: newDocumentNo,
      owner: record.owner,
      operator: context.identity.userName,
    }),
  );

  return jsonResponse(context.origin, 201, { document: record });
}
