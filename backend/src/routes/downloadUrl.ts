/**
 * GET /documents/{docNo}/download-url — 閲覧・ダウンロード用の署名付きURL発行（F-09 / F-11 / F-18 / docs/API.md）。
 *
 * **合言葉の要否はファイル種別と台帳の状態だけで決まる。** 「閲覧」か「ダウンロード」か
 * （`disposition`）では変わらない — 守るべきものは同じで、S3への応答ヘッダーの指定が
 * 違うだけだから（backend/src/s3.ts）。
 *
 * `auth: 'conditional'` にしているのは、`GET /documents` と違って
 * 「トークンが無ければ一律で何かを隠す」ではなく、**このハンドラ自身が
 * ファイル種別と状態を見てから401を判断する**ため（最新版PDFだけトークン不要）。
 */

import type { APIGatewayProxyResult } from 'aws-lambda';
import { buildSortKey } from '../../../shared/documentNo';
import type { DocumentRecord } from '../../../shared/types';
import { errorResponse, jsonResponse } from '../http';
import { getDocument } from '../ledger';
import { createDownloadUrl, DOWNLOAD_URL_TTL_SECONDS, type DownloadDisposition } from '../s3';
import type { FileType } from '../s3Key';
import type { MaybeAuthedContext } from './context';

export async function getDownloadUrl(context: MaybeAuthedContext): Promise<APIGatewayProxyResult> {
  const documentNo = context.params.docNo ?? '';
  const productCode = context.query.productCode ?? '';

  const fileTypeParam = context.query.fileType;
  const fileType: FileType | null =
    fileTypeParam === 'pdf' || fileTypeParam === 'excel' ? fileTypeParam : null;

  const dispositionParam = context.query.disposition;
  const disposition: DownloadDisposition | null =
    dispositionParam === 'inline' || dispositionParam === 'attachment' ? dispositionParam : null;

  if (productCode === '' || fileType === null || disposition === null) {
    return errorResponse(context.origin, 400, 'リクエストの形式が正しくありません');
  }

  const sortKey = buildSortKey(documentNo);
  if (sortKey === null) {
    return errorResponse(context.origin, 400, '文書番号の形式が正しくありません');
  }

  const document = await getDocument(productCode, sortKey);
  if (document === undefined || document.documentNo !== documentNo) {
    return errorResponse(context.origin, 404, 'この文書番号は台帳に登録されていません');
  }

  const decision = resolveDownload(document, fileType);
  if (!decision.ok) {
    return errorResponse(context.origin, decision.status, decision.message);
  }

  if (decision.requiresToken) {
    if (context.identity === null) {
      return errorResponse(context.origin, 401, 'この操作には合言葉での解除が必要です');
    }

    // エクセル・旧版・削除済みの取得を記録する（CLAUDE.md §8-7）。
    // 「発行した」であって「ダウンロードされた」ではない — URLを取得したあと
    // 実際に転送されたかはサーバー側から確認できないため、名前で言い切りすぎない
    // （createUploadUrl.ts の 'upload url issued' と表現を揃える）。
    console.log(
      JSON.stringify({
        message: 'download url issued',
        userName: context.identity.userName,
        documentNo,
        fileType,
        status: document.status,
      }),
    );
  }

  const url = await createDownloadUrl(decision.key, documentNo, fileType, disposition);
  return jsonResponse(context.origin, 200, { url, expiresInSeconds: DOWNLOAD_URL_TTL_SECONDS });
}

type DownloadDecision =
  | { ok: true; key: string; requiresToken: boolean }
  | { ok: false; status: number; message: string };

/**
 * 台帳の状態から見た可否（screens.md S-1 の表 / docs/API.md 補足）。
 *
 * **判断はまず状態、次にS3キーの有無。** `rejectionReason`（createUploadUrl.ts）と
 * 同じ順序にしている。ファイル未登録・一部登録では該当ファイルがそもそも無いので、
 * 「登録されていません」で止める（状態だけでは片方だけ埋まっているケースを見誤る）。
 */
export function resolveDownload(document: DocumentRecord, fileType: FileType): DownloadDecision {
  /**
   * 削除済みのPDFは、トークンの有無によらず断る。
   *
   * screens.md では「解除時でもPDFボタンを出さない」（配布物なので、消した版を現場に出さない）
   * としているが、これは画面側の制御にすぎない。CLAUDE.md §7「サーバー側の検証を省略しない」に
   * 沿って、API直叩きでも同じ結論になるようここで止める（8/12 の実装ゲートで確定）。
   * エクセルは万一の確認用に、トークンがあれば引き続き取得できる。
   */
  if (fileType === 'pdf' && document.status === '削除済み') {
    return { ok: false, status: 403, message: '削除済みの文書のPDFは取得できません' };
  }

  const key = fileType === 'pdf' ? document.s3KeyPdf : document.s3KeyExcel;
  if (key === undefined) {
    return { ok: false, status: 404, message: 'このファイルはまだ登録されていません' };
  }

  // 最新版PDFだけトークン不要（docs/API.md 補足：合言葉による制御について）
  const requiresToken = !(fileType === 'pdf' && document.status === '最新');

  return { ok: true, key, requiresToken };
}
