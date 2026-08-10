/**
 * S3 のオブジェクトキーの組み立てと分解。
 *
 *   {製品コード}/{文書番号}.pdf    例: P-0001/Q001_P-0001_01.pdf
 *   {製品コード}/{文書番号}.xlsx   例: P-0001/P-0001_K001_工程1_01.xlsx
 *
 * 同期API（署名付きURLの発行）と非同期Lambda（S3イベントの処理）の両方が使う。
 * **shared には置かない。** 画面はキーを組み立てない — 実体をどこに置くかはサーバーが決めることで、
 * 画面に決めさせると「画面が指定した場所」に実体が入る余地ができる。
 *
 * ---
 *
 * **製品コードを先頭に置くのは、非同期Lambdaが台帳のPK（製品コード）を知る必要があるため。**
 *
 * 文書番号だけからは切り出せない。`Q001_P-0001_01` は
 *   製品単位として読めば 製品コード = `P-0001`
 *   工程単位として読めば 製品コード = `Q001`
 * となり、番号だけでは区別が付かない（採番ルールは文書種類マスタが持っている）。
 * SK のほうは末尾の `_数字2桁` を切る `buildSortKey` で導けるので、キーだけで PK と SK が揃う。
 *
 * **最初の `/` で必ず正しく割れる。** `#` と `/` は製品コードにも工程名にも入らない
 * （`POST /masters`・`PATCH /masters/{id}` が弾いている。CLAUDE.md §4）。
 */

/** 台帳の `s3KeyPdf` / `s3KeyExcel` に対応する2種別。CLAUDE.md §3 が許容する拡張子もこの2つだけ */
export type FileType = 'pdf' | 'excel';

export const FILE_TYPES: readonly FileType[] = ['pdf', 'excel'];

/**
 * 種別ごとの拡張子。**小文字で固定する。**
 *
 * 画面が選んだファイル名の拡張子は大文字でもよい（`Q001_P-0001_01.PDF` を許容する。
 * CLAUDE.md §3）が、キーは**ファイル名ではなく文書番号から組み立てる**ので、
 * 実体が置かれる場所は常にこの形になる。`.PDF` と `.pdf` の2つのキーができることはない。
 */
const EXTENSION: Record<FileType, string> = {
  pdf: '.pdf',
  excel: '.xlsx',
};

/**
 * 署名条件に入れる Content-Type（CLAUDE.md §8-4）。
 *
 * **ブラウザの `File.type` は使わず、この固定値を使う。**
 * `File.type` は結局のところ拡張子から決まるので、PDFを `.xlsx` に改名されたら
 * 同じ値になり検出力が増えない。一方で `.xlsx` の `File.type` が空文字になる環境があり、
 * そこだけ署名条件を満たせず 403 になる。得るものが無く、落ちる経路だけが増える。
 *
 * 中身と拡張子の食い違いを見るのは F-19（ファイル内容の検証・ストレッチ・未着手）の仕事。
 * ここで担保しているのは「エクセル用に発行したURLは、Content-Type がエクセルの
 * オブジェクトしか作れない」ということ。
 */
export const CONTENT_TYPE: Record<FileType, string> = {
  pdf: 'application/pdf',
  excel: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

/**
 * キーを組み立てる。
 *
 * `/` が混ざったら投げる。呼び出し側（`validateUploadFileNames` と マスタ登録時の検証）で
 * 既に弾いているはずの値だが、すり抜けると**想定より深い階層に実体が入り、
 * 非同期Lambdaがそのイベントを解釈できずに黙って捨てる**。台帳にキーが記録されないまま
 * 実体だけがS3に残るので、気づく手段がない。
 */
export function buildS3Key(productCode: string, documentNo: string, fileType: FileType): string {
  if (productCode.includes('/') || documentNo.includes('/')) {
    throw new Error('S3キーに `/` は使えません');
  }
  if (productCode === '' || documentNo === '') {
    throw new Error('S3キーの組み立てに必要な値が空です');
  }
  return `${productCode}/${documentNo}${EXTENSION[fileType]}`;
}

export type ParsedS3Key = {
  productCode: string;
  documentNo: string;
  fileType: FileType;
};

/**
 * キーを製品コード・文書番号・種別に分ける。想定の形でなければ `null`。
 *
 * **想定外のキーは推測せずに `null` を返す。** このバケットに書けるのは
 * 同期APIが発行した署名付きURL（キーを署名条件で固定してある）と、
 * 非同期Lambda自身の `CopyObject` だけなので、想定外の形が現れたということは
 * 何かが想定と違っている。そこで頑張って解釈するより、記録を残して何もしないほうがよい。
 */
export function parseS3Key(key: string): ParsedS3Key | null {
  const separator = key.indexOf('/');

  // 先頭が `/` の場合（製品コードが空）もここで落ちる
  if (separator <= 0) return null;

  const productCode = key.slice(0, separator);
  const fileName = key.slice(separator + 1);

  // 想定より深い階層。`製品コード/文書番号.拡張子` の2段だけを扱う
  if (fileName.includes('/')) return null;

  for (const fileType of FILE_TYPES) {
    const extension = EXTENSION[fileType];
    if (!fileName.endsWith(extension)) continue;

    const documentNo = fileName.slice(0, -extension.length);
    if (documentNo === '') return null;

    return { productCode, documentNo, fileType };
  }

  return null;
}

/**
 * S3イベントが渡してくるキーを元に戻す。
 *
 * **イベントの `object.key` は URL エンコードされている。** しかも
 * `encodeURIComponent` そのものではなく **`application/x-www-form-urlencoded` 相当**で、
 * **空白が `+` になる**。工程名に日本語が入るので、この処理を忘れると
 * `P-0001/P-0001_K001_%E5%B7%A5%E7%A8%8B1_01.pdf` のまま台帳を引きに行き、
 * 「台帳に無い」として全件が黙って捨てられる。
 *
 * `+` を先に空白へ直してよいのは、キーに元から `+` が含まれる場合は `%2B` で届くため。
 * 置換後も `%2B` のまま残り、デコードで `+` に戻る。
 *
 * 壊れたパーセント記号は `decodeURIComponent` が投げるので `null` にする。
 */
export function decodeS3EventKey(rawKey: string): string | null {
  try {
    return decodeURIComponent(rawKey.replace(/\+/g, ' '));
  } catch {
    return null;
  }
}
