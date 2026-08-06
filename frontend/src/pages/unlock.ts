/**
 * S-2 生産技術モード解除（screens.md §5）。
 *
 * 氏名を記録し、合言葉を検証して書き込み・エクセル閲覧を解放する。
 * 週2で `POST /auth/unlock` に接続する（今は mock/unlock.ts と照合している）。
 */

import { isUnlocked, startSession } from '../auth/session';
import { escapeHtml } from '../lib/html';
import { mockMasters } from '../mock/masters';
import { mockUnlock } from '../mock/unlock';

export function renderUnlock(): void {
  const app = document.querySelector<HTMLElement>('#app');
  if (!app) return;

  // 解除中にこの画面を開いても用がない（終了はヘッダーの[終了]で行う）。
  // 解除中に解除画面が開いていると、今どちらの状態かが紛らわしくなる。
  if (isUnlocked()) {
    location.hash = '#/';
    return;
  }

  app.innerHTML = template();
  bindEvents(app);
}

function template(): string {
  return `
    <h1>生産技術モードの解除</h1>
    <form id="unlock-form" class="unlock-form">
      <label class="form-field">
        <span>氏名</span>
        <select name="userName" required>
          <option value="">選択してください</option>
          ${ownerOptions()}
        </select>
      </label>
      <label class="form-field">
        <span>合言葉</span>
        <input type="password" name="passphrase" required autocomplete="off" />
      </label>
      <p id="unlock-error" class="form-error" role="alert"></p>
      <button type="submit" class="btn-primary">解除</button>
    </form>
  `;
}

/** 担当者マスタに登録するのは生産技術の担当者のみ（screens.md S-6） */
function ownerOptions(): string {
  return mockMasters
    .filter((m) => m.category === '担当者' && m.status === '有効')
    .map((m) => `<option value="${escapeHtml(m.name)}">${escapeHtml(m.name)}</option>`)
    .join('');
}

function bindEvents(app: HTMLElement): void {
  const form = app.querySelector<HTMLFormElement>('#unlock-form');
  if (!form) return;

  form.addEventListener('submit', (event) => {
    event.preventDefault();

    const userName = fieldValue(form, 'userName');
    const passphrase = fieldValue(form, 'passphrase');
    const result = mockUnlock(userName, passphrase);

    if (result.ok) {
      startSession(userName, result.token);
      location.hash = '#/';
      return;
    }

    showError(app, form);
  });
}

function fieldValue(form: HTMLFormElement, name: string): string {
  const el = form.elements.namedItem(name);
  if (el instanceof HTMLSelectElement || el instanceof HTMLInputElement) {
    return el.value;
  }
  return '';
}

/**
 * どちらが誤りかは示さない（screens.md S-2）。
 * 氏名の当たりを教えると総当たりの手がかりになる。
 */
function showError(app: HTMLElement, form: HTMLFormElement): void {
  const error = app.querySelector<HTMLElement>('#unlock-error');
  if (error) error.textContent = '氏名または合言葉が違います';

  const passphrase = form.elements.namedItem('passphrase');
  if (passphrase instanceof HTMLInputElement) {
    passphrase.value = '';
    passphrase.focus();
  }
}
