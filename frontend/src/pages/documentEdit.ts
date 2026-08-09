/**
 * S-7 台帳の修正・論理削除（screens.md §5）。
 *
 * 誤登録レコードを直す（F-13）。編集できるのは担当者と文書発行日だけ。
 * 週2で `PATCH /documents/{docNo}` と `DELETE /documents/{docNo}` に接続する。
 */

import type { DocumentPatch, DocumentRecord } from '../../../shared/types';
import { escapeHtml } from '../lib/html';
import { findDocument } from '../lib/store';
import { activeMasters, findMaster } from '../lib/masters';

export function renderDocumentEdit(documentNo: string): void {
  const app = document.querySelector<HTMLElement>('#app');
  if (!app) return;

  const doc = findDocument(documentNo);
  if (doc === undefined || doc.status === '削除済み') {
    app.innerHTML = messagePage('この文書番号は台帳に登録されていません', documentNo);
    return;
  }

  app.innerHTML = formPage(doc);
  bindEvents(app, doc);
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

function bindEvents(app: HTMLElement, doc: DocumentRecord): void {
  const form = app.querySelector<HTMLFormElement>('#edit-form');
  if (!form) return;

  form.addEventListener('submit', (event) => {
    event.preventDefault();

    // DocumentPatch は owner / issuedAt だけを持つ型なので、
    // status や documentNo を渡す口がそもそも存在しない（shared/types.ts）
    const patch: DocumentPatch = {
      owner: fieldValue(form, 'owner'),
      issuedAt: fieldValue(form, 'issuedAt'),
    };
    Object.assign(doc, patch);

    const message = app.querySelector<HTMLElement>('#edit-message');
    if (message) message.textContent = '保存しました。';
  });

  app.querySelector<HTMLButtonElement>('#delete')?.addEventListener('click', () => {
    if (!window.confirm(`${doc.documentNo} を論理削除します。よろしいですか？`)) return;

    // 物理削除はしない。状態を「削除済み」にすると一覧から消える（CLAUDE.md §5）
    doc.status = '削除済み';
    location.hash = '#/';
  });
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
