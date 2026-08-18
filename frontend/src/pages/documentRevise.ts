/**
 * S-4 リビジョンアップ（screens.md §5）。
 *
 * 現行文書のリビジョンを1つ進め、新しいレコードを「ファイル未登録」で作る。
 * 旧版へのアーカイブは新Revのファイルが揃った時点で非同期Lambdaが行う（F-04）。この画面では行わない。
 *
 * 新しいレコードを作るのは `POST /documents/{docNo}/revisions`。
 * この画面が送るのは担当者と文書発行日だけで、残りはサーバーが現行レコードから
 * 引き継ぐ（下の `submitRevision` を見ること）。
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

  // 「最新」以外からは進めない（screens.md S-4／8/11 決定）。サーバーと同じ4状態を早期に案内する
  const blocked = ineligibleRevisionMessage(doc);
  if (blocked !== null) {
    app.innerHTML = messagePage(blocked, documentNo);
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
  const existingNext = findDocument(newDocumentNo);
  const conflict = existingNext === undefined ? null : nextRevisionConflict(existingNext);
  if (conflict !== null) {
    app.innerHTML = messagePage(conflict.message, documentNo, conflict.action);
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
  // 掴んだ要素がまだ文書に繋がっているかで、この画面がまだ見えているかを判断する
  const isStillVisible = (): boolean => form.isConnected;

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
    /**
     * **切り離された要素に書いても見えない。**
     *
     * 応答を待っている間に画面が描き直されることがある（401 を受けた `api.ts` が
     * `endSession()` を呼ぶ／解除・ロックの切り替え／台帳の取り直し。いずれも
     * `main.ts` が `refreshRoute()` する）。掴んでおいた `errorBox` はそのとき
     * 文書から外れるので、**サーバーが返した 409 の理由が誰にも見えなくなる**。
     * 見えないなら書かない。画面は既に次の内容に置き換わっている。
     */
    if (!isStillVisible()) return;

    if (button) {
      button.disabled = false;
      button.textContent = '実行';
    }
    if (errorBox) errorBox.textContent = result.message;
    return;
  }

  /**
   * **ストアへの反映は画面より先。** 登録は成功しているので、
   * 利用者が別の画面へ移っていても台帳には載せる（8/14 の決定）。
   * セッションで絞るのは画面の描き替えだけ。
   */
  upsertDocument(result.data.document);

  if (!isStillVisible()) return;

  // 完了画面に出すのはサーバーが確定した文書番号。画面が組み立てた予測値ではない
  app.innerHTML = donePage(result.data.document.documentNo);
}

function fieldValue(form: HTMLFormElement, name: string): string {
  const el = form.elements.namedItem(name);
  if (el instanceof HTMLSelectElement || el instanceof HTMLInputElement) return el.value;
  return '';
}

/** 進めない理由と、そこからの導線（あれば） */
type Conflict = { message: string; action?: { href: string; label: string } };

/**
 * 次のリビジョンが既に台帳にある場合の扱い。進めてよければ null。
 *
 * **状態を見ずに一律で断ってはいけない。** 以前は「あれば断る」だけで、
 * 次の2つの誤りがあった（8/17 の実機確認で判明）。
 *
 *   ファイル未登録・一部登録 — 断って行き止まりだった。実際にやることは
 *                              **その Rev にファイルを登録すること**なので、S-5 へ送る
 *   削除済み                 — **サーバーは通す**。`putNewDocument` の条件式が
 *                              `attribute_not_exists(sortKey) OR status = '削除済み'` で、
 *                              論理削除した番号は発行し直せるという規律そのもの
 *                              （CLAUDE.md §5）。画面が断るのは §7 に反する
 *
 * 「最新」「旧版」はここで止める。どちらもこの文書IDの系列が既に先へ進んでいて、
 * 同じ番号を作り直す操作にはならないため。**状態を併記する** —
 * 番号だけ言われても、次に何をすればよいか判断できない。
 */
function nextRevisionConflict(next: DocumentRecord): Conflict | null {
  if (next.status === '削除済み') return null;

  const revision = next.revision;
  const uploadAction = {
    href: `#/documents/${encodeURIComponent(next.documentNo)}/upload`,
    label: `Rev ${revision} をアップロード`,
  };

  if (next.status === 'ファイル未登録') {
    return {
      message: `Rev ${revision} は既に台帳にあります（ファイル未登録）。この Rev にファイルを登録してください`,
      action: uploadAction,
    };
  }

  if (next.status === '一部登録') {
    const missing = missingFileLabels(next);

    /**
     * 両方揃っているのに「一部登録」。段1（キーの記録）と段2（状態の更新）の
     * 隙間に入るとここへ来る（`ineligibleRevisionMessage` と同じ理由）。
     *
     * **S-5 へ送ってはいけない。** 登録するものが無く「両方登録済み」で断られ、
     * 案内した先が行き止まりになる。待てば非同期Lambdaが「最新」にする。
     */
    if (missing.length === 0) {
      return {
        message: `Rev ${revision} は既に台帳にあります（登録処理中）。しばらく待ってからやり直してください`,
      };
    }

    return {
      message: `Rev ${revision} は既に台帳にあります（一部登録）。${missing.join('と')}が未登録です`,
      action: uploadAction,
    };
  }

  return { message: `Rev ${revision} は既に台帳にあります（${next.status}）` };
}

/**
 * 台帳に登録されていないファイル種別。
 *
 * **判断に使うのは状態ではなく S3キーの有無。** 段1（キーの記録）から
 * 段2（状態の更新）までにわずかな隙があり、その間はどちらの種別が埋まっているかを
 * 状態からは判断できない（backend/src/routes/createRevision.ts と同じ理由）。
 */
function missingFileLabels(doc: DocumentRecord): string[] {
  return [
    doc.s3KeyPdf === undefined ? 'PDF' : null,
    doc.s3KeyExcel === undefined ? 'エクセル' : null,
  ].filter((label): label is string => label !== null);
}

/**
 * 「最新」以外からのリビジョンアップを早期に案内する（CLAUDE.md §7 の検証の二重化）。
 *
 * **正はサーバー側**（`backend/src/routes/createRevision.ts` の同名の判定・
 * `incompleteRevisionMessage`）。ここは「実行してから409で気づく」を防ぐためだけに存在し、
 * 同じ4状態・同じ文言をそのまま繰り返している。
 *
 * 不足の判定に使うのは状態ではなく **S3キーの有無**。段1（キーの記録）から
 * 段2（状態の更新）までにわずかな隙があり、その間はどちらの種別が埋まっているかを
 * 状態からは判断できないため（backend と同じ理由）。
 */
function ineligibleRevisionMessage(doc: DocumentRecord): string | null {
  if (doc.status === '最新') return null;

  if (doc.status === '旧版') {
    return 'このリビジョンは旧版です。最新のリビジョンからリビジョンアップしてください';
  }
  if (doc.status === '削除済み') {
    return 'このリビジョンは削除済みです。新規発行でやり直してください';
  }

  const missing = missingFileLabels(doc);

  if (missing.length === 2) {
    return 'このリビジョンにはまだファイルが登録されていません。PDFとエクセルを登録して「最新」にしてからリビジョンアップしてください';
  }
  if (missing.length === 1) {
    return `このリビジョンは${missing[0]}が未登録です。登録して「最新」にしてからリビジョンアップしてください`;
  }

  // 両方揃っているのに「最新」でない。段1と段2の隙間に入った場合にここへ来る（backendと同じ理由）
  return 'このリビジョンは登録処理中です。しばらく待ってからやり直してください';
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

/**
 * 進めない理由を出す画面。
 *
 * `action` は「ここからやり直せる」導線（S-5 へのリンク）。
 * **行き止まりにしないために要る** — 理由だけ出して一覧へ戻らせると、
 * 利用者は次に何をすればよいか分からないまま同じ操作を繰り返す。
 */
function messagePage(message: string, documentNo: string, action?: Conflict['action']): string {
  const actionLink =
    action === undefined
      ? ''
      : `<a class="btn-primary" href="${escapeHtml(action.href)}">${escapeHtml(action.label)}</a>`;

  return `
    <h1>リビジョンアップ</h1>
    <p class="form-error" role="alert">${escapeHtml(message)}</p>
    <p>対象の文書番号：${escapeHtml(documentNo)}</p>
    <div class="result-actions">
      ${actionLink}
      <a class="btn-end" href="#/">一覧へ戻る</a>
    </div>
  `;
}
