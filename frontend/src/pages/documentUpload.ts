/**
 * S-5 ファイルアップロード（screens.md §5）。
 *
 * PDFとエクセルを同時に登録する（F-01）。
 * 週3で `POST /documents/{docNo}/upload-url` → S3へ直接PUT に接続する。
 * モックでは実ファイルを送らず、ファイル名の検証と台帳照合までを再現する。
 */

import type { DocumentRecord } from '../../../shared/types';
import { validateUploadFileNames } from '../../../shared/uploadFiles';
import { escapeHtml } from '../lib/html';
import { findDocument } from '../lib/store';
import { reflectUploadLikeLambda } from '../mock/asyncLambda';

export function renderDocumentUpload(documentNo: string): void {
  const app = document.querySelector<HTMLElement>('#app');
  if (!app) return;

  const doc = findDocument(documentNo);

  // 台帳照合（F-01）。理由をそのまま表示する
  if (doc === undefined) {
    app.innerHTML = messagePage('この文書番号は台帳に登録されていません', documentNo);
    return;
  }
  if (doc.status === '旧版') {
    app.innerHTML = messagePage(
      'このリビジョンは旧版です。最新のリビジョンにアップロードしてください',
      documentNo,
    );
    return;
  }
  const registered = registeredFileMessage(doc);
  if (registered !== null) {
    app.innerHTML = messagePage(registered, documentNo);
    return;
  }

  app.innerHTML = formPage(doc);
  bindEvents(app, doc);
}

/** 同一種別が既に登録済みなら理由を返す（screens.md S-5 のエラー表示） */
function registeredFileMessage(doc: DocumentRecord): string | null {
  if (doc.s3KeyPdf !== undefined && doc.s3KeyExcel !== undefined) {
    return 'このリビジョンのPDFとエクセルは既に登録されています';
  }
  if (doc.s3KeyPdf !== undefined) {
    return 'このリビジョンのPDFは既に登録されています';
  }
  if (doc.s3KeyExcel !== undefined) {
    return 'このリビジョンのエクセルは既に登録されています';
  }
  return null;
}

function formPage(doc: DocumentRecord): string {
  return `
    <h1>ファイルアップロード</h1>
    <p>この文書番号のファイルを登録します。</p>
    <p class="result-number">${escapeHtml(doc.documentNo)}</p>

    <form id="upload-form" class="entry-form">
      <fieldset class="entry-fieldset">
        <label class="form-field">
          <span>PDF</span>
          <input type="file" name="pdf" accept=".pdf" required />
        </label>
        <label class="form-field">
          <span>エクセル</span>
          <input type="file" name="excel" accept=".xlsx" required />
        </label>
        <p class="form-note">
          ファイル名は <code>${escapeHtml(doc.documentNo)}.pdf</code> /
          <code>${escapeHtml(doc.documentNo)}.xlsx</code> にしてください。
        </p>
      </fieldset>

      <ul class="form-error" id="upload-error" role="alert"></ul>

      <!-- 両方を選ぶまで押させない（F-01: 同時選択を必須とする） -->
      <button type="submit" class="btn-primary" id="upload-submit" disabled>アップロード</button>
    </form>

    <div id="upload-result"></div>
  `;
}

function bindEvents(app: HTMLElement, doc: DocumentRecord): void {
  const form = app.querySelector<HTMLFormElement>('#upload-form');
  if (!form) return;

  form.addEventListener('change', () => {
    const submit = app.querySelector<HTMLButtonElement>('#upload-submit');
    if (submit) submit.disabled = fileName(form, 'pdf') === '' || fileName(form, 'excel') === '';
  });

  form.addEventListener('submit', (event) => {
    event.preventDefault();

    const files = { pdfName: fileName(form, 'pdf'), excelName: fileName(form, 'excel') };
    const errors = validateUploadFileNames(doc.documentNo, files);

    const errorList = app.querySelector<HTMLElement>('#upload-error');
    if (errorList) {
      errorList.innerHTML = errors.map((e) => `<li>${escapeHtml(e)}</li>`).join('');
    }
    if (errors.length > 0) return;

    startUpload(app, doc, files);
  });
}

/** input[type=file] は値の代入ができないため、名前だけを取り出して扱う */
function fileName(form: HTMLFormElement, name: string): string {
  const el = form.elements.namedItem(name);
  if (!(el instanceof HTMLInputElement)) return '';
  return el.files?.[0]?.name ?? '';
}

/**
 * 送信後の待ち（screens.md S-5）。
 * **状態が即座に変わらない点を画面の作りに織り込む。**
 * 台帳の更新はS3イベントで起動する非同期Lambdaが行うため、PUT直後は「ファイル未登録」のまま。
 */
function startUpload(
  app: HTMLElement,
  doc: DocumentRecord,
  files: { pdfName: string; excelName: string },
): void {
  const form = app.querySelector<HTMLFormElement>('#upload-form');
  form?.remove();

  const result = app.querySelector<HTMLElement>('#upload-result');
  if (result) {
    result.innerHTML = `
      <div class="result-panel">
        <p id="upload-status">アップロードが完了しました。台帳への反映を確認しています…</p>
      </div>
    `;
  }

  reflectUploadLikeLambda(doc.documentNo, files, () => {
    if (!result) return;
    result.innerHTML = `
      <div class="result-panel">
        <p>台帳に反映されました。状態は「最新」です。</p>
        <p class="result-number">${escapeHtml(doc.documentNo)}</p>
        <div class="result-actions">
          <a class="btn-primary" href="#/">一覧へ戻る</a>
        </div>
      </div>
    `;
  });
}

function messagePage(message: string, documentNo: string): string {
  return `
    <h1>ファイルアップロード</h1>
    <p class="form-error" role="alert">${escapeHtml(message)}</p>
    <p>対象の文書番号：${escapeHtml(documentNo)}</p>
    <p><a href="#/">一覧へ戻る</a></p>
  `;
}
