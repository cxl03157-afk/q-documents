/**
 * POST /documents/{docNo}/revisions — リビジョンアップ（F-03 / F-07 / docs/API.md）。
 *
 * 現行文書のリビジョンを1つ進め、新しいレコードを「ファイル未登録」で作る。
 * 旧版へのアーカイブは新Revのファイルが揃った時点で非同期Lambdaが行う（F-04）。
 * **ここでは既存のレコードに一切触れない。** 状態遷移は同期APIの責務ではない（CLAUDE.md §5・§7）。
 */

import type { APIGatewayProxyResult } from 'aws-lambda';
import { buildSortKey, nextRevision, parseDocumentNo } from '../../../shared/documentNo';
import { activeOwnerRejection } from '../../../shared/masters';
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
  const ownerRejection = activeOwnerRejection(masters, owner);
  if (ownerRejection !== null) {
    return errorResponse(context.origin, 400, ownerRejection);
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

  /**
   * **ファイルが揃っていないリビジョンからは進めない。**
   *
   * Rev 02 を発行するということは、Rev 01 の文書が実在して配布されたということ。
   * それなのに台帳にファイルが無いのは、**業務としてありえない状態**で、
   * ほとんどの場合は「あとで上げるつもりで上げ忘れた」ことを意味する。
   * 先に進ませずに、まず現在の Rev を「最新」にしてもらう。
   *
   * ---
   *
   * **これが「同一文書IDに最新は1行」を支えている。**
   *
   * ここを通していると、次の順序で最新が2行できる（本番で再現した）。
   *
   *   Rev01 をファイル未登録のまま Rev02 へ Rev up
   *   → Rev02 のファイルを上げる（Rev02 が最新。Rev01 は一度も最新でないので旧版化されない）
   *   → あとから Rev01 のファイルを上げる（Rev01 も最新になる）
   *
   * 非同期Lambdaの段3は「自分より前」しか見ないため（後続を旧版に落とすのは
   * 逆方向の遷移になる）、この形は誰にも直せない。**入口で塞ぐのが正しい。**
   *
   * 同じ文書IDでもう一度 Rev 01 を作る経路は既に塞がっている
   * （numbering.ts の findBlockingRevision が削除済み以外の全リビジョンを見る）。
   * 最新から逆戻りする遷移も無い。よってここを閉じれば追い越しは起きない。
   *
   * どうしてもファイルを揃えられない場合は、論理削除して同じ番号で発行し直す
   * （CLAUDE.md §5。削除済みは重複チェックの対象外なので通る）。
   */
  if (current.status !== '最新') {
    return errorResponse(context.origin, 409, incompleteRevisionMessage(current));
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

/**
 * ファイルが揃っていないリビジョンからの Rev up を断るときの文言。
 *
 * **状態で書き分ける。** どちらも直し方は「足りないファイルを登録する」だが、
 * 「一部登録」のときは**どちらの種別が足りないか**まで言えるので言う。
 * 「ファイルを登録してください」とだけ返すと、PDF は上げたつもりの利用者が
 * 何をすればよいか分からない。
 *
 * 不足の判定に使うのは状態ではなく**S3キーの有無**（createUploadUrl.ts と同じ理由）。
 * 段1（キーの記録）から段2（状態の更新）までにわずかな隙があり、
 * どちらの種別が埋まっているかを知っているのはキーのほう。
 */
export function incompleteRevisionMessage(document: DocumentRecord): string {
  const missing = [
    document.s3KeyPdf === undefined ? 'PDF' : null,
    document.s3KeyExcel === undefined ? 'エクセル' : null,
  ].filter((label): label is string => label !== null);

  // 両方とも無い（＝ファイル未登録）
  if (missing.length === 2) {
    return 'このリビジョンにはまだファイルが登録されていません。PDFとエクセルを登録して「最新」にしてからリビジョンアップしてください';
  }

  // 片方だけ無い（＝一部登録）
  if (missing.length === 1) {
    return `このリビジョンは${missing[0]}が未登録です。登録して「最新」にしてからリビジョンアップしてください`;
  }

  /**
   * 両方揃っているのに「最新」でない。段1と段2の隙間に入った場合にここへ来る。
   * 少し待てば非同期Lambdaが「最新」にするので、やり直しを案内する。
   */
  return 'このリビジョンは登録処理中です。しばらく待ってからやり直してください';
}
