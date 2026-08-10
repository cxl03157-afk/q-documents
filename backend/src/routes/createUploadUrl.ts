/**
 * POST /documents/{docNo}/upload-url — アップロード用の署名付きURL発行（F-01 / F-09 / docs/API.md）。
 *
 * ファイル名の検証と台帳照合を行い、**すべて通ったときだけ**URLを発行する。
 * 1つでも満たさなければURLを出さない（docs/API.md「upload-url のファイル名検証」）。
 *
 * **ここが最後の砦。** 画面側にも同じ検証があるが、開発者ツールから直接呼べる以上、
 * 通してしまえば壊れたデータがそのまま S3 と台帳に入る（CLAUDE.md §7）。
 *
 * **状態は書き換えない。** 台帳が変わるのは実体が S3 に置かれたあと、
 * S3イベントで起動する非同期Lambdaによってだけ（CLAUDE.md §5・§7）。
 * このエンドポイントが成功しても、利用者がアップロードをやめれば台帳は元のまま。
 */

import type { APIGatewayProxyResult } from 'aws-lambda';
import { buildSortKey } from '../../../shared/documentNo';
import { validateUploadFileNames } from '../../../shared/uploadFiles';
import type { DocumentRecord } from '../../../shared/types';
import { errorResponse, jsonResponse } from '../http';
import { getDocument } from '../ledger';
import { buildS3Key, type FileType } from '../s3Key';
import { createUploadTarget, UPLOAD_URL_TTL_SECONDS, type PresignedUpload } from '../s3';
import { optionalString, parseJsonObject, requiredString } from '../validate';
import type { AuthedContext } from './context';

export async function postUploadUrl(context: AuthedContext): Promise<APIGatewayProxyResult> {
  const documentNo = context.params.docNo ?? '';

  const source = parseJsonObject(context.body);
  if (source === null) {
    return errorResponse(context.origin, 400, 'リクエストの形式が正しくありません');
  }

  /**
   * `productCode` を受け取るのは GetItem に PK が要るため（createRevision.ts と同じ理由）。
   * 誤った製品コードを送られても危険はない。キーが合わなければ何も引けず 404 になる。
   */
  const productCode = requiredString(source, 'productCode');
  if (productCode === null) {
    return errorResponse(context.origin, 400, 'リクエストの形式が正しくありません');
  }

  // 片方だけのアップロードを許すので、どちらも任意（要件定義書 F-01）
  const pdfName = optionalString(source, 'pdfName');
  const excelName = optionalString(source, 'excelName');
  if (pdfName === null || excelName === null) {
    return errorResponse(context.origin, 400, 'ファイル名の形式が正しくありません');
  }

  /**
   * ファイル名の検証（docs/API.md の 1〜5）。台帳を引く前に行う。
   *
   * `errors` を添えて返すのは、2つとも間違えているときに選び直しを2回させないため
   * （画面は一覧で表示する）。`message` には先頭の1件を入れて、
   * 他のエラー応答と形をそろえる。
   */
  const errors = validateUploadFileNames(documentNo, { pdfName, excelName });
  if (errors.length > 0) {
    return errorResponse(context.origin, 400, errors[0]!, { errors });
  }

  const sortKey = buildSortKey(documentNo);
  if (sortKey === null) {
    return errorResponse(context.origin, 400, '文書番号の形式が正しくありません');
  }

  // 台帳照合（docs/API.md の 6 / F-01）
  const document = await getDocument(productCode, sortKey);
  if (document === undefined || document.documentNo !== documentNo) {
    return errorResponse(context.origin, 404, 'この文書番号は台帳に登録されていません');
  }

  const rejection = rejectionReason(document, { pdfName, excelName });
  if (rejection !== null) {
    return errorResponse(context.origin, 409, rejection);
  }

  /**
   * ここまで通ってはじめてURLを出す。
   *
   * **キーは文書番号から組み立てる。ファイル名は使わない。**
   * 拡張子の大文字小文字を許容している（`Q001_P-0001_01.PDF`）ので、
   * ファイル名をそのままキーにすると同じ文書に2種類のキーができる。
   */
  const requested: FileType[] = [];
  if (pdfName !== undefined) requested.push('pdf');
  if (excelName !== undefined) requested.push('excel');

  const targets = await Promise.all(
    requested.map((fileType) =>
      createUploadTarget(buildS3Key(productCode, documentNo, fileType), fileType),
    ),
  );

  const issued: Partial<Record<FileType, PresignedUpload>> = {};
  requested.forEach((fileType, index) => {
    issued[fileType] = targets[index]!;
  });

  /**
   * 誰が何のURLを取ったかを記録する。
   *
   * CLAUDE.md §8-7 が求めているのはエクセル・旧版の**取得**時の記録だが、
   * 書き込み側も残す。実体が入れ替わったときに、台帳の更新（非同期Lambdaのログ）だけでは
   * 「誰がその操作を始めたか」までは辿れないため。
   */
  console.log(
    JSON.stringify({
      message: 'upload url issued',
      documentNo,
      fileTypes: requested,
      operator: context.identity.userName,
    }),
  );

  return jsonResponse(context.origin, 200, {
    ...issued,
    expiresInSeconds: UPLOAD_URL_TTL_SECONDS,
  });
}

/**
 * 台帳の状態から見た拒否理由（screens.md S-5 の「エラー表示」）。問題なければ `null`。
 *
 * **登録済みの種別は再登録できない。** 未登録の種別だけを後から足せる
 * （要件定義書 F-01）。画面はそもそも登録済みの欄を出さないが、
 * ここを省くと直接呼び出しで**既に登録されているファイルを差し替えられる**。
 * 差し替えられると、配布済みのPDFと中身の違うものが同じ文書番号で存在することになる。
 *
 * 判断に使うのは状態ではなく**S3キーの有無**。段1（キーの記録）から
 * 段2（状態の更新）までにわずかな隙があり、その間は「キーはあるのに
 * 状態はファイル未登録」に見える。どちらの種別が埋まっているかを知っているのはキーのほう。
 */
function rejectionReason(document: DocumentRecord, files: UploadRequest): string | null {
  if (document.status === '旧版') {
    return 'このリビジョンは旧版です。最新のリビジョンにアップロードしてください';
  }

  /**
   * 削除済みへのアップロードも塞ぐ。
   *
   * screens.md S-5 の拒否理由3つには挙がっていないが、通すと消した版の実体が S3 に入る。
   * 論理削除は取り消せず、復旧手段は同じ番号での発行し直し（CLAUDE.md §5）。
   */
  if (document.status === '削除済み') {
    return 'この文書は削除済みです。新規発行でやり直してください';
  }

  const pdfTaken = files.pdfName !== undefined && document.s3KeyPdf !== undefined;
  const excelTaken = files.excelName !== undefined && document.s3KeyExcel !== undefined;

  if (pdfTaken && excelTaken) {
    return 'このリビジョンのPDFとエクセルは既に登録されています';
  }
  if (pdfTaken) {
    return 'このリビジョンのPDFは既に登録されています';
  }
  if (excelTaken) {
    return 'このリビジョンのエクセルは既に登録されています';
  }

  return null;
}

type UploadRequest = {
  pdfName?: string;
  excelName?: string;
};
