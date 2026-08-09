/**
 * S-4 リビジョンアップ（screens.md §5）。
 *
 * 現行文書のリビジョンを1つ進め、新しいレコードを「ファイル未登録」で作る。
 * 旧版へのアーカイブは新Revのファイルが揃った時点で非同期Lambdaが行う（F-04）。この画面では行わない。
 * 週2で `POST /documents/{docNo}/revisions` に接続する。
 */

import type { DocumentRecord } from '../../../shared/types';
import { nextRevision, parseDocumentNo } from '../../../shared/documentNo';
import { apiPostAuthed } from '../lib/api';
import { isDocumentResponse } from '../lib/guards';
import { escapeHtml } from '../lib/html';
import { activeMasters, findMaster } from '../lib/masters';
import { findDocument, upsertDocument } from '../lib/store';

export function renderDocumentRevise(documentNo: string): void {
  const app = document.querySelector<HTMLElement>('#app');
  if (!app) return;

  const doc = findDocument(documentNo);
  if (doc === undefined) {
    app.innerHTML = messagePage('この文書番号は台帳に登録されていません', documentNo);
    return;
  }

  // 旧版から Rev を進めると、既に存在する新Revと文書番号が衝突する（screens.md S-4）
  if (doc.status === '旧版') {
    app.innerHTML = messagePage(
      'このリビジョンは旧版です。最新のリビジョンからリビジョンアップしてください',
      documentNo,
    );
    return;
  }

  const parsed = parseDocumentNo(doc.documentNo);
  if (parsed === null) {
    app.innerHTML = messagePage('文書番号の形式が不正です', documentNo);
    return;
  }

  const newRevision = nextRevision(parsed.revision);
  const newDocumentNo = `${parsed.documentId}_${newRevision}`;

  // 手元の台帳での事前確認。サーバーも条件付き書き込みで弾くが、
  // 押す前に分かるほうがよい（CLAUDE.md §7 の二重化）
  if (findDocument(newDocumentNo) !== undefined) {
    app.innerHTML = messagePage(`Rev ${newRevision} は既に台帳にあります`, documentNo);
    return;
  }

  app.innerHTML = confirmPage(doc, newRevision, newDocumentNo);

  // 未入力のまま実行させないため、ボタンの click ではなく form の submit で受ける
  // （required は form の送信時にしか効かない）
  const form = app.querySelector<HTMLFormElement>('#revise-form');
  form?.addEventListener('submit', (event) => {
    event.preventDefault();
    void submitRevision(app, form, doc);
  });
}

/**
 * リビジョンアップを実行する（`POST /documents/{docNo}/revisions`）。
 *
 * **新しいレコードは組み立てて送らない。** 送るのは担当者と文書発行日だけで、
 * 文書番号・文書種類・工程・状態はサーバーが現行レコードから引き継ぐ。
 * 画面が組み立てて送る方式にすると、S3キーを引き継がないことや
 * 状態を「ファイル未登録」にすることを画面側でも正しく守る必要が出る
 * （CLAUDE.md §5・§7）。守る場所は1つにする。
 *
 * `productCode` を送るのは、サーバーが GetItem するのに PK が要るため（docs/API.md）。
 */
async function submitRevision(
  app: HTMLElement,
  form: HTMLFormElement,
  doc: DocumentRecord,
): Promise<void> {
  const button = form.querySelector<HTMLButtonElement>('button[type="submit"]');
  const errorBox = app.querySelector<HTMLElement>('#revise-error');

  // 二重に押すと、2回目はサーバーが 409 で弾くが理由の分からない失敗として見える
  if (button) {
    button.disabled = true;
    button.textContent = '実行中…';
  }
  if (errorBox) errorBox.textContent = '';

  const result = await apiPostAuthed(
    `/documents/${encodeURIComponent(doc.documentNo)}/revisions`,
    {
      productCode: doc.productCode,
      owner: fieldValue(form, 'owner'),
      issuedAt: fieldValue(form, 'issuedAt'),
    },
    isDocumentResponse,
  );

  if (!result.ok) {
    if (button) {
      button.disabled = false;
      button.textContent = '実行';
    }
    if (errorBox) errorBox.textContent = result.message;
    return;
  }

  upsertDocument(result.data.document);
  // 完了画面に出すのはサーバーが確定した文書番号。画面が組み立てた予測値ではない
  app.innerHTML = donePage(result.data.document.documentNo);
}

function fieldValue(form: HTMLFormElement, name: string): string {
  const el = form.elements.namedItem(name);
  if (el instanceof HTMLSelectElement || el instanceof HTMLInputElement) return el.value;
  return '';
}

/**
 * 新しいレコードの組み立ては**サーバー側へ移した**（backend/src/routes/createRevision.ts）。
 *
 * 以前はここで組み立てていたが、そのやり方だと画面側も
 *   - S3キーを引き継がない（引き継ぐと非同期Lambdaが「両方揃った」と誤判定する）
 *   - 状態は「ファイル未登録」にする（状態を書けるのは非同期Lambdaだけ・CLAUDE.md §5）
 * を正しく守る必要があり、規律を守る場所が2つになる。
 * 画面が送るのは担当者と文書発行日だけにして、残りはサーバーが現行レコードから引き継ぐ。
 */

function todayIso(): string {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${now.getFullYear()}-${month}-${day}`;
}

function confirmPage(doc: DocumentRecord, newRevision: string, newDocumentNo: string): string {
  const typeName = findMaster('文書種類', doc.documentType)?.name ?? doc.documentType;
  const process =
    doc.processNo === undefined
      ? ''
      : `<p>工程：${escapeHtml(doc.processNo)}　${escapeHtml(doc.processName ?? '')}</p>`;

  return `
    <h1>リビジョンアップ</h1>
    <div class="result-panel">
      <p>文書番号：${escapeHtml(doc.documentNo)}</p>
      <p>文書種類：${escapeHtml(typeName)}</p>
      <p>製品コード：${escapeHtml(doc.productCode)}</p>
      ${process}
      <p class="result-number">現行 Rev ${escapeHtml(doc.revision)} → 新規 Rev ${escapeHtml(newRevision)}</p>
      <p>新しい文書番号：${escapeHtml(newDocumentNo)}</p>

      <form id="revise-form" class="entry-form">
        <label class="form-field">
          <span>担当者</span>
          <select name="owner" required>
            ${ownerOptions(doc.owner)}
          </select>
          ${
            isOwnerSelectable(doc.owner)
              ? ''
              : // 理由を出さないと、なぜ既定値が入っていないのか分からない
                `<span class="form-note">現行の担当者（${escapeHtml(doc.owner)}）は無効化されています。担当者を選び直してください</span>`
          }
        </label>
        <label class="form-field">
          <span>文書発行日</span>
          <input type="date" name="issuedAt" required value="${escapeHtml(todayIso())}" />
        </label>
        <!-- サーバーが拒否した理由の表示先（旧版・Rev衝突・無効な担当者など） -->
        <p class="form-error" id="revise-error" role="alert"></p>

        <div class="result-actions">
          <button type="submit" class="btn-primary">実行</button>
          <a class="btn-end" href="#/">一覧へ戻る</a>
        </div>
      </form>
    </div>
  `;
}

/** 現行リビジョンの担当者が、いまも有効な担当者として選べるか */
function isOwnerSelectable(currentOwner: string): boolean {
  return activeMasters('担当者').some((m) => m.name === currentOwner);
}

/**
 * 担当者の選択肢（screens.md S-4）。
 *
 * 既定は現行リビジョンの担当者。**ただし無効化されている場合は選択肢に残さない。**
 * 無効化は今後この人を選ばせないという意思表示で、リビジョンアップは新しい版を
 * 発行する行為（＝新規発行）にあたるため。過去のリビジョンに残っている氏名は
 * 履歴としてそのまま保持する。
 *
 * その場合は空の選択肢を先頭に置く。`required` が効いて、選び直すまで送信できない。
 * 「有効な担当者への変更を必須とする」を HTML の検証だけで表現できる。
 *
 * 残して既定値にすると、既定のまま `[実行]` を押した利用者が
 * `POST /documents/{docNo}/revisions` の 400 に必ず当たる（backend も同じ規則で弾く）。
 */
function ownerOptions(currentOwner: string): string {
  const options = activeMasters('担当者').map((m) => {
    const selected = m.name === currentOwner ? ' selected' : '';
    return `<option value="${escapeHtml(m.name)}"${selected}>${escapeHtml(m.name)}</option>`;
  });

  if (!isOwnerSelectable(currentOwner)) {
    options.unshift('<option value="" selected>選択してください</option>');
  }

  return options.join('');
}

function donePage(newDocumentNo: string): string {
  return `
    <h1>リビジョンアップ</h1>
    <div class="result-panel">
      <p>新しいリビジョンを台帳に登録しました。状態は「ファイル未登録」です。</p>
      <p class="result-number">${escapeHtml(newDocumentNo)}</p>
      <p>一覧では、状態の絞り込みで「ファイル未登録」を選ぶと表示されます。</p>
      <div class="result-actions">
        <a class="btn-primary" href="#/documents/${encodeURIComponent(newDocumentNo)}/upload">ファイルをアップロードする</a>
        <a class="btn-end" href="#/">一覧へ戻る</a>
      </div>
    </div>
  `;
}

function messagePage(message: string, documentNo: string): string {
  return `
    <h1>リビジョンアップ</h1>
    <p class="form-error" role="alert">${escapeHtml(message)}</p>
    <p>対象の文書番号：${escapeHtml(documentNo)}</p>
    <p><a href="#/">一覧へ戻る</a></p>
  `;
}
