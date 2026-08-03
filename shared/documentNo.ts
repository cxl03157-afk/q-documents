/**
 * 文書番号の生成とパース（CLAUDE.md §3・§4）。
 *
 * backend（採番・照合）と frontend（S-3 の番号プレビュー・S-4 の Rev 加算）の両方が使うため
 * shared に置く。片側で書き直すと採番規則が二重管理になる。
 *
 * TODO(8/8): Vitest で試験する（CLAUDE.md §12 が挙げているテスト対象の1つ）。
 */

import type { NumberingRule } from './types';

/** 新規発行時のリビジョン。2桁ゼロ埋め */
export const INITIAL_REVISION = '01';

export type DocumentNoParts = {
  /** 工程単位、製品単位を見分ける（工程単位、製品単位の２値のみとる） */
  numberingRule: NumberingRule;

  /** 文書種類コード（例: `Q001`）。工程単位では番号に現れない */
  documentType: string;

  productCode: string;

  /** 採番ルールが「工程単位」のときは必須 */
  processNo?: string;
  processName?: string;

  revision: string;
};

/**
 * 文書番号を組み立てる。
 *
 * - 製品単位: `文書種類_製品コード_Rev`      （例: `Q001_P-0001_01`）
 * - 工程単位: `製品コード_工程番号_工程名_Rev`（例: `P-0001_K001_工程1_01`）
 */
export function buildDocumentNo(parts: DocumentNoParts): string {
  const { numberingRule, documentType, productCode, processNo, processName, revision } = parts;

  if (numberingRule === '製品単位') {
    return `${documentType}_${productCode}_${revision}`;
  }

  // 呼び出し側が入力を検証してから呼ぶ前提。欠けたまま組み立てると
  // `P-0001__工程1_01` のような壊れた番号が台帳に入るため、ここで止める。
  if (processNo === undefined || processName === undefined) {
    throw new Error('工程単位の文書番号には工程番号と工程名が必要です');
  }
  return `${productCode}_${processNo}_${processName}_${revision}`;
}

/**
 * 文書番号を文書IDとリビジョンに分ける。
 *
 * **末尾の `_数字2桁` を切る方式**を採る（CLAUDE.md §4）。
 * `_` で分割して要素数から判定すると、工程名に `_` が入った瞬間に壊れる
 * （例: `P-0001_K001_組立_仮_02`）。末尾から切ればこのケースにも耐える。
 */
export function parseDocumentNo(
  documentNo: string,
): { documentId: string; revision: string } | null {
  const match = documentNo.match(/^(.+)_(\d{2})$/);
  if (match === null) return null;
  return { documentId: match[1]!, revision: match[2]! };
}

/** SK = `文書ID#リビジョン`（例: `Q001_P-0001#01`）。形式が不正なら null */
export function buildSortKey(documentNo: string): string | null {
  const parsed = parseDocumentNo(documentNo);
  if (parsed === null) return null;
  return `${parsed.documentId}#${parsed.revision}`;
}

/**
 * リビジョンを1つ進める。2桁ゼロ埋めを保つ（`'01'` → `'02'`）。
 * Rev 99 を超えると3桁になるが、桁を固定して 99 で止めるより実害が小さいのでそのままにする。
 */
export function nextRevision(revision: string): string {
  const current = Number(revision);
  if (!Number.isInteger(current) || current < 0) {
    throw new Error(`リビジョンの形式が不正です: ${revision}`);
  }
  return String(current + 1).padStart(2, '0');
}
