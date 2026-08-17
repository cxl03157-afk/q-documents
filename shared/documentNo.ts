/**
 * 文書番号の生成とパース（CLAUDE.md §3・§4）。
 *
 * backend（採番・照合）と frontend（S-3 の番号プレビュー・S-4 の Rev 加算）の両方が使うため
 * shared に置く。片側で書き直すと採番規則が二重管理になる。
 *
 * 試験は `documentNo.test.ts`（CLAUDE.md §12 が挙げているテスト対象の1つ）。
 * 工程名に `_` を含むケースを重点的に置いてある — 末尾から切るパース方式を
 * 選んだ理由がそれで、壊すと**その工程の文書だけが後から扱えなくなる**。
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
 * 同じ文書IDの全リビジョンを引くための SK の前方一致条件。
 *
 * **`#` を必ず含める。** 含めないと前方一致が別の文書まで拾う。
 *
 *   `P-0001_K001_工程1`  で照会したとき
 *     `P-0001_K001_工程1#01`   ← 引きたいもの
 *     `P-0001_K001_工程10#01`  ← 工程名が前方一致するだけの別文書
 *
 * `#` は SK の結合専用で工程名には含められない（CLAUDE.md §4）ため、
 * これを付ければ文書IDの終わりが確定する。
 *
 * 採番の重複チェックがこの条件で引いた結果を数えるので、混ざると
 * 「別の工程の文書があるから発行できない」という誤った拒否になる。
 */
export function revisionPrefix(documentId: string): string {
  return `${documentId}#`;
}

/**
 * リビジョンを1つ進める。2桁ゼロ埋めを保つ（`'01'` → `'02'`）。
 *
 * **リビジョンは2桁で収まる前提**（CLAUDE.md §3）。品質文書が99回改訂される
 * 想定は取っていない。
 *
 * 上限は設けていないが、**Rev 99 の次は無事では済まない**。`padStart(2, '0')` は
 * 3桁をそのまま返し、`parseDocumentNo` の `/^(.+)_(\d{2})$/` は3桁に一致しないため、
 * `Q001_P-0001_100` はパースできない文書番号になる（＝以後その文書は改訂も
 * アップロードもできない）。**桁数を増やすなら台帳の既存レコードも含めた移行が要る**ので、
 * 手前で止めるより「そこまで行かない」前提を文書に書いて運用する側に倒してある。
 */
export function nextRevision(revision: string): string {
  const current = Number(revision);
  if (!Number.isInteger(current) || current < 0) {
    throw new Error(`リビジョンの形式が不正です: ${revision}`);
  }
  return String(current + 1).padStart(2, '0');
}
