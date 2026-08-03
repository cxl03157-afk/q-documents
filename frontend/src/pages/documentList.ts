/**
 * S-1 一覧・検索（screens.md §5）。
 * 現在の範囲: 一覧表示 + 4条件の絞り込み + 解除時の操作列 + 関連文書パネル（F-06）+ CSV出力（F-08）。
 * データはハードコードで、週2に `GET /documents` へ差し替える。
 */

import type { DocumentRecord, DocumentStatus } from '../../../shared/types';
import { mockDocuments } from '../mock/documents';
import { mockMasters } from '../mock/masters';
import { isUnlocked } from '../auth/session';
import { escapeHtml } from '../lib/html';
import { downloadCsv, toCsv } from '../lib/csv';

/**
 * 工程名の絞り込みは持たない。マスタ上 工程番号と工程名は1対1で、
 * 別々の絞り込みにすると `K001` ＋ `工程2` のように食い違う組み合わせを選べてしまい、
 * 結果が常に0件になる。工程番号の選択肢に工程名を併記して同じ用途を満たす（screens.md S-1）。
 */
type Filters = {
  productCodes: string[];
  processNos: string[];
  documentTypes: string[];
  statuses: DocumentStatus[];
};

// 削除済みは GET /documents が返さない設計（API.md）なので、絞り込みの選択肢にも出さない。
const FILTERABLE_STATUSES: DocumentStatus[] = ['ファイル未登録', '一部登録', '最新', '旧版'];

function defaultFilters(): Filters {
  return {
    productCodes: [],
    processNos: [],
    documentTypes: [],
    statuses: ['最新'],
  };
}

export function renderDocumentList(): void {
  const app = document.querySelector<HTMLElement>('#app');
  if (!app) return;

  let filters = defaultFilters();
  /** 関連文書パネル（F-06）の対象。行を選ぶまでは null */
  let selected: DocumentRecord | null = null;

  app.innerHTML = pageTemplate(filters);

  const redraw = (): void => {
    renderTable(app, filters, selected);
    renderRelatedPanel(app, selected);
  };

  bindEvents(app, {
    onFilterChange: (next) => {
      filters = next;
      // 絞り込みを変えたら選択を解除する。表から消えた行のパネルが残ると対応が分からなくなる
      selected = null;
      redraw();
    },
    onSelect: (doc) => {
      // 同じ行をもう一度押したら閉じる
      selected = selected?.documentNo === doc.documentNo ? null : doc;
      redraw();
    },
    onExport: () => exportCsv(filters),
  });

  redraw();
}

function pageTemplate(filters: Filters): string {
  return `
    <h1>文書一覧・検索</h1>
    <form id="filter-form" class="filter-form">
      ${multiSelect('productCodes', '製品コード', productCodeOptions(), filters.productCodes)}
      ${multiSelect('processNos', '工程番号', processNoOptions(), filters.processNos)}
      ${multiSelect('documentTypes', '文書種類', documentTypeOptions(), filters.documentTypes)}
      ${multiSelect('statuses', '状態', statusOptions(), filters.statuses)}
      <button type="button" id="export-csv" class="btn-end">CSV出力</button>
    </form>
    <table class="document-table">
      <thead>
        <tr>
          <th>文書番号</th>
          <th>文書種類</th>
          <th>製品コード</th>
          <th>工程番号</th>
          <th>工程名</th>
          <th>Rev</th>
          <th>状態</th>
          <th>担当者</th>
          <th>文書発行日</th>
          <th>操作</th>
        </tr>
      </thead>
      <tbody id="document-rows"></tbody>
    </table>
    <div id="related-panel"></div>
  `;
}

type SelectOption = { value: string; label: string };

function multiSelect(
  name: keyof Filters,
  label: string,
  options: SelectOption[],
  selected: string[],
): string {
  const optionsHtml = options
    .map((opt) => {
      const isSelected = selected.includes(opt.value) ? ' selected' : '';
      return `<option value="${escapeHtml(opt.value)}"${isSelected}>${escapeHtml(opt.label)}</option>`;
    })
    .join('');

  return `
    <label class="filter-field">
      <span>${escapeHtml(label)}</span>
      <select name="${name}" multiple size="4">${optionsHtml}</select>
    </label>
  `;
}

function productCodeOptions(): SelectOption[] {
  return mockMasters
    .filter((m) => m.category === '製品コード' && m.status === '有効')
    .map((m) => ({ value: m.code, label: `${m.code}（${m.name}）` }));
}

function processNoOptions(): SelectOption[] {
  return mockMasters
    .filter((m) => m.category === '工程番号' && m.status === '有効')
    .map((m) => ({ value: m.code, label: `${m.code}（${m.name}）` }));
}

function documentTypeOptions(): SelectOption[] {
  return mockMasters
    .filter((m) => m.category === '文書種類' && m.status === '有効')
    .map((m) => ({ value: m.code, label: m.name }));
}

function statusOptions(): SelectOption[] {
  return FILTERABLE_STATUSES.map((status) => ({ value: status, label: status }));
}

type Handlers = {
  onFilterChange: (filters: Filters) => void;
  onSelect: (doc: DocumentRecord) => void;
  onExport: () => void;
};

function bindEvents(app: HTMLElement, handlers: Handlers): void {
  const form = app.querySelector<HTMLFormElement>('#filter-form');
  if (form) {
    form.addEventListener('change', () => handlers.onFilterChange(readFilters(form)));
  }

  app.querySelector<HTMLButtonElement>('#export-csv')?.addEventListener('click', handlers.onExport);

  const tbody = app.querySelector<HTMLTableSectionElement>('#document-rows');
  tbody?.addEventListener('click', (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;

    const button = target.closest<HTMLButtonElement>('.btn-download');
    if (button) {
      const label = button.dataset.fileType === 'pdf' ? 'PDF' : 'エクセル';
      window.alert(`モック: ${button.dataset.doc} の${label}ダウンロードは週3で実装します`);
      return;
    }

    // 操作列のリンク（アップロード等）を押したときは行選択にしない
    if (target.closest('a') !== null) return;

    const row = target.closest<HTMLTableRowElement>('tr[data-doc]');
    const doc = row?.dataset.doc === undefined ? undefined : findByDocumentNo(row.dataset.doc);
    if (doc !== undefined) handlers.onSelect(doc);
  });
}

function findByDocumentNo(documentNo: string): DocumentRecord | undefined {
  return mockDocuments.find((doc) => doc.documentNo === documentNo);
}

function readFilters(form: HTMLFormElement): Filters {
  return {
    productCodes: selectedValues(form, 'productCodes'),
    processNos: selectedValues(form, 'processNos'),
    documentTypes: selectedValues(form, 'documentTypes'),
    statuses: selectedValues(form, 'statuses') as DocumentStatus[],
  };
}

function selectedValues(form: HTMLFormElement, name: string): string[] {
  const select = form.elements.namedItem(name);
  if (!(select instanceof HTMLSelectElement)) return [];
  return Array.from(select.selectedOptions).map((opt) => opt.value);
}

function renderTable(app: HTMLElement, filters: Filters, selected: DocumentRecord | null): void {
  const tbody = app.querySelector<HTMLTableSectionElement>('#document-rows');
  if (!tbody) return;

  const rows = visibleRows(filters);
  tbody.innerHTML =
    rows.length > 0
      ? rows.map((doc) => renderRow(doc, selected)).join('')
      : `<tr><td colspan="10" class="empty-row">該当する文書がありません</td></tr>`;
}

/** 画面に出ている行。CSV出力の対象もこれと同じにする（F-08「表示中の内容」） */
function visibleRows(filters: Filters): DocumentRecord[] {
  // 論理削除済みは `GET /documents` が返さない設計（API.md）。絞り込み以前に一覧へ出さない
  return mockDocuments.filter((doc) => doc.status !== '削除済み' && matchesFilters(doc, filters));
}

function matchesFilters(doc: DocumentRecord, filters: Filters): boolean {
  return (
    matchesList(filters.productCodes, doc.productCode) &&
    matchesList(filters.processNos, doc.processNo) &&
    matchesList(filters.documentTypes, doc.documentType) &&
    matchesList(filters.statuses, doc.status)
  );
}

function matchesList(selected: string[], value: string | undefined): boolean {
  if (selected.length === 0) return true;
  if (value === undefined) return false;
  return selected.includes(value);
}

function renderRow(doc: DocumentRecord, selected: DocumentRecord | null): string {
  const classes = [
    doc.status === '一部登録' ? 'row-warning' : '',
    selected?.documentNo === doc.documentNo ? 'row-selected' : '',
  ].filter((c) => c !== '');
  const classAttr = classes.length === 0 ? '' : ` class="${classes.join(' ')}"`;

  return `
    <tr${classAttr} data-doc="${escapeHtml(doc.documentNo)}">
      <td>${escapeHtml(doc.documentNo)}</td>
      <td>${escapeHtml(documentTypeName(doc.documentType))}</td>
      <td>${escapeHtml(doc.productCode)}</td>
      <td>${escapeHtml(doc.processNo ?? '—')}</td>
      <td>${escapeHtml(doc.processName ?? '—')}</td>
      <td>${escapeHtml(doc.revision)}</td>
      <td>${escapeHtml(doc.status)}</td>
      <td>${escapeHtml(doc.owner)}</td>
      <td>${escapeHtml(doc.issuedAt)}</td>
      <td>${renderActions(doc)}</td>
    </tr>
  `;
}

function documentTypeName(code: string): string {
  const master = mockMasters.find((m) => m.category === '文書種類' && m.code === code);
  return master?.name ?? code;
}

// screens.md §5 S-1 の表（ロック時/解除時でPDF・エクセルの表示可否が変わる）
function renderActions(doc: DocumentRecord): string {
  const unlocked = isUnlocked();
  const buttons: string[] = [];

  if (doc.status === '最新') {
    buttons.push(downloadButton(doc, 'pdf'));
    if (unlocked) buttons.push(downloadButton(doc, 'excel'));
  } else if (doc.status === '旧版' && unlocked) {
    buttons.push(downloadButton(doc, 'pdf'));
    buttons.push(downloadButton(doc, 'excel'));
  }

  // 解除時のみ行に出す書き込み導線（screens.md §5「その他の操作」）
  if (unlocked) {
    // 採番した日とファイルが揃う日は別になるので、一覧からアップロードを再開できるようにする。
    // 「一部登録」には出さない。S-5 が同一種別の登録済みを拒否するため、押せば必ず失敗する
    if (doc.status === 'ファイル未登録') {
      buttons.push(actionLink(doc, 'upload', 'アップロード'));
    }
    buttons.push(actionLink(doc, 'revise', 'リビジョンアップ'));
    buttons.push(actionLink(doc, 'edit', '修正'));
  }

  return buttons.join(' ') || '—';
}

function actionLink(doc: DocumentRecord, path: 'upload' | 'revise' | 'edit', label: string): string {
  const href = `#/documents/${encodeURIComponent(doc.documentNo)}/${path}`;
  return `<a class="btn-row-link" href="${href}">${label}</a>`;
}

function downloadButton(doc: DocumentRecord, fileType: 'pdf' | 'excel'): string {
  const label = fileType === 'pdf' ? 'PDF' : 'エクセル';
  return `<button type="button" class="btn-download" data-doc="${escapeHtml(doc.documentNo)}" data-file-type="${fileType}">${label}</button>`;
}

// ---------------------------------------------------------------------------
// 関連文書パネル（F-06）
// ---------------------------------------------------------------------------

/**
 * 選択した行と同じ製品コードの文書を、文書種類ごとに分けて並べる。
 *
 * **「最新」のものだけを出す**（screens.md「関連文書の最新版を表示」）。
 * 旧版やファイル未登録が混ざると、どれを見ればよいか分からなくなる。
 *
 * **該当がない種類も「なし」と出す。** 行ごと消すと、未作成なのか表示し忘れなのかが
 * 区別できない。登録漏れに気づける形にしておく。
 *
 * ロック時も表示する。出しているのは文書番号などのメタデータで、ファイルの取得ではない
 * （screens.md「行の表示とファイルの取得を区別する」）。
 */
function renderRelatedPanel(app: HTMLElement, selected: DocumentRecord | null): void {
  const panel = app.querySelector<HTMLElement>('#related-panel');
  if (!panel) return;

  if (selected === null) {
    panel.innerHTML = '';
    return;
  }

  const groups = mockMasters
    .filter((m) => m.category === '文書種類')
    .map((type) => ({
      name: type.name,
      documents: mockDocuments.filter(
        (doc) =>
          doc.productCode === selected.productCode &&
          doc.documentType === type.code &&
          doc.status === '最新',
      ),
    }));

  panel.innerHTML = `
    <h2 class="related-title">関連文書（製品コード ${escapeHtml(selected.productCode)}）</h2>
    <table class="related-table">
      ${groups.map(relatedGroupRow).join('')}
    </table>
  `;
}

function relatedGroupRow(group: { name: string; documents: DocumentRecord[] }): string {
  const body =
    group.documents.length === 0
      ? '<span class="related-empty">なし</span>'
      : group.documents.map(relatedItem).join('');

  return `
    <tr>
      <th>${escapeHtml(group.name)}</th>
      <td>${body}</td>
    </tr>
  `;
}

function relatedItem(doc: DocumentRecord): string {
  const process =
    doc.processNo === undefined
      ? ''
      : `（${escapeHtml(doc.processNo)} ${escapeHtml(doc.processName ?? '')}）`;
  return `<div>${escapeHtml(doc.documentNo)}${process}</div>`;
}

// ---------------------------------------------------------------------------
// CSV出力（F-08）
// ---------------------------------------------------------------------------

const CSV_HEADERS = [
  '文書番号',
  '文書種類',
  '製品コード',
  '工程番号',
  '工程名',
  'リビジョン',
  '状態',
  '担当者',
  '文書発行日',
];

/** 表示中の内容（全件・絞り込み結果とも）を出力する（F-08） */
function exportCsv(filters: Filters): void {
  const rows = visibleRows(filters).map((doc) => [
    doc.documentNo,
    documentTypeName(doc.documentType),
    doc.productCode,
    doc.processNo ?? '',
    doc.processName ?? '',
    doc.revision,
    doc.status,
    doc.owner,
    doc.issuedAt,
  ]);

  const today = new Date();
  const stamp = [
    today.getFullYear(),
    String(today.getMonth() + 1).padStart(2, '0'),
    String(today.getDate()).padStart(2, '0'),
  ].join('');

  downloadCsv(`q-documents_${stamp}.csv`, toCsv(CSV_HEADERS, rows));
}
