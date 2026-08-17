/**
 * S-6 マスタ管理（screens.md §5）。
 *
 * プルダウンの選択肢を追加・修正する（F-10）。削除はせず「無効」にする
 * （過去の文書が参照しているため物理削除しない）。
 * `POST /masters`・`PATCH /masters/{id}` に接続済み。
 */

import { buildMasterId } from '../../../shared/masterId';
import type { MasterCategory, MasterRecord, NumberingRule } from '../../../shared/types';
import { apiPatchAuthed, apiPostAuthed } from '../lib/api';
import { isMasterResponse } from '../lib/guards';
import { escapeHtml } from '../lib/html';
import { isLastActiveOwner } from '../lib/masters';
import { allMasters, upsertMaster } from '../lib/store';

const CATEGORIES: MasterCategory[] = ['文書種類', '製品コード', '工程番号', '担当者'];

/**
 * SK と S3キーを壊す文字は登録させない（CLAUDE.md §4）。
 * `#` は SK の結合に、`/` は S3キー・URLパスに使っているため、
 * 名称に混ざると `文書ID#リビジョン` の分解やキーの組み立てが壊れる。
 *
 * **正はサーバー側**（CLAUDE.md §7）。ここでの検証は誤りを早く知らせるためだけのもの。
 */
const FORBIDDEN_CHARS = ['#', '/'];

/** 入力中の値。保存に失敗しても打ち直させないために保持する */
type Draft = { code: string; name: string; numberingRule: string; isCommon: boolean };

type State = {
  category: MasterCategory;
  /** 編集中の行のコード。null なら新規追加の行を出す */
  editing: string | null;
  adding: boolean;
  error: string;
  draft: Draft | null;
};

/**
 * 応答待ちの間に、この描画がまだ生きているかを判断するための2つ。
 *
 * **要素が文書に繋がっているかでは判断できない。** この画面は `draw()` が
 * `#app` の中身を丸ごと差し替えるので、タブの切り替え・`[追加]`・`[修正]`・
 * `[キャンセル]` のたびに以前の要素が切り離される。それを「移動した」と読むと、
 * **通信中にタブを触っただけでサーバーの拒否理由が出なくなる**。
 *
 * 見分けたいのは次の2つだけで、自分のページ内の描き直しはどちらでもない。
 *
 *   `activeRender` — 同じ画面が改めて描かれた（`main.ts` の `refreshRoute()` が
 *                    新しい `state` を作った）。古い `state` で描き直すと、
 *                    開いていたタブや編集行が巻き戻る
 *   `activeRoute`  — 別の画面へ移った。番号は増えないのでこちらでしか分からない
 *                    （画面遷移はすべてハッシュ経由）
 */
let activeRender = 0;
let activeRoute = '';

function isCurrentRender(render: number): boolean {
  return render === activeRender && location.hash === activeRoute;
}

export function renderMasters(): void {
  const app = document.querySelector<HTMLElement>('#app');
  if (!app) return;

  const state: State = {
    category: '文書種類',
    editing: null,
    adding: false,
    error: '',
    draft: null,
  };

  const render = ++activeRender;
  activeRoute = location.hash;

  const draw = (): void => {
    app.innerHTML = template(state);
    bindEvents(app, state, draw, render);
  };
  draw();
}

// ---------------------------------------------------------------------------
// 描画
// ---------------------------------------------------------------------------

function template(state: State): string {
  // イベントの登録先をこの要素にする。描き直すたびに作り直されるため、
  // 古いリスナーは要素ごと捨てられる。#app に登録すると、#app は残り続けるので
  // 描き直しのたびにリスナーが積み上がり、1回のクリックでハンドラが何度も走る。
  return `
    <div id="masters-root">
    <h1>マスタ管理</h1>
    <div class="tab-bar">
      ${CATEGORIES.map((c) => tabButton(c, state.category)).join('')}
    </div>

    ${state.error === '' ? '' : `<p class="form-error" role="alert">${escapeHtml(state.error)}</p>`}

    <table class="document-table">
      <thead>
        <tr>
          <th>コード</th>
          <th>名称</th>
          ${state.category === '文書種類' ? '<th>採番ルール</th>' : ''}
          ${state.category === '製品コード' ? '<th>共通コード</th>' : ''}
          <th>状態</th>
          <th>操作</th>
        </tr>
      </thead>
      <tbody>
        ${rowsHtml(state)}
        ${state.adding ? formRow(state, null) : ''}
      </tbody>
    </table>

    ${
      state.category === '担当者'
        ? '<p class="form-note">有効な担当者が1人だけのときは、その担当者を無効化できません（氏名を選べる人がいなくなり、誰も解除できなくなるため）。担当者を入れ替える場合は、先に新しい担当者を追加してください。</p>'
        : ''
    }

    <!--
      **「無効化して追加し直す」を「同じコードで」と読ませない。**
      コードの重複チェックは状態を見ないので（無効化された行もコードを占有する）、
      同じコードでの追加は必ず 409 になる。これは仕様として正しい —
      無効は削除ではなく、過去の文書がそのコードを参照しているため。
      以前の文言は「無効化のうえ正しい内容で追加し直す」とだけ書いており、
      同じコードで直せるように読めた（8/17 の実機確認で判明）。
    -->
    <p class="form-note">コードは検索・保存のキーになるため、登録後は変更できません。コード以外の項目は[修正]で直せます（無効化は不要です）。</p>
    <p class="form-note">コードを誤った場合は、その行を無効化したうえで、正しいコードで新しく追加してください。無効化は削除ではないので、同じコードで追加し直すことはできません。</p>

    <div class="result-actions">
      ${state.adding ? '' : '<button type="button" id="add" class="btn-primary">追加</button>'}
      <a class="btn-end" href="#/">一覧へ戻る</a>
    </div>
    </div>
  `;
}

function tabButton(category: MasterCategory, current: MasterCategory): string {
  const active = category === current ? ' tab-active' : '';
  const label = category === '工程番号' ? '工程番号（工程名）' : category;
  return `<button type="button" class="tab${active}" data-category="${escapeHtml(category)}">${escapeHtml(label)}</button>`;
}

function rowsHtml(state: State): string {
  const records = allMasters().filter((m) => m.category === state.category);
  if (records.length === 0) {
    return `<tr><td colspan="5" class="empty-row">登録がありません</td></tr>`;
  }

  return records
    .map((record) => (state.editing === record.code ? formRow(state, record) : viewRow(state, record)))
    .join('');
}

function viewRow(state: State, record: MasterRecord): string {
  const rule = state.category === '文書種類' ? `<td>${escapeHtml(record.numberingRule ?? '—')}</td>` : '';
  const common =
    state.category === '製品コード' ? `<td>${record.isCommon === true ? '共通' : '—'}</td>` : '';

  return `
    <tr>
      <td>${escapeHtml(record.code)}</td>
      <td>${escapeHtml(record.name)}</td>
      ${rule}
      ${common}
      <td>${escapeHtml(record.status)}</td>
      <td>
        <button type="button" class="btn-row-link" data-edit="${escapeHtml(record.code)}">修正</button>
        ${statusButton(record)}
      </td>
    </tr>
  `;
}

/**
 * `[無効化]`/`[有効化]` のどちらを出すか。
 *
 * **最後の有効な担当者には `[無効化]` を出さない。** 押せてしまうと有効な担当者が
 * 0人になり、S-2 の氏名プルダウンが空になって**誰も解除できなくなる**。
 * この画面はトークンが要るので、有効化して戻すこともできない
 * （復旧は `scripts/seed-masters.sh`＝AWS権限）。
 *
 * **正はサーバー側**（`backend/src/routes/updateMaster.ts` が 409 で断る）。
 * ここで消しているのは、押してから断られるより押せないほうが分かりやすいからで、
 * 画面の制御は開発者ツールから回避できる（CLAUDE.md §7）。
 * 理由は表の下の注記で伝える（ボタンが無い理由が読み取れないため）。
 */
function statusButton(record: MasterRecord): string {
  if (record.status !== '有効') {
    return `<button type="button" class="btn-row-link" data-enable="${escapeHtml(record.code)}">有効化</button>`;
  }
  if (record.category === '担当者' && isLastActiveOwner(record.code)) return '';
  return `<button type="button" class="btn-row-link" data-disable="${escapeHtml(record.code)}">無効化</button>`;
}

/** 追加（record = null）と修正で同じ行を使う。項目が同じなので分ける理由がない */
function formRow(state: State, record: MasterRecord | null): string {
  const code = state.draft?.code ?? record?.code ?? '';
  const name = state.draft?.name ?? record?.name ?? '';
  const selectedRule = (state.draft?.numberingRule as NumberingRule | undefined) ?? record?.numberingRule;
  const isCommon = state.draft?.isCommon ?? record?.isCommon ?? false;

  // 共通コード（製品によらない作業）。工程単位の文書種類だけが紐づく
  const common =
    state.category === '製品コード'
      ? `<td><input type="checkbox" name="isCommon"${isCommon ? ' checked' : ''} /></td>`
      : '';

  const rule =
    state.category === '文書種類'
      ? `<td>
           <select name="numberingRule">
             ${numberingRuleOptions(selectedRule)}
           </select>
         </td>`
      : '';

  return `
    <tr class="editing-row">
      <td>
        <input name="code" value="${escapeHtml(code)}" ${record === null ? '' : 'readonly'} />
      </td>
      <td><input name="name" value="${escapeHtml(name)}" /></td>
      ${rule}
      ${common}
      <td>${escapeHtml(record?.status ?? '有効')}</td>
      <td>
        <button type="button" class="btn-row-link" id="save">保存</button>
        <button type="button" class="btn-row-link" id="cancel">取消</button>
      </td>
    </tr>
  `;
}

function numberingRuleOptions(selected: NumberingRule | undefined): string {
  return (['製品単位', '工程単位'] as NumberingRule[])
    .map((rule) => `<option value="${rule}"${rule === selected ? ' selected' : ''}>${rule}</option>`)
    .join('');
}

// ---------------------------------------------------------------------------
// 操作
// ---------------------------------------------------------------------------

function bindEvents(app: HTMLElement, state: State, draw: () => void, render: number): void {
  const root = app.querySelector<HTMLElement>('#masters-root');
  if (root === null) return;

  root.addEventListener('click', (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;

    const tab = target.closest<HTMLElement>('.tab');
    if (tab?.dataset.category !== undefined) {
      state.category = tab.dataset.category as MasterCategory;
      state.editing = null;
      state.adding = false;
      state.error = '';
      state.draft = null;
      draw();
      return;
    }

    if (target.id === 'add') {
      state.adding = true;
      state.editing = null;
      state.error = '';
      state.draft = null;
      draw();
      return;
    }

    if (target.id === 'cancel') {
      state.adding = false;
      state.editing = null;
      state.error = '';
      state.draft = null;
      draw();
      return;
    }

    if (target.id === 'save') {
      // save() 自身が結果に応じて draw() まで行う（送信中の二重クリックを防ぐため）
      void save(app, state, draw, render);
      return;
    }

    const editCode = target.dataset.edit;
    if (editCode !== undefined) {
      state.editing = editCode;
      state.adding = false;
      state.error = '';
      state.draft = null;
      draw();
      return;
    }

    // 物理削除はしない。過去の文書が参照しているため状態だけを変える
    const disableCode = target.dataset.disable;
    if (disableCode !== undefined) {
      void setStatus(state, draw, disableCode, '無効', target, render);
      return;
    }

    const enableCode = target.dataset.enable;
    if (enableCode !== undefined) {
      void setStatus(state, draw, enableCode, '有効', target, render);
    }
  });
}

/**
 * `[無効化]`/`[有効化]` の実行（`PATCH /masters/{id}`）。
 *
 * 二重に押すと2回目は理由の分からない失敗に見えるので、送信中はボタンを止める。
 * ここで無効化しても再描画（`draw()`）で作り直されるため、明示的に戻す必要はない。
 *
 * **応答が返るまでに画面が変わっていることがある**（別の画面へ移る／解除・ロックの
 * 切り替えで `main.ts` が描き直す）。判定は `isCurrentRender` で行う。
 * **ストアへの反映は画面より先**に済ませる — 変更はサーバー側で成功しているため。
 */
async function setStatus(
  state: State,
  draw: () => void,
  code: string,
  status: MasterRecord['status'],
  button: HTMLElement,
  render: number,
): Promise<void> {
  if (button instanceof HTMLButtonElement) button.disabled = true;

  const result = await apiPatchAuthed(
    `/masters/${encodeURIComponent(buildMasterId(state.category, code))}`,
    { status },
    isMasterResponse,
  );

  if (!result.ok) {
    if (!isCurrentRender(render)) return;
    state.error = result.message;
    draw();
    return;
  }

  upsertMaster(result.data.master);

  if (!isCurrentRender(render)) return;

  state.error = '';
  draw();
}

/**
 * `[追加]`/`[修正]` の保存（`POST /masters`・`PATCH /masters/{id}`）。
 *
 * どちらのエンドポイントを呼ぶかは、同じコードの既存レコードがあるかで決める
 * （追加行は必ず無く、修正行はコード欄が readonly で必ずある）。
 */
async function save(
  app: HTMLElement,
  state: State,
  draw: () => void,
  render: number,
): Promise<void> {
  const row = app.querySelector<HTMLElement>('.editing-row');
  if (row === null) return;

  const code = inputValue(row, 'code').trim();
  const name = inputValue(row, 'name').trim();
  const numberingRule = inputValue(row, 'numberingRule') as NumberingRule | '';
  const isCommon = row.querySelector<HTMLInputElement>('[name="isCommon"]')?.checked ?? false;

  // 失敗しても打ち直させないよう、検証の前に入力値を控える
  state.draft = { code, name, numberingRule, isCommon };

  state.error = validate(state, code, name);
  if (state.error !== '') {
    draw();
    return;
  }

  const saveButton = row.querySelector<HTMLButtonElement>('#save');
  if (saveButton) {
    saveButton.disabled = true;
    saveButton.textContent = '保存中…';
  }

  const existing = allMasters().find((m) => m.category === state.category && m.code === code);

  const body = {
    ...(state.category === '文書種類' && numberingRule !== '' ? { numberingRule } : {}),
    ...(state.category === '製品コード' ? { isCommon } : {}),
  };

  const result =
    existing === undefined
      ? await apiPostAuthed('/masters', { category: state.category, code, name, ...body }, isMasterResponse)
      : await apiPatchAuthed(
          `/masters/${encodeURIComponent(buildMasterId(state.category, code))}`,
          { name, ...body },
          isMasterResponse,
        );

  /**
   * **応答を待つ間に画面が変わっていないか**（`isCurrentRender` の説明を見ること）。
   * 変わっていればそこへ `draw()` してはいけない — **いま出ている画面を
   * マスタ管理で上書きする**ことになる。
   *
   * ストアへの反映は画面より先に済ませる。保存はサーバー側で成功しているので、
   * 利用者が別の画面へ移っていてもマスタには載せる（8/14 の決定）。
   */
  if (!result.ok) {
    if (!isCurrentRender(render)) return;
    state.error = result.message;
    draw();
    return;
  }

  upsertMaster(result.data.master);

  if (!isCurrentRender(render)) return;

  state.adding = false;
  state.editing = null;
  state.error = '';
  state.draft = null;
  draw();
}

function validate(state: State, code: string, name: string): string {
  if (code === '' || name === '') return 'コードと名称は必須です';

  for (const char of FORBIDDEN_CHARS) {
    if (code.includes(char) || name.includes(char)) {
      return `「${char}」は使えません（文書番号のキーとS3のパスが壊れるため）`;
    }
  }

  // 修正のときはコード欄が readonly なので、重複が問題になるのは追加のときだけ
  if (state.adding && allMasters().some((m) => m.category === state.category && m.code === code)) {
    return 'このコードは既に登録されています';
  }

  return '';
}

function inputValue(row: HTMLElement, name: string): string {
  const el = row.querySelector<HTMLInputElement | HTMLSelectElement>(`[name="${name}"]`);
  return el?.value ?? '';
}
