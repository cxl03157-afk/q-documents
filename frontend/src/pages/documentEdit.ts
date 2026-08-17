/**
 * S-7 台帳の修正・論理削除（screens.md §5）。
 *
 * 誤登録レコードを直す（F-13）。編集できるのは担当者と文書発行日だけ。
 * `PATCH /documents/{docNo}` と `DELETE /documents/{docNo}` に接続済み。
 */

import type { DocumentPatch, DocumentRecord } from '../../../shared/types';
import { apiDeleteAuthed, apiPatchAuthed } from '../lib/api';
import { isDocumentResponse } from '../lib/guards';
import { escapeHtml } from '../lib/html';
import { findDocument, upsertDocument } from '../lib/store';
import { activeMasters, findMaster } from '../lib/masters';

/**
 * PATCH・DELETE の応答待ちの間に「まだこの画面を見ているか」を判定するための2つ
 * （documentUpload.ts と同じパターン）。
 *
 * **番号だけでは足りない。** 番号が増えるのは同じ画面をもう一度開いたときだけで、
 * `[一覧へ戻る]` やヘッダーの `[一覧]` で**別の画面へ移っても増えない**。
 * 画面遷移はすべてハッシュ経由なので、描いた時点のルートと今のルートを比べれば
 * 移動の仕方を問わず分かる。
 */
let activeSession = 0;
let activeRoute = '';

function isCurrentSession(session: number): boolean {
  return session === activeSession && location.hash === activeRoute;
}

export function renderDocumentEdit(documentNo: string): void {
  const app = document.querySelector<HTMLElement>('#app');
  if (!app) return;

  const session = ++activeSession;
  activeRoute = location.hash;

  const doc = findDocument(documentNo);
  if (doc === undefined || doc.status === '削除済み') {
    app.innerHTML = messagePage('この文書番号は台帳に登録されていません', documentNo);
    return;
  }

  app.innerHTML = formPage(doc);
  bindEvents(app, doc, session);
}

function formPage(doc: DocumentRecord): string {
  const typeName = findMaster('文書種類', doc.documentType)?.name ?? doc.documentType;

  return `
    <h1>台帳の修正</h1>
    <p class="result-number">${escapeHtml(doc.documentNo)}</p>

    <!--
      編集できない項目（screens.md S-7）。
      文書番号を構成する項目は変更すれば別の文書になり、状態は非同期Lambdaの管理下にある。
      手で状態を変えられると、ファイルが無いのに「最新」になり F-04 のアーカイブ判定が狂う。
    -->
    <table class="detail-table">
      <tr><th>文書種類</th><td>${escapeHtml(typeName)}</td></tr>
      <tr><th>製品コード</th><td>${escapeHtml(doc.productCode)}</td></tr>
      <tr><th>工程番号</th><td>${escapeHtml(doc.processNo ?? '—')}</td></tr>
      <tr><th>工程名</th><td>${escapeHtml(doc.processName ?? '—')}</td></tr>
      <tr><th>リビジョン</th><td>${escapeHtml(doc.revision)}</td></tr>
      <tr><th>状態</th><td>${escapeHtml(doc.status)}</td></tr>
    </table>
    <p class="form-note">上の項目は変更できません。誤っている場合は論理削除して発行し直してください。</p>

    <form id="edit-form" class="entry-form">
      <fieldset class="entry-fieldset">
        <label class="form-field">
          <span>担当者</span>
          <select name="owner" required>${ownerOptions(doc.owner)}</select>
        </label>
        <label class="form-field">
          <span>文書発行日</span>
          <input type="date" name="issuedAt" required value="${escapeHtml(doc.issuedAt)}" />
        </label>
      </fieldset>

      <p class="form-info" id="edit-message" role="status"></p>

      <div class="result-actions">
        <button type="submit" class="btn-primary">保存</button>
        <button type="button" id="delete" class="btn-danger">論理削除</button>
        <a class="btn-end" href="#/">一覧へ戻る</a>
      </div>
    </form>
  `;
}

/** 現行の担当者が無効化されていても選べるようにする（S-4 と同じ理由） */
function ownerOptions(currentOwner: string): string {
  const names = activeMasters('担当者').map((m) => m.name);
  if (!names.includes(currentOwner)) names.unshift(currentOwner);

  return names
    .map((name) => {
      const selected = name === currentOwner ? ' selected' : '';
      return `<option value="${escapeHtml(name)}"${selected}>${escapeHtml(name)}</option>`;
    })
    .join('');
}

function bindEvents(app: HTMLElement, doc: DocumentRecord, session: number): void {
  const form = app.querySelector<HTMLFormElement>('#edit-form');
  if (!form) return;

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    void save(app, form, doc, session);
  });

  app.querySelector<HTMLButtonElement>('#delete')?.addEventListener('click', (event) => {
    const button = event.currentTarget;
    if (!(button instanceof HTMLButtonElement)) return;
    void remove(app, doc, session);
  });
}

/** クエリの組み立て。`productCode` は台帳のPKで、文書番号だけからは導けない（CLAUDE.md §4） */
function query(doc: DocumentRecord): string {
  return new URLSearchParams({ productCode: doc.productCode }).toString();
}

/**
 * `[保存]`（`PATCH /documents/{docNo}`）。二重送信を防ぐため送信中は保存・論理削除の
 * 両方のボタンを止める（`remove()` 側と対称にする。片方だけ止めると、応答待ちの間に
 * もう片方が押せてしまい、同じレコードに PATCH と DELETE が競合しうる）。
 */
async function save(app: HTMLElement, form: HTMLFormElement, doc: DocumentRecord, session: number): Promise<void> {
  // DocumentPatch は owner / issuedAt だけを持つ型なので、
  // status や documentNo を渡す口がそもそも存在しない（shared/types.ts）
  const patch: DocumentPatch = {
    owner: fieldValue(form, 'owner'),
    issuedAt: fieldValue(form, 'issuedAt'),
  };

  const saveButton = form.querySelector<HTMLButtonElement>('button[type="submit"]');
  const deleteButton = app.querySelector<HTMLButtonElement>('#delete');
  if (saveButton) {
    saveButton.disabled = true;
    saveButton.textContent = '保存中…';
  }
  if (deleteButton) deleteButton.disabled = true;

  const result = await apiPatchAuthed(
    `/documents/${encodeURIComponent(doc.documentNo)}?${query(doc)}`,
    patch,
    isDocumentResponse,
  );

  if (!result.ok) {
    // 待っている間に別の文書の画面へ移った場合、この画面はもう存在しない
    if (!isCurrentSession(session)) return;

    const message = app.querySelector<HTMLElement>('#edit-message');
    if (message) message.textContent = result.message;
    if (saveButton) {
      saveButton.disabled = false;
      saveButton.textContent = '保存';
    }
    if (deleteButton) deleteButton.disabled = false;
    return;
  }

  /**
   * **サーバーで確定した結果は、セッションが古くなっていても store へ反映する。**
   * 画面表示だけをセッションで絞り、データの反映は絞らない
   * （documentUpload.ts の `pollUntilLatest` と同じ方針）。逆にすると、
   * 応答待ちの間に別文書へ移った利用者が戻ってきたとき、保存したはずの内容が
   * 反映されておらず、サーバー側は既に更新済みなのに再送信すると理由なく失敗する。
   */
  upsertDocument(result.data.document);
  if (!isCurrentSession(session)) return;

  const message = app.querySelector<HTMLElement>('#edit-message');
  if (message) message.textContent = '保存しました。';
  if (saveButton) {
    saveButton.disabled = false;
    saveButton.textContent = '保存';
  }
  if (deleteButton) deleteButton.disabled = false;
}

/**
 * `[論理削除]`（`DELETE /documents/{docNo}`）。
 *
 * **この操作は取り消せない**（CLAUDE.md §5）ので確認で明示する。
 * 成功しても一覧へは自動遷移せず、完了表示に切り替えて `[一覧へ戻る]` だけを残す
 * （誤操作の直後に一覧へ飛ばすと、消したことに気づかないまま次の操作に移ってしまう）。
 */
async function remove(app: HTMLElement, doc: DocumentRecord, session: number): Promise<void> {
  if (!window.confirm(`${doc.documentNo} を論理削除します。この操作は取り消せません。よろしいですか？`)) {
    return;
  }

  // save() と対称に両方止める（理由は save() のコメントを参照）
  const saveButton = app.querySelector<HTMLButtonElement>('button[type="submit"]');
  const deleteButton = app.querySelector<HTMLButtonElement>('#delete');
  if (saveButton) saveButton.disabled = true;
  if (deleteButton) deleteButton.disabled = true;

  const result = await apiDeleteAuthed(
    `/documents/${encodeURIComponent(doc.documentNo)}?${query(doc)}`,
    isDocumentResponse,
  );

  if (!result.ok) {
    // 待っている間に別の文書の画面へ移った場合、この画面はもう存在しない
    if (!isCurrentSession(session)) return;

    const message = app.querySelector<HTMLElement>('#edit-message');
    if (message) message.textContent = result.message;
    if (saveButton) saveButton.disabled = false;
    if (deleteButton) deleteButton.disabled = false;
    return;
  }

  // save() と同じ理由で、store への反映はセッションの新旧を問わず行う
  upsertDocument(result.data.document);

  // 今見ている画面（別文書かもしれない）を削除完了表示で上書きしてはいけない
  if (!isCurrentSession(session)) return;
  app.innerHTML = deletedPage(doc.documentNo);
}

function deletedPage(documentNo: string): string {
  return `
    <h1>台帳の修正</h1>
    <p class="form-info" role="status">${escapeHtml(documentNo)} を論理削除しました。</p>
    <p><a href="#/">一覧へ戻る</a></p>
  `;
}

function fieldValue(form: HTMLFormElement, name: string): string {
  const el = form.elements.namedItem(name);
  if (el instanceof HTMLSelectElement || el instanceof HTMLInputElement) return el.value;
  return '';
}

function messagePage(message: string, documentNo: string): string {
  return `
    <h1>台帳の修正</h1>
    <p class="form-error" role="alert">${escapeHtml(message)}</p>
    <p>対象の文書番号：${escapeHtml(documentNo)}</p>
    <p><a href="#/">一覧へ戻る</a></p>
  `;
}
