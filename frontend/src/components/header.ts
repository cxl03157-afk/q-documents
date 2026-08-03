/**
 * 共通ヘッダー（screens.md §3）。
 * 全画面で「今どちらの状態か」を常に見せる（解除し忘れ・解除したまま離席の両方を防ぐため）。
 *
 * ロック時は書き込み導線を出さないが、S-2 への入口だけは常設する。
 * これがないと生産技術の担当者が解除画面に到達できない。
 */

import { endSession, getSession } from '../auth/session';
import { escapeHtml } from '../lib/html';

export function renderHeader(): void {
  const el = document.querySelector<HTMLElement>('#app-header');
  if (!el) return;

  const session = getSession();
  el.innerHTML = session === null ? lockedHeader() : unlockedHeader(session.userName);

  el.querySelector<HTMLButtonElement>('#end-session')?.addEventListener('click', () => {
    endSession();
    location.hash = '#/';
  });
}

function lockedHeader(): string {
  return `
    <div class="header-bar">
      <span class="app-title">Q-documents</span>
      <a href="#/unlock" class="unlock-link">生産技術の方はこちら →</a>
    </div>
  `;
}

function unlockedHeader(userName: string): string {
  return `
    <div class="header-bar">
      <span class="app-title">Q-documents</span>
      <nav class="header-nav">
        <a href="#/documents/new" class="header-link">新規発行</a>
        <a href="#/masters" class="header-link">マスタ管理</a>
      </nav>
      <span class="header-user">${escapeHtml(userName)}（生産技術）</span>
      <button type="button" id="end-session" class="btn-end">終了</button>
    </div>
  `;
}
