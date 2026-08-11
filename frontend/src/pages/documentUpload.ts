/**
 * S-5 ファイルアップロード（screens.md §5）。
 *
 * PDFとエクセルを登録する（F-01）。片方が既に登録済みなら、その欄は出さず
 * 未登録の種別だけを送る。実ファイルは `POST /documents/{docNo}/upload-url` で
 * 署名付きURL（presigned POST）を取得し、S3へ直接送る（API Gatewayは経由しない）。
 *
 * 台帳の更新はS3イベントで起動する非同期Lambdaが行うため、送信直後はまだ
 * 「ファイル未登録」または「一部登録」のまま。反映されるまで一覧をポーリングして待つ。
 */

import type { DocumentRecord } from '../../../shared/types';
import { validateUploadFileNames, type UploadFileNames } from '../../../shared/uploadFiles';
import { apiPostAuthed } from '../lib/api';
import { escapeHtml } from '../lib/html';
import { isUploadUrlResponse, type PresignedUpload, type UploadUrlResponse } from '../lib/guards';
import { findDocument, loadDocuments } from '../lib/store';

/** 台帳への反映を待つ間隔と回数の上限（2秒 × 15回 = 最大30秒）。無限に待たない */
const POLL_INTERVAL_MS = 2000;
const POLL_MAX_ATTEMPTS = 15;

export function renderDocumentUpload(documentNo: string): void {
  const app = document.querySelector<HTMLElement>('#app');
  if (!app) return;

  const doc = findDocument(documentNo);

  // 台帳照合（F-01）。理由をそのまま表示する
  if (doc === undefined) {
    app.innerHTML = messagePage('この文書番号は台帳に登録されていません', documentNo);
    return;
  }
  const blocked = blockingReason(doc);
  if (blocked !== null) {
    app.innerHTML = messagePage(blocked, documentNo);
    return;
  }

  app.innerHTML = formPage(doc);
  bindEvents(app, doc);
}

/**
 * 送信前に分かる拒否理由（screens.md S-5 のエラー表）。
 *
 * **正はサーバー側**（`createUploadUrl.ts` の `rejectionReason`）。ここは早期通知のための
 * 重複で、同じ3つ（旧版・削除済み・両方登録済み）だけを見る。
 * 片方だけ登録済みの場合はここでは止めない — その種別の欄だけを隠して受け付ける（下記）。
 */
function blockingReason(doc: DocumentRecord): string | null {
  if (doc.status === '旧版') {
    return 'このリビジョンは旧版です。最新のリビジョンにアップロードしてください';
  }
  if (doc.status === '削除済み') {
    return 'この文書は削除済みです。新規発行でやり直してください';
  }
  if (doc.s3KeyPdf !== undefined && doc.s3KeyExcel !== undefined) {
    return 'このリビジョンのPDFとエクセルは既に登録されています';
  }
  return null;
}

function formPage(doc: DocumentRecord): string {
  const needsPdf = doc.s3KeyPdf === undefined;
  const needsExcel = doc.s3KeyExcel === undefined;

  return `
    <h1>ファイルアップロード</h1>
    <p>この文書番号のファイルを登録します。</p>
    <p class="result-number">${escapeHtml(doc.documentNo)}</p>
    ${registeredNote(doc)}

    <form id="upload-form" class="entry-form">
      <fieldset class="entry-fieldset">
        ${needsPdf ? fileField('pdf', 'PDF', '.pdf') : ''}
        ${needsExcel ? fileField('excel', 'エクセル', '.xlsx') : ''}
        <p class="form-note">${expectedFileNamesNote(doc, needsPdf, needsExcel)}</p>
      </fieldset>

      <ul class="form-error" id="upload-error" role="alert"></ul>

      <!-- 表示している欄をすべて選ぶまで押させない（F-01: 同時選択を必須とする） -->
      <button type="submit" class="btn-primary" id="upload-submit" disabled>アップロード</button>
    </form>

    <div id="upload-result"></div>
  `;
}

/**
 * 「ファイル名は◯◯にしてください」の注記。表示している欄に対応するものだけを出す。
 *
 * 片方が登録済みでPDF欄を出していないのに `.pdf` の例まで示すと、
 * その欄が無いのに何のための例か分からず違和感がある（利用者の指摘）。
 */
function expectedFileNamesNote(doc: DocumentRecord, needsPdf: boolean, needsExcel: boolean): string {
  const names = [
    needsPdf ? `<code>${escapeHtml(doc.documentNo)}.pdf</code>` : null,
    needsExcel ? `<code>${escapeHtml(doc.documentNo)}.xlsx</code>` : null,
  ].filter((label): label is string => label !== null);

  return `ファイル名は ${names.join(' / ')} にしてください。`;
}

function fileField(name: 'pdf' | 'excel', label: string, accept: string): string {
  return `
    <label class="form-field">
      <span>${label}</span>
      <input type="file" name="${name}" accept="${accept}" required />
    </label>
  `;
}

/** 片方だけ登録済みのとき、欄が1つしか出ない理由を伝える（S-6のコード欄注記と同じ形） */
function registeredNote(doc: DocumentRecord): string {
  if (doc.s3KeyPdf === undefined && doc.s3KeyExcel === undefined) return '';
  const done = doc.s3KeyPdf !== undefined ? 'PDF' : 'エクセル';
  return `<p class="form-note">${done}は既に登録済みです。残りのファイルだけ選択してください。</p>`;
}

function bindEvents(app: HTMLElement, doc: DocumentRecord): void {
  const form = app.querySelector<HTMLFormElement>('#upload-form');
  if (!form) return;

  const needsPdf = doc.s3KeyPdf === undefined;
  const needsExcel = doc.s3KeyExcel === undefined;

  form.addEventListener('change', () => {
    const submit = app.querySelector<HTMLButtonElement>('#upload-submit');
    if (!submit) return;
    const pdfReady = !needsPdf || fileName(form, 'pdf') !== '';
    const excelReady = !needsExcel || fileName(form, 'excel') !== '';
    submit.disabled = !(pdfReady && excelReady);
  });

  form.addEventListener('submit', (event) => {
    event.preventDefault();

    const pdf = needsPdf ? selectedFile(form, 'pdf') : undefined;
    const excel = needsExcel ? selectedFile(form, 'excel') : undefined;

    const names: UploadFileNames = {};
    if (pdf) names.pdfName = pdf.name;
    if (excel) names.excelName = excel.name;

    const errors = validateUploadFileNames(doc.documentNo, names);

    const errorList = app.querySelector<HTMLElement>('#upload-error');
    if (errorList) {
      errorList.innerHTML = errors.map((e) => `<li>${escapeHtml(e)}</li>`).join('');
    }
    if (errors.length > 0) return;

    void startUpload(app, doc, { pdf, excel });
  });
}

/** input[type=file] は値の代入ができないため、名前だけを取り出して扱う */
function fileName(form: HTMLFormElement, name: string): string {
  const el = form.elements.namedItem(name);
  if (!(el instanceof HTMLInputElement)) return '';
  return el.files?.[0]?.name ?? '';
}

/** 実際に送る File オブジェクトを取り出す。ファイル名だけでは S3 へ送る中身がない */
function selectedFile(form: HTMLFormElement, name: string): File | undefined {
  const el = form.elements.namedItem(name);
  if (!(el instanceof HTMLInputElement)) return undefined;
  return el.files?.[0];
}

type PickedFiles = { pdf?: File; excel?: File };

/**
 * アップロード本体（screens.md S-5「操作の流れ」1〜4）。
 *
 * 1. `POST /documents/{docNo}/upload-url` で署名付きURLを取得
 * 2. 返された `fields` を全部 `FormData` に入れ、最後に `file` を追加して S3 へ直接 POST
 * 3. 「反映を確認しています」と表示し、`GET /documents` を再取得して「最新」になるまで待つ
 */
async function startUpload(app: HTMLElement, doc: DocumentRecord, files: PickedFiles): Promise<void> {
  const form = app.querySelector<HTMLFormElement>('#upload-form');
  const submit = form?.querySelector<HTMLButtonElement>('#upload-submit');
  if (submit) {
    submit.disabled = true;
    submit.textContent = 'アップロード中…';
  }

  const body: Record<string, unknown> = { productCode: doc.productCode };
  if (files.pdf) body.pdfName = files.pdf.name;
  if (files.excel) body.excelName = files.excel.name;

  const urlResult = await apiPostAuthed(
    `/documents/${encodeURIComponent(doc.documentNo)}/upload-url`,
    body,
    isUploadUrlResponse,
  );

  if (!urlResult.ok) {
    restoreForm(app, submit, urlResult.message);
    return;
  }

  const sent = await sendToS3(files, urlResult.data);
  if (!sent) {
    restoreForm(app, submit, 'ファイルの送信に失敗しました。時間をおいて試してください');
    return;
  }

  form?.remove();
  const result = app.querySelector<HTMLElement>('#upload-result');
  if (result) {
    result.innerHTML = `
      <div class="result-panel">
        <p id="upload-status">アップロードが完了しました。台帳への反映を確認しています…</p>
      </div>
    `;
  }

  await pollUntilLatest(app, doc.documentNo, 0);
}

function restoreForm(app: HTMLElement, submit: HTMLButtonElement | null | undefined, message: string): void {
  const errorList = app.querySelector<HTMLElement>('#upload-error');
  if (errorList) errorList.innerHTML = `<li>${escapeHtml(message)}</li>`;
  if (submit) {
    submit.disabled = false;
    submit.textContent = 'アップロード';
  }
}

/** 要求した種別ぶんだけ S3 へ POST する。並行に送り、すべて成功したときだけ true */
async function sendToS3(files: PickedFiles, targets: UploadUrlResponse): Promise<boolean> {
  const tasks: Promise<boolean>[] = [];
  if (files.pdf && targets.pdf) tasks.push(postOne(targets.pdf, files.pdf));
  if (files.excel && targets.excel) tasks.push(postOne(targets.excel, files.excel));

  if (tasks.length === 0) return false;
  const results = await Promise.all(tasks);
  return results.every((ok) => ok);
}

/** `fields` を全部 FormData に入れ、最後に file を追加する（順序が逆だとS3が拒否する） */
async function postOne(target: PresignedUpload, file: File): Promise<boolean> {
  const formData = new FormData();
  for (const [key, value] of Object.entries(target.fields)) {
    formData.append(key, value);
  }
  formData.append('file', file);

  try {
    const response = await fetch(target.url, { method: 'POST', body: formData });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * 台帳への反映を待つ（screens.md S-5「操作の流れ」4）。
 *
 * 非同期Lambdaの経路（S3イベント → Lambda起動 → DynamoDB更新）ぶんのタイムラグがあるため、
 * 一度で終わらせず一定間隔で `GET /documents` を取り直す。**無限に待たない** —
 * 上限に達したら失敗ではなく「確認できなかった」ことを伝え、一覧から手動で確認してもらう。
 */
async function pollUntilLatest(app: HTMLElement, documentNo: string, attempt: number): Promise<void> {
  const message = await loadDocuments();
  if (message !== null) {
    showResult(app, '台帳の確認に失敗しました。一覧から状態を確認してください。', documentNo);
    return;
  }

  const doc = findDocument(documentNo);
  if (doc?.status === '最新') {
    showResult(app, '台帳に反映されました。状態は「最新」です。', documentNo, true);
    return;
  }

  if (attempt + 1 >= POLL_MAX_ATTEMPTS) {
    showResult(
      app,
      '反映の確認に時間がかかっています。しばらくしてから一覧で状態を確認してください。',
      documentNo,
    );
    return;
  }

  window.setTimeout(() => void pollUntilLatest(app, documentNo, attempt + 1), POLL_INTERVAL_MS);
}

function showResult(app: HTMLElement, message: string, documentNo: string, done = false): void {
  const result = app.querySelector<HTMLElement>('#upload-result');
  if (!result) return;

  result.innerHTML = `
    <div class="result-panel">
      <p>${escapeHtml(message)}</p>
      ${done ? `<p class="result-number">${escapeHtml(documentNo)}</p>` : ''}
      <div class="result-actions">
        <a class="btn-primary" href="#/">一覧へ戻る</a>
      </div>
    </div>
  `;
}

function messagePage(message: string, documentNo: string): string {
  return `
    <h1>ファイルアップロード</h1>
    <p class="form-error" role="alert">${escapeHtml(message)}</p>
    <p>対象の文書番号：${escapeHtml(documentNo)}</p>
    <p><a href="#/">一覧へ戻る</a></p>
  `;
}
