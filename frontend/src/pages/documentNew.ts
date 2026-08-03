/**
 * S-3 新規文書発行（screens.md §5）。
 *
 * 命名ルールに従って文書番号を採番し、台帳に「ファイル未登録」で記録する。
 * 週2で `POST /documents/number-preview` と `POST /documents` に接続する。
 */

import type { DocumentRecord, NumberingRule } from '../../../shared/types';
import { INITIAL_REVISION, buildDocumentNo, buildSortKey } from '../../../shared/documentNo';
import { escapeHtml } from '../lib/html';
import { addMockDocument, mockDocuments } from '../mock/documents';
import { activeMasters, findMaster } from '../mock/masters';

type Step = 'input' | 'previewed' | 'registered';

type State = {
  step: Step;
  documentType: string;
  productCode: string;
  processNo: string;
  owner: string;
  issuedAt: string;
  documentNo: string;
  error: string;
  /** 既に同じ文書がある場合の現行レコード。S-4 への導線を出すために持つ */
  duplicate: DocumentRecord | null;
};

export function renderDocumentNew(): void {
  const app = document.querySelector<HTMLElement>('#app');
  if (!app) return;

  const state: State = {
    step: 'input',
    documentType: '',
    productCode: '',
    processNo: '',
    owner: '',
    issuedAt: todayIso(),
    documentNo: '',
    error: '',
    duplicate: null,
  };

  const draw = (): void => {
    app.innerHTML = template(state);
    bindEvents(app, state, draw);
  };
  draw();
}

/** 日付入力の既定値。toISOString() はUTCなので、時差で前日になることがある */
function todayIso(): string {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${now.getFullYear()}-${month}-${day}`;
}

// ---------------------------------------------------------------------------
// 描画
// ---------------------------------------------------------------------------

function template(state: State): string {
  return `
    <h1>新規文書発行</h1>
    ${formTemplate(state)}
    ${resultTemplate(state)}
  `;
}

function formTemplate(state: State): string {
  const rule = numberingRuleOf(state.documentType);
  const locked = state.step !== 'input' ? ' disabled' : '';

  return `
    <form id="new-form" class="entry-form">
      <fieldset class="entry-fieldset"${locked}>
        <label class="form-field">
          <span>文書種類</span>
          <select name="documentType" required>
            <option value="">選択してください</option>
            ${optionsHtml(activeMasters('文書種類').map((m) => ({ value: m.code, label: m.name })), state.documentType)}
          </select>
        </label>

        <label class="form-field">
          <span>製品コード</span>
          <!--
            入力補完付きのテキスト入力ではなくプルダウンにする。
            マスタに登録された値しか選べないので打ち間違いが起きず、他の欄と操作感も揃う
            （screens.md §6「文字入力は極力させず、プルダウンで選ばせる」）。
            候補が増えて選びにくくなったら入力補完を検討する。
          -->
          <select name="productCode" required>
            <option value="">選択してください</option>
            ${optionsHtml(activeMasters('製品コード').map((m) => ({ value: m.code, label: `${m.code}（${m.name}）` })), state.productCode)}
          </select>
        </label>

        ${rule === '工程単位' ? processFields(state) : ''}

        <label class="form-field">
          <span>担当者</span>
          <select name="owner" required>
            <option value="">選択してください</option>
            ${optionsHtml(activeMasters('担当者').map((m) => ({ value: m.name, label: m.name })), state.owner)}
          </select>
        </label>

        <label class="form-field">
          <span>文書発行日</span>
          <input type="date" name="issuedAt" required value="${escapeHtml(state.issuedAt)}" />
        </label>
      </fieldset>

      ${errorTemplate(state)}

      ${state.step === 'input' ? '<button type="submit" class="btn-primary">番号を生成</button>' : ''}
    </form>
  `;
}

/** 採番ルールが「工程単位」のときだけ出す（screens.md S-3） */
function processFields(state: State): string {
  const processName = findMaster('工程番号', state.processNo)?.name ?? '';

  return `
    <label class="form-field">
      <span>工程番号</span>
      <select name="processNo" required>
        <option value="">選択してください</option>
        ${optionsHtml(activeMasters('工程番号').map((m) => ({ value: m.code, label: `${m.code}（${m.name}）` })), state.processNo)}
      </select>
    </label>
    <label class="form-field">
      <span>工程名</span>
      <!-- 工程番号と1対1なので選ばせない。対で選ばせると実在しない組み合わせが作れる -->
      <input name="processName" readonly value="${escapeHtml(processName)}" placeholder="工程番号を選ぶと表示されます" />
    </label>
  `;
}

function errorTemplate(state: State): string {
  if (state.error === '') return '';

  const link =
    state.duplicate === null
      ? ''
      : ` <a href="#/documents/${encodeURIComponent(state.duplicate.documentNo)}/revise">リビジョンアップへ</a>`;

  return `<p class="form-error" id="new-error" role="alert">${escapeHtml(state.error)}${link}</p>`;
}

function resultTemplate(state: State): string {
  if (state.step === 'previewed') {
    return `
      <div class="result-panel">
        <p>生成された文書番号</p>
        <p class="result-number">${escapeHtml(state.documentNo)}</p>
        <p>この番号を文書に記入し、ファイル名にも付けてください。</p>
        <div class="result-actions">
          <button type="button" id="register" class="btn-primary">登録</button>
          <button type="button" id="back-to-input" class="btn-end">入力に戻る</button>
        </div>
      </div>
    `;
  }

  if (state.step === 'registered') {
    return `
      <div class="result-panel">
        <p>台帳に登録しました。状態は「ファイル未登録」です。</p>
        <p class="result-number">${escapeHtml(state.documentNo)}</p>
        <p>一覧では、状態の絞り込みで「ファイル未登録」を選ぶと表示されます。</p>
        <div class="result-actions">
          <a class="btn-primary" href="#/documents/${encodeURIComponent(state.documentNo)}/upload">ファイルをアップロードする</a>
          <a class="btn-end" href="#/">一覧へ戻る</a>
        </div>
      </div>
    `;
  }

  return '';
}

type SelectOption = { value: string; label: string };

function optionsHtml(options: SelectOption[], selected: string): string {
  return options
    .map((opt) => {
      const isSelected = opt.value === selected ? ' selected' : '';
      return `<option value="${escapeHtml(opt.value)}"${isSelected}>${escapeHtml(opt.label)}</option>`;
    })
    .join('');
}

// ---------------------------------------------------------------------------
// 操作
// ---------------------------------------------------------------------------

function bindEvents(app: HTMLElement, state: State, draw: () => void): void {
  const form = app.querySelector<HTMLFormElement>('#new-form');

  // 文書種類で工程欄の要否が変わり、工程番号で工程名の表示が変わるため、変更のたびに描き直す。
  // change はテキスト入力では確定（blur）時に発火するので、入力中に描き直されることはない。
  form?.addEventListener('change', () => {
    readForm(form, state);
    draw();
  });

  form?.addEventListener('submit', (event) => {
    event.preventDefault();
    readForm(form, state);
    generateNumber(state);
    draw();
  });

  app.querySelector<HTMLButtonElement>('#register')?.addEventListener('click', () => {
    register(state);
    draw();
  });

  app.querySelector<HTMLButtonElement>('#back-to-input')?.addEventListener('click', () => {
    state.step = 'input';
    state.documentNo = '';
    draw();
  });
}

function readForm(form: HTMLFormElement, state: State): void {
  state.documentType = fieldValue(form, 'documentType');
  state.productCode = fieldValue(form, 'productCode');
  state.processNo = fieldValue(form, 'processNo');
  state.owner = fieldValue(form, 'owner');
  state.issuedAt = fieldValue(form, 'issuedAt');
}

function fieldValue(form: HTMLFormElement, name: string): string {
  const el = form.elements.namedItem(name);
  if (el instanceof HTMLSelectElement || el instanceof HTMLInputElement) return el.value;
  return '';
}

function numberingRuleOf(documentType: string): NumberingRule | undefined {
  return findMaster('文書種類', documentType)?.numberingRule;
}

/**
 * 番号を生成する。マスタ照合と既存文書の照合をここで行う。
 * **画面側の検証は早く知らせるためのもので、正はサーバー側**（CLAUDE.md §7）。
 */
function generateNumber(state: State): void {
  state.error = '';
  state.duplicate = null;
  state.documentNo = '';

  const rule = numberingRuleOf(state.documentType);
  if (rule === undefined) {
    state.error = '文書種類を選択してください';
    return;
  }

  // プルダウンなので通常はマスタにある値しか来ないが、検証は残す。
  // 画面の制御は開発者ツールから回避できる（CLAUDE.md §7）。
  if (findMaster('製品コード', state.productCode) === undefined) {
    state.error =
      state.productCode === ''
        ? '製品コードを選択してください'
        : '製品コードがマスタに登録されていません。マスタ管理で追加してから戻ってください';
    return;
  }

  let processName: string | undefined;
  if (rule === '工程単位') {
    const process = findMaster('工程番号', state.processNo);
    if (process === undefined) {
      state.error = '工程番号を選択してください';
      return;
    }
    processName = process.name;
  }

  const existing = findExisting(state, rule);
  if (existing !== undefined) {
    state.error = `この文書は既に登録されています（現行 Rev ${existing.revision}）。リビジョンアップを使ってください。`;
    state.duplicate = existing;
    return;
  }

  state.documentNo = buildDocumentNo({
    numberingRule: rule,
    documentType: state.documentType,
    productCode: state.productCode,
    processNo: state.processNo,
    processName,
    revision: INITIAL_REVISION,
  });
  state.step = 'previewed';
}

/**
 * 同じ文書が既にあるか調べ、あれば最新のリビジョンを返す。
 * 同じ文書IDで Rev 01 を作れてしまうと、1つの文書に系列が2本できて台帳が壊れる。
 */
function findExisting(state: State, rule: NumberingRule): DocumentRecord | undefined {
  const candidates = mockDocuments.filter(
    (doc) =>
      doc.documentType === state.documentType &&
      doc.productCode === state.productCode &&
      (rule === '製品単位' || doc.processNo === state.processNo),
  );

  return candidates.sort((a, b) => b.revision.localeCompare(a.revision))[0];
}

function register(state: State): void {
  const sortKey = buildSortKey(state.documentNo);
  if (sortKey === null) {
    state.error = '文書番号の形式が不正です';
    return;
  }

  const rule = numberingRuleOf(state.documentType);
  const processName = findMaster('工程番号', state.processNo)?.name;

  addMockDocument({
    productCode: state.productCode,
    sortKey,
    documentNo: state.documentNo,
    documentType: state.documentType,
    ...(rule === '工程単位' ? { processNo: state.processNo, processName } : {}),
    revision: INITIAL_REVISION,
    owner: state.owner,
    issuedAt: state.issuedAt,
    registeredAt: new Date().toISOString(),
    // 状態を書き換えられるのは非同期Lambdaだけ（CLAUDE.md §5）。
    // 新規作成時の「ファイル未登録」だけが同期APIの責務。
    status: 'ファイル未登録',
  });

  state.step = 'registered';
}
