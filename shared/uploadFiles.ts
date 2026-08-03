/**
 * アップロードするファイル名の検証（screens.md S-5 の表 1〜5／API.md「upload-url のファイル名検証」）。
 *
 * **画面側とサーバー側の両方で行う検証なので shared に置く**（CLAUDE.md §7）。
 * 画面側は誤りを早く知らせるため、サーバー側は画面の制御を回避されても壊れたデータを
 * 作らせないため。どちらか片方に書くと、必ず片方だけ直されてずれる。
 *
 * ここで止めそこねると、S3の `.xlsx` キーにPDFの実体が入ったまま非同期Lambdaが
 * 「両方揃った」と判断して「最新」にする。台帳上は正常に見えるため、
 * 後日エクセルを開くまで誤りに気づけない。
 */

import { parseDocumentNo } from './documentNo';

export type UploadFileNames = {
  pdfName: string;
  excelName: string;
};

/** 拡張子は大文字小文字を区別しない（CLAUDE.md §3） */
function hasExtension(fileName: string, extension: string): boolean {
  return fileName.toLowerCase().endsWith(extension);
}

/** ファイル名 = 文書番号 + 拡張子。末尾の拡張子だけを落とす */
function stripExtension(fileName: string): string {
  const dot = fileName.lastIndexOf('.');
  return dot === -1 ? fileName : fileName.slice(0, dot);
}

/**
 * 検証結果をエラーメッセージの配列で返す。空配列なら合格。
 * 最初の1件で打ち切らないのは、2つとも間違えている場合に選び直しを2回させないため。
 */
export function validateUploadFileNames(documentNo: string, files: UploadFileNames): string[] {
  const errors: string[] = [];

  // 1・2: 欄と拡張子の対応
  if (!hasExtension(files.pdfName, '.pdf')) {
    errors.push('PDF欄にはPDFファイルを選択してください');
  }
  if (!hasExtension(files.excelName, '.xlsx')) {
    errors.push('エクセル欄にはエクセルファイルを選択してください');
  }

  const pdfNo = stripExtension(files.pdfName);
  const excelNo = stripExtension(files.excelName);

  // 3: 2つのファイルが同じ文書のものか
  if (pdfNo !== excelNo) {
    errors.push('2つのファイルの文書番号が一致しません');
  }

  // 4: 対象の文書のものか（別の文書のファイルを混ぜていないか）
  if (pdfNo !== documentNo || excelNo !== documentNo) {
    errors.push('ファイル名の文書番号が対象の文書と異なります');
  }

  // 5: 命名ルールの形式（`../` や `/` を含む名前をここで弾く。パストラバーサル対策も兼ねる）
  if (parseDocumentNo(pdfNo) === null || pdfNo.includes('/') || pdfNo.includes('#')) {
    errors.push('ファイル名が命名ルールに従っていません');
  }

  return errors;
}
