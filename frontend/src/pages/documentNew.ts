/**
 * S-3 新規文書発行（screens.md §5）。
 *
 * 命名ルールに従って文書番号を採番し、台帳に「ファイル未登録」で記録する。
 * 週2で `POST /documents/number-preview` と `POST /documents` に接続する。
 */

import type { NumberingRule } from '../../../shared/types';
import { apiPost, apiPostAuthed } from '../lib/api';
import {
  type ExistingDocument,
  isDocumentResponse,
  isNumberPreviewResponse,
  readExisting,
} from '../lib/guards';
import { escapeHtml } from '../lib/html';
import {
  activeMasters,
  findMaster,
  isCommonProductCode,
  selectableDocumentTypes,
} from '../lib/masters';
import { upsertDocument } from '../lib/store';

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
  /** 既に同じ文書がある場合の現行リビジョン。S-4 への導線を出すために持つ */
  duplicate: ExistingDocument | null;
  /** 通信中。二重送信を防ぐためにボタンを無効化する */
  busy: boolean;
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
    busy: false,
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
  // 番号を出したあとは入力を変えさせない。変えられると、表示中の番号と
  // これから登録される内容が食い違う（登録は入力からサーバーが導出し直すため）
  const locked = state.step !== 'input' || state.busy ? ' disabled' : '';

  return `
    <form id="new-form" class="entry-form">
      <fieldset class="entry-fieldset"${locked}>
        <label class="form-field">
          <span>文書種類</span>
          <select name="documentType" required>
            <option value="">選択してください</option>
            ${optionsHtml(selectableDocumentTypes(state.productCode).map((m) => ({ value: m.code, label: m.name })), state.documentType)}
          </select>
          ${
            isCommonProductCode(state.productCode)
              ? '<span class="form-note">共通コードのため、工程単位の文書種類だけを表示しています</span>'
              : ''
          }
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

      ${
        state.step === 'input'
          ? `<button type="submit" class="btn-primary"${state.busy ? ' disabled' : ''}>${
              state.busy ? '生成中…' : '番号を生成'
            }</button>`
          : ''
      }
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

  // 現行リビジョンが取れなかったときは導線を出さない。
  // 誤った文書番号のリンクを出すより、一覧から探してもらうほうがよい
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
          <button type="button" id="register" class="btn-primary"${state.busy ? ' disabled' : ''}>${
            state.busy ? '登録中…' : '登録'
          }</button>
          <button type="button" id="back-to-input" class="btn-end"${state.busy ? ' disabled' : ''}>入力に戻る</button>
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
    if (state.busy) return;

    readForm(form, state);
    void run(state, draw, () => previewNumber(state));
  });

  app.querySelector<HTMLButtonElement>('#register')?.addEventListener('click', () => {
    if (state.busy) return;
    void run(state, draw, () => register(state));
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

  // 共通コードに切り替えたとき、選択済みの文書種類が対象外になることがある。
  // 残しておくと、選択肢に出ていない種類のまま採番できてしまう
  const stillSelectable = selectableDocumentTypes(state.productCode).some(
    (t) => t.code === state.documentType,
  );
  if (!stillSelectable) state.documentType = '';

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
 * 通信を1本ずつに絞って走らせる。
 *
 * `busy` を立ててから描き直すので、押した直後にボタンが無効になる。
 * これが無いと、二重に押せば同じ文書を2回登録しようとする（2回目はサーバーが
 * 409 で弾くが、利用者には理由の分からない失敗として出る）。
 */
async function run(state: State, draw: () => void, task: () => Promise<void>): Promise<void> {
  state.busy = true;
  draw();

  try {
    await task();
  } finally {
    state.busy = false;
    draw();
  }
}

/**
 * サーバーに文書番号を出してもらう（`POST /documents/number-preview`）。
 *
 * **既存文書の照合はサーバーに任せる。** 手元の台帳で調べる方式は採らない —
 * 他の人が登録した文書を見落とすし、古い情報で誤って拒否することもある。
 * 照合の正はサーバー1か所（CLAUDE.md §7）。409 の応答に現行リビジョンが
 * 付いてくるので、S-4 への導線もそこから作れる。
 *
 * マスタ由来の検証だけは手前に残す。往復せずに誤りを知らせるためで、
 * 「選択してください」の類はサーバーへ行くまでもない。
 */
async function previewNumber(state: State): Promise<void> {
  state.error = '';
  state.duplicate = null;
  state.documentNo = '';

  const validationError = validateInput(state);
  if (validationError !== null) {
    state.error = validationError;
    return;
  }

  const result = await apiPost(
    '/documents/number-preview',
    {
      documentType: state.documentType,
      productCode: state.productCode,
      // 製品単位の文書種類に工程番号を送るとサーバーが拒否する。
      // 種類を切り替えたときの残りが混ざらないよう、ここで落とす
      processNo: numberingRuleOf(state.documentType) === '工程単位' ? state.processNo : undefined,
    },
    isNumberPreviewResponse,
  );

  if (!result.ok) {
    state.error = result.message;
    // 409 のときだけ現行リビジョンが付いてくる（docs/API.md）
    state.duplicate = readExisting(result.payload);
    return;
  }

  state.documentNo = result.data.documentNo;
  state.step = 'previewed';
}

/**
 * 画面側の事前検証（CLAUDE.md §7 の二重化）。
 *
 * **正はサーバー側。** ここはプルダウンの選び忘れを往復せずに知らせるためのもので、
 * 開発者ツールから回避できる。同じ判定はサーバーの `deriveDocumentNumber` にもある。
 */
function validateInput(state: State): string | null {
  const rule = numberingRuleOf(state.documentType);
  if (rule === undefined) return '文書種類を選択してください';

  if (findMaster('製品コード', state.productCode) === undefined) {
    return state.productCode === ''
      ? '製品コードを選択してください'
      : '製品コードがマスタに登録されていません。マスタ管理で追加してから戻ってください';
  }

  if (isCommonProductCode(state.productCode) && rule !== '工程単位') {
    return '共通コードには工程単位の文書種類（作業指示書）だけを登録できます';
  }

  if (rule === '工程単位' && findMaster('工程番号', state.processNo) === undefined) {
    return '工程番号を選択してください';
  }

  if (state.owner === '') return '担当者を選択してください';
  if (state.issuedAt === '') return '文書発行日を入力してください';

  return null;
}

/**
 * 台帳に記録する（`POST /documents`）。合言葉のトークンが要る。
 *
 * **文書番号は送らない。** サーバーが入力から導出し直す。プレビューで見た番号と
 * 違うものが登録されることはない（同じ導出関数を通るため）。
 * 送って照合させる方式にすると、命名ルールの検証がサーバー側に二重に要る。
 *
 * 応答で返ってきたレコードをそのままストアへ入れる。全件を読み直さないのは、
 * 1件のために台帳を取り直す必要がないため。
 */
async function register(state: State): Promise<void> {
  state.error = '';

  const result = await apiPostAuthed(
    '/documents',
    {
      documentType: state.documentType,
      productCode: state.productCode,
      processNo: numberingRuleOf(state.documentType) === '工程単位' ? state.processNo : undefined,
      owner: state.owner,
      issuedAt: state.issuedAt,
    },
    isDocumentResponse,
  );

  if (!result.ok) {
    state.error = result.message;
    state.duplicate = readExisting(result.payload);
    // 番号の表示に戻さない。既に登録済みなら、その番号はもう使えない
    if (result.status === 409) state.step = 'input';
    return;
  }

  upsertDocument(result.data.document);
  // 表示する番号はサーバーが確定したものにする（導出をやり直しているため）
  state.documentNo = result.data.document.documentNo;
  state.step = 'registered';
}
