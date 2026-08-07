/**
 * CSV への変換とダウンロード（F-08）。
 *
 * 変換は純粋関数にしてある。画面を経由せずに正しさを確かめられるようにするため
 * （CLAUDE.md §12「最も間違えやすい純粋関数に絞ってテストする」に近い性質）。
 */

/**
 * 1セル分のエスケープ。
 *
 * 工程名などは自由入力なので、カンマが入ると列がずれる。
 * 引用符で囲む必要があるのは カンマ・引用符・改行 を含む場合で、
 * 引用符自体は2つ重ねて表す（RFC 4180）。
 */
function escapeCell(value: string): string {
  if (!/[",\r\n]/.test(value)) return value;
  return `"${value.replace(/"/g, '""')}"`;
}

/** ヘッダー行 + データ行を CSV 文字列にする */
export function toCsv(headers: string[], rows: string[][]): string {
  return [headers, ...rows].map((row) => row.map(escapeCell).join(',')).join('\r\n');
}

/**
 * CSV をダウンロードさせる。
 *
 * **先頭に BOM を付ける。** BOM がないと、日本語を含むCSVを Excel で開いたときに
 * 文字化けする。利用者は現場の担当者で、ダブルクリックで開けないと使えない。
 */
export function downloadCsv(fileName: string, csv: string): void {
  const blob = new Blob([`﻿${csv}`], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);

  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.click();

  // 解放しないとページを開いている間ずっとメモリに残る
  URL.revokeObjectURL(url);
}
