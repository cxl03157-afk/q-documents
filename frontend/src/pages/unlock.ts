/**
 * S-2 生産技術モード解除（screens.md §5）。
 *
 * 氏名を記録し、合言葉を検証して書き込み・エクセル閲覧を解放する。
 *
 * **検証はサーバーが正**（CLAUDE.md §7）。この画面は入力を集めて送るだけで、
 * 合言葉と照合するコードをここには持たない。
 *
 * 氏名の選択肢はまだモックのマスタから作っている。`GET /masters` の接続は F-10 で行う。
 */

import { isUnlocked, startSession } from '../auth/session';
import { apiPost } from '../lib/api';
import { escapeHtml } from '../lib/html';
import { mockMasters } from '../mock/masters';

/** POST /auth/unlock の成功応答（docs/API.md） */
type UnlockResponse = { token: string; expiresAt: string };

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

  const submit = form.querySelector<HTMLButtonElement>('button[type="submit"]');

  form.addEventListener('submit', (event) => {
    event.preventDefault();

    const userName = fieldValue(form, 'userName');
    const passphrase = fieldValue(form, 'passphrase');

    // 応答を待つ間にもう一度押せると、同じ解除が二重に走る
    setSubmitting(submit, true);
    clearError(app);

    void apiPost<UnlockResponse>('/auth/unlock', { userName, passphrase })
      .then((result) => {
        if (result.ok) {
          startSession(userName, result.data.token, Date.parse(result.data.expiresAt));
          location.hash = '#/';
          return;
        }

        /**
         * 401 と、それ以外を分ける。
         *
         * 通信断のときに「合言葉が違います」と出すと、利用者は合言葉を疑って
         * 何度も打ち直す。原因の違うものを同じ文言にしない。
         * **401 のときだけは、氏名と合言葉のどちらが誤りかを示さない**（screens.md S-2）。
         */
        showError(app, form, result.status === 401 ? UNLOCK_ERROR : result.message);
      })
      .finally(() => setSubmitting(submit, false));
  });
}

/** どちらが誤りかは示さない。氏名の当たりを教えると総当たりの手がかりになる */
const UNLOCK_ERROR = '氏名または合言葉が違います';

function setSubmitting(button: HTMLButtonElement | null, submitting: boolean): void {
  if (!button) return;
  button.disabled = submitting;
  button.textContent = submitting ? '確認中…' : '解除';
}

function clearError(app: HTMLElement): void {
  const error = app.querySelector<HTMLElement>('#unlock-error');
  if (error) error.textContent = '';
}

function fieldValue(form: HTMLFormElement, name: string): string {
  const el = form.elements.namedItem(name);
  if (el instanceof HTMLSelectElement || el instanceof HTMLInputElement) {
    return el.value;
  }
  return '';
}

function showError(app: HTMLElement, form: HTMLFormElement, message: string): void {
  const error = app.querySelector<HTMLElement>('#unlock-error');
  if (error) error.textContent = message;

  const passphrase = form.elements.namedItem('passphrase');
  if (passphrase instanceof HTMLInputElement) {
    passphrase.value = '';
    passphrase.focus();
  }
}
