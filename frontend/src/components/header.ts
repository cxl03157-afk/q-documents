/**
 * 共通ヘッダー（screens.md §3）。
 * 全画面で「今どちらの状態か」を常に見せる（解除し忘れ・解除したまま離席の両方を防ぐため）。
 *
 * 今日（8/1）はロック時の表示のみ実装する。解除時の表示（[新規発行][マスタ管理]・氏名・[終了]）は
 * ロック/解除の状態管理とあわせて 8/2 に実装する。
 */

import { isUnlocked } from '../auth/session';

export function renderHeader(): void {
  const el = document.querySelector<HTMLElement>('#app-header');
  if (!el) return;

  el.innerHTML = isUnlocked() ? renderUnlockedHeader() : renderLockedHeader();
}

function renderLockedHeader(): string {
  return `
    <div class="header-bar">
      <span class="app-title">Q-documents</span>
      <a href="#/unlock" class="unlock-link">生産技術の方はこちら →</a>
    </div>
  `;
}

function renderUnlockedHeader(): string {
  // TODO(8/2): 氏名表示・[新規発行][マスタ管理]・[終了] を実装する
  return renderLockedHeader();
}
