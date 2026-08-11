/**
 * S-5 ファイルアップロード（screens.md §5）。
 *
 * PDFとエクセルを登録する（F-01）。片方が既に登録済みなら、その欄は出さず
 * 未登録の種別だけを送る。実ファイルは `POST /documents/{docNo}/upload-url` で
 * 署名付きURL（presigned POST）を取得し、S3へ直接送る（API Gatewayは経由しない）。
 *
 * 台帳の更新はS3イベントで起動する非同期Lambdaが行うため、送信直後はまだ
 * 「ファイル未登録」または「一部登録」のまま。反映されるまで一覧をポーリングして待つ。
 *
 * ---
 *
 * **フォームの必須欄は「台帳」と「このタブ内で今回S3送信に成功した種別（`sentTypes`）」
 * の2つから毎回計算し直す。** 片方だけ送信に失敗した場合に、古い必須欄のまま
 * 再送信すると「もう登録されている種別」までサーバーへ再要求してしまい、
 * リクエスト全体が409で拒否されて詰む（レビュー指摘）。失敗時は必ず `renderForm`
 * で作り直し、成功済みの種別は次の描画で `sentTypes` に積んで欄ごと隠す。
 *
 * **`session` は「まだこの文書のアップロード画面を見ているか」の目印。**
 * `#app` は使い回しの単一要素で、画面遷移は `innerHTML` の丸ごと差し替えのみ
 * （`router.ts` に前の画面の後始末の仕組みが無い）。非同期処理の完了を待っている間に
 * 別の文書のアップロード画面へ移動していると、古い処理の結果が今見えている
 * 別文書の画面に書き込まれてしまう（レビュー指摘）。各非同期処理の再開時に
 * `session` が今も有効かを確認し、無効なら何も描画しない。
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

type FileType = 'pdf' | 'excel';

/** `renderDocumentUpload` を呼ぶたびに増える。非同期処理の結果を書き込んでよいかの目印 */
let activeSession = 0;

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

  const session = ++activeSession;
  renderForm(app, doc, new Set(), session);
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

/** フォームを（再）描画する。`notice` があれば送信エラー欄にそのまま出す */
function renderForm(
  app: HTMLElement,
  doc: DocumentRecord,
  sentTypes: ReadonlySet<FileType>,
  session: number,
  notice?: string,
): void {
  app.innerHTML = formPage(doc, sentTypes);
  bindEvents(app, doc, sentTypes, session);

  if (notice !== undefined) {
    const errorList = app.querySelector<HTMLElement>('#upload-error');
    if (errorList) errorList.innerHTML = `<li>${escapeHtml(notice)}</li>`;
  }
}

/** 台帳に登録済み、またはこのタブ内で今回のS3送信が既に成功している種別か */
function isDone(doc: DocumentRecord, sentTypes: ReadonlySet<FileType>, type: FileType): boolean {
  if (type === 'pdf') return doc.s3KeyPdf !== undefined || sentTypes.has('pdf');
  return doc.s3KeyExcel !== undefined || sentTypes.has('excel');
}

function formPage(doc: DocumentRecord, sentTypes: ReadonlySet<FileType>): string {
  const needsPdf = !isDone(doc, sentTypes, 'pdf');
  const needsExcel = !isDone(doc, sentTypes, 'excel');

  return `
    <h1>ファイルアップロード</h1>
    <p>この文書番号のファイルを登録します。</p>
    <p class="result-number">${escapeHtml(doc.documentNo)}</p>
    ${registeredNote(doc, sentTypes)}

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

function fileField(name: FileType, label: string, accept: string): string {
  return `
    <label class="form-field">
      <span>${label}</span>
      <input type="file" name="${name}" accept="${accept}" required />
    </label>
  `;
}

/** 欄が1つしか出ない理由を伝える（登録済み・今回の送信成功のどちらでも同じ文言でよい） */
function registeredNote(doc: DocumentRecord, sentTypes: ReadonlySet<FileType>): string {
  const done = [
    isDone(doc, sentTypes, 'pdf') ? 'PDF' : null,
    isDone(doc, sentTypes, 'excel') ? 'エクセル' : null,
  ].filter((label): label is string => label !== null);

  if (done.length === 0) return '';
  return `<p class="form-note">${done.join('と')}は既に登録済みです。残りのファイルだけ選択してください。</p>`;
}

function bindEvents(
  app: HTMLElement,
  doc: DocumentRecord,
  sentTypes: ReadonlySet<FileType>,
  session: number,
): void {
  const form = app.querySelector<HTMLFormElement>('#upload-form');
  if (!form) return;

  const needsPdf = !isDone(doc, sentTypes, 'pdf');
  const needsExcel = !isDone(doc, sentTypes, 'excel');

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

    void startUpload(app, doc, { pdf, excel }, sentTypes, session);
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

/** 今見ている文書のアップロード画面が、まだ表示され続けているか */
function isCurrentSession(session: number): boolean {
  return session === activeSession;
}

/** 必須欄が変わらない失敗（何も新たに成功していない）の復元。選択済みのファイルは残す */
function restoreForm(app: HTMLElement, submit: HTMLButtonElement | null | undefined, message: string): void {
  const errorList = app.querySelector<HTMLElement>('#upload-error');
  if (errorList) errorList.innerHTML = `<li>${escapeHtml(message)}</li>`;
  if (submit) {
    submit.disabled = false;
    submit.textContent = 'アップロード';
  }
}

/**
 * アップロード本体（screens.md S-5「操作の流れ」1〜4）。
 *
 * 1. `POST /documents/{docNo}/upload-url` で署名付きURLを取得
 * 2. 返された `fields` を全部 `FormData` に入れ、最後に `file` を追加して S3 へ直接 POST
 * 3. 「反映を確認しています」と表示し、`GET /documents` を再取得して「最新」になるまで待つ
 */
async function startUpload(
  app: HTMLElement,
  doc: DocumentRecord,
  files: PickedFiles,
  sentTypes: ReadonlySet<FileType>,
  session: number,
): Promise<void> {
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
  if (!isCurrentSession(session)) return; // 待っている間に別の文書の画面へ移った

  if (!urlResult.ok) {
    // まだ何もS3へ送っていないので必須欄は変わらない。選択済みのファイルを残したまま復元する
    restoreForm(app, submit, urlResult.message);
    return;
  }

  const sendResult = await sendToS3(files, urlResult.data);
  if (!isCurrentSession(session)) return;

  const succeeded = new Set(sentTypes);
  if (files.pdf && sendResult.pdfOk) succeeded.add('pdf');
  if (files.excel && sendResult.excelOk) succeeded.add('excel');

  const failed = [
    files.pdf && !sendResult.pdfOk ? 'PDF' : null,
    files.excel && !sendResult.excelOk ? 'エクセル' : null,
  ].filter((label): label is string => label !== null);

  if (failed.length > 0) {
    const message = `${failed.join('と')}の送信に失敗しました。時間をおいて試してください`;

    /**
     * **今回新たに成功した種別があるときだけ作り直す。** 何も成功していないなら
     * 必須欄は変わらないので、選択済みのファイルを残したまま軽く復元するだけでよい
     * （作り直すと選び直しの手間が増えるだけの退行になる・レビュー指摘）。
     *
     * 一部だけ成功した場合は話が別。**成功した分は次回リクエストに含めない** —
     * 古い必須欄のまま再送信すると、既にS3へ送れた種別までサーバーへ再要求してしまい、
     * 「既に登録されています」で**まだ送れていない分もろとも**409で拒否される（レビュー指摘）。
     * `succeeded` を次の描画の `sentTypes` として渡し、失敗した欄だけ選び直させる。
     */
    if (succeeded.size > sentTypes.size) {
      renderForm(app, doc, succeeded, session, message);
    } else {
      restoreForm(app, submit, message);
    }
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

  await pollUntilLatest(app, doc.documentNo, 0, session);
}

type SendResult = { pdfOk: boolean; excelOk: boolean };

/**
 * 要求した種別ぶんだけ S3 へ POST する。並行に送り、種別ごとに成功したかを返す。
 * 要求していない種別は「送る必要がなかった」という意味で true にする。
 */
async function sendToS3(files: PickedFiles, targets: UploadUrlResponse): Promise<SendResult> {
  const [pdfOk, excelOk] = await Promise.all([
    files.pdf && targets.pdf ? postOne(targets.pdf, files.pdf) : Promise.resolve(true),
    files.excel && targets.excel ? postOne(targets.excel, files.excel) : Promise.resolve(true),
  ]);
  return { pdfOk, excelOk };
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
    if (!response.ok) {
      // S3 は失敗理由を XML で返すが、ここでは握りつぶさずコンソールにだけ残す
      // （画面には一律の文言を出すが、開発者ツールで原因を追えるようにする・レビュー指摘）
      console.error('S3 upload rejected', { status: response.status, key: target.fields.key });
    }
    return response.ok;
  } catch (error) {
    console.error('S3 upload failed', error);
    return false;
  }
}

/**
 * 台帳への反映を待つ（screens.md S-5「操作の流れ」4）。
 *
 * 非同期Lambdaの経路（S3イベント → Lambda起動 → DynamoDB更新）ぶんのタイムラグがあるため、
 * 一度で終わらせず一定間隔で `GET /documents` を取り直す。**無限に待たない** —
 * 上限に達したら失敗ではなく「確認できなかった」ことを伝え、一覧から手動で確認してもらう。
 *
 * **通信が1回失敗しただけでは諦めない。** 瞬断・一時的な5xxは珍しくなく、
 * 残り試行回数があるなら次の間隔でもう一度取り直す（レビュー指摘）。
 * 上限に達したときだけ、直近が通信失敗だったかどうかで文言を分ける。
 */
async function pollUntilLatest(
  app: HTMLElement,
  documentNo: string,
  attempt: number,
  session: number,
): Promise<void> {
  const message = await loadDocuments();
  if (!isCurrentSession(session)) return; // 待っている間に別の文書の画面へ移った

  const doc = message === null ? findDocument(documentNo) : undefined;
  if (doc?.status === '最新') {
    showResult(app, documentNo, '台帳に反映されました。状態は「最新」です。', true);
    return;
  }

  if (attempt + 1 >= POLL_MAX_ATTEMPTS) {
    const timeoutMessage =
      message !== null
        ? '台帳の確認に失敗しました。一覧から状態を確認してください。'
        : '反映の確認に時間がかかっています。しばらくしてから一覧で状態を確認してください。';
    showResult(app, documentNo, timeoutMessage);
    return;
  }

  window.setTimeout(() => void pollUntilLatest(app, documentNo, attempt + 1, session), POLL_INTERVAL_MS);
}

function showResult(app: HTMLElement, documentNo: string, message: string, done = false): void {
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
