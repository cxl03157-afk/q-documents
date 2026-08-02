/** innerHTML に差し込む前のエスケープ。台帳データはいずれAPI経由の値になるため、今のうちに徹底する。 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
