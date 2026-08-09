/**
 * S3イベントで起動する非同期Lambdaの代役（API.md「ファイルアップロード後の非同期処理」）。
 *
 * **状態を書き換えてよいのはこの層だけ**（CLAUDE.md §5）。
 * 画面（S-5）は「アップロードした」と伝えるだけで、状態には触らない。
 * モックだからと画面側で「最新」にしてしまうと、責務分担が崩れたまま週3の実装に入ることになる。
 *
 * 週3で本物の Lambda に置き換わり、このファイルは消える。
 */

import { allDocuments } from '../lib/store';
import { parseDocumentNo } from '../../../shared/documentNo';

/** 台帳への反映を待つ時間。PUT直後は「ファイル未登録」のままである挙動を再現する */
const REFLECT_DELAY_MS = 1500;

/**
 * PDF・エクセルの両方がS3に置かれたことにして、台帳へ反映する。
 *
 * 1. S3キーを記録する
 * 2. 両方揃ったので状態を「最新」にする
 * 3. 同一文書IDの前リビジョンを「旧版」にする（F-04）
 */
export function reflectUploadLikeLambda(
  documentNo: string,
  files: { pdfName: string; excelName: string },
  onReflected: () => void,
): void {
  window.setTimeout(() => {
    const doc = allDocuments().find((d) => d.documentNo === documentNo);
    if (doc === undefined) return;

    doc.s3KeyPdf = files.pdfName;
    doc.s3KeyExcel = files.excelName;
    doc.status = '最新';

    archivePreviousRevisions(doc.documentNo);
    onReflected();
  }, REFLECT_DELAY_MS);
}

/** 同一文書IDで、今回より前のリビジョンの「最新」を「旧版」に落とす */
function archivePreviousRevisions(documentNo: string): void {
  const parsed = parseDocumentNo(documentNo);
  if (parsed === null) return;

  for (const doc of allDocuments()) {
    const other = parseDocumentNo(doc.documentNo);
    if (other === null) continue;

    if (
      other.documentId === parsed.documentId &&
      other.revision < parsed.revision &&
      doc.status === '最新'
    ) {
      doc.status = '旧版';
    }
  }
}
