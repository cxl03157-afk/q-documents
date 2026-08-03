/**
 * ②以降で作る画面（S-2〜S-7）の仮ページ。
 *
 * ロック中の直叩き防御（guard.ts）は、ルートが登録されていないと
 * ルータの「未知のハッシュは一覧へ」に先に吸われて検証できない。
 * 動作を確かめられない土台を残さないために、先にルートだけ通しておく。
 * 各画面の実装時にこの呼び出しを差し替える。
 */

import { escapeHtml } from '../lib/html';

export function renderPlaceholder(title: string, docNo?: string): void {
  const app = document.querySelector<HTMLElement>('#app');
  if (!app) return;

  const target = docNo === undefined ? '' : `<p>対象の文書番号: ${escapeHtml(docNo)}</p>`;

  app.innerHTML = `
    <h1>${escapeHtml(title)}</h1>
    <p class="placeholder">この画面はまだ実装していません（モック作成中）。</p>
    ${target}
    <p><a href="#/">一覧へ戻る</a></p>
  `;
}
