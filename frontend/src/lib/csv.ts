/**
 * CSV への変換とダウンロード（F-08）。
 *
 * 変換は純粋関数にしてある。画面を経由せずに正しさを確かめられるようにするため
 * （CLAUDE.md §12「最も間違えやすい純粋関数に絞ってテストする」に近い性質）。
 */

/**
 * Excel が数式として解釈する先頭文字。
 *
 * 工程名に `-組立` のような値が入ると、Excel は数式とみなして `#NAME?` を表示する。
 * **帳票として読めなくなる**ので、そのまま出さない。
 */
const FORMULA_PREFIX = /^[=+\-@]/;

/**
 * 1セル分のエスケープ。**テストのために公開している**（CLAUDE.md §12）。
 *
 * 工程名などは自由入力なので、カンマが入ると列がずれる。
 * 引用符で囲む必要があるのは カンマ・引用符・改行 を含む場合で、
 * 引用符自体は2つ重ねて表す（RFC 4180）。
 *
 * ---
 *
 * **数式として解釈される値は先頭に `'` を付けて中和する。**
 *
 * これは悪意の有無とは関係がない。`-組立` のような普通の工程名でも
 * Excel は数式として読み、セルに `#NAME?` と出る（値が消えたように見える）。
 * `'` は Excel が「以降は文字列」と解釈するための標準的な目印で、
 * **版によっては `'` がそのまま見えることがある**が、対象はもともと
 * `#NAME?` になっていたセルだけなので、読めない状態よりは良いと判断した。
 *
 * 引用符でくくる判定は `'` を付けた**後**の文字列に対して行う。
 * 先に判定すると、中和で足した文字がくくりの外に出て列がずれる。
 */
export function escapeCell(value: string): string {
  const neutralized = FORMULA_PREFIX.test(value) ? `'${value}` : value;

  if (!/[",\r\n]/.test(neutralized)) return neutralized;
  return `"${neutralized.replace(/"/g, '""')}"`;
}

/** ヘッダー行 + データ行を CSV 文字列にする */
export function toCsv(headers: string[], rows: string[][]): string {
  return [headers, ...rows].map((row) => row.map(escapeCell).join(',')).join('\r\n');
}

/**
 * Blob URL を解放するまでの待ち時間。
 *
 * `click()` はダウンロードの開始を予約するだけで、その場で読み終えるわけではない。
 * 同期で解放すると、ブラウザが Blob を読みにいく前に URL が無効になり、
 * **何も起きない**（エラーも出ない）。ダウンロードが始まるだけの猶予を置く。
 */
const REVOKE_DELAY_MS = 1000;

/**
 * CSV をダウンロードさせる。
 *
 * **先頭に BOM を付ける。** BOM がないと、日本語を含むCSVを Excel で開いたときに
 * 文字化けする。利用者は現場の担当者で、ダブルクリックで開けないと使えない。
 *
 * **`<a>` は文書に入れてから click する。** 文書に繋がっていない要素の click を
 * 無視するブラウザがあり、その場合も無言で何も起きない
 * （`documentList.ts` の `triggerDownload` と同じ形）。
 */
export function downloadCsv(fileName: string, csv: string): void {
  const blob = new Blob([`﻿${csv}`], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);

  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();

  // 解放しないとページを開いている間ずっとメモリに残る
  setTimeout(() => URL.revokeObjectURL(url), REVOKE_DELAY_MS);
}
