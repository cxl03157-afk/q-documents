/**
 * S-6 マスタ管理（screens.md §5）。
 *
 * プルダウンの選択肢を追加・修正する（F-10）。削除はせず「無効」にする
 * （過去の文書が参照しているため物理削除しない）。
 * 週2で `GET/POST/PATCH /masters` に接続する。
 */

import type { MasterCategory, MasterRecord, NumberingRule } from '../../../shared/types';
import { escapeHtml } from '../lib/html';
import { mockMasters } from '../mock/masters';

const CATEGORIES: MasterCategory[] = ['文書種類', '製品コード', '工程番号', '担当者'];

/**
 * SK と S3キーを壊す文字は登録させない（CLAUDE.md §4）。
 * `#` は SK の結合に、`/` は S3キー・URLパスに使っているため、
 * 名称に混ざると `文書ID#リビジョン` の分解やキーの組み立てが壊れる。
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

  const draw = (): void => {
    app.innerHTML = template(state);
    bindEvents(app, state, draw);
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
  const records = mockMasters.filter((m) => m.category === state.category);
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
        ${
          record.status === '有効'
            ? `<button type="button" class="btn-row-link" data-disable="${escapeHtml(record.code)}">無効化</button>`
            : `<button type="button" class="btn-row-link" data-enable="${escapeHtml(record.code)}">有効化</button>`
        }
      </td>
    </tr>
  `;
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

function bindEvents(app: HTMLElement, state: State, draw: () => void): void {
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
      save(app, state);
      draw();
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
      setStatus(state.category, disableCode, '無効');
      draw();
      return;
    }

    const enableCode = target.dataset.enable;
    if (enableCode !== undefined) {
      setStatus(state.category, enableCode, '有効');
      draw();
    }
  });
}

function setStatus(category: MasterCategory, code: string, status: MasterRecord['status']): void {
  const record = mockMasters.find((m) => m.category === category && m.code === code);
  if (record !== undefined) record.status = status;
}

function save(app: HTMLElement, state: State): void {
  const row = app.querySelector<HTMLElement>('.editing-row');
  if (row === null) return;

  const code = inputValue(row, 'code').trim();
  const name = inputValue(row, 'name').trim();
  const numberingRule = inputValue(row, 'numberingRule') as NumberingRule | '';
  const isCommon = row.querySelector<HTMLInputElement>('[name="isCommon"]')?.checked ?? false;

  // 失敗しても打ち直させないよう、検証の前に入力値を控える
  state.draft = { code, name, numberingRule, isCommon };

  state.error = validate(state, code, name);
  if (state.error !== '') return;

  const existing = mockMasters.find((m) => m.category === state.category && m.code === code);
  if (existing === undefined) {
    mockMasters.push({
      category: state.category,
      code,
      name,
      status: '有効',
      registeredAt: new Date().toISOString().slice(0, 10),
      ...(state.category === '文書種類' && numberingRule !== '' ? { numberingRule } : {}),
      ...(state.category === '製品コード' ? { isCommon } : {}),
    });
  } else {
    existing.name = name;
    if (state.category === '文書種類' && numberingRule !== '') existing.numberingRule = numberingRule;
    if (state.category === '製品コード') existing.isCommon = isCommon;
  }

  state.adding = false;
  state.editing = null;
  state.draft = null;
}

function validate(state: State, code: string, name: string): string {
  if (code === '' || name === '') return 'コードと名称は必須です';

  for (const char of FORBIDDEN_CHARS) {
    if (code.includes(char) || name.includes(char)) {
      return `「${char}」は使えません（文書番号のキーとS3のパスが壊れるため）`;
    }
  }

  // 修正のときはコード欄が readonly なので、重複が問題になるのは追加のときだけ
  if (state.adding && mockMasters.some((m) => m.category === state.category && m.code === code)) {
    return 'このコードは既に登録されています';
  }

  return '';
}

function inputValue(row: HTMLElement, name: string): string {
  const el = row.querySelector<HTMLInputElement | HTMLSelectElement>(`[name="${name}"]`);
  return el?.value ?? '';
}
