/**
 * S-1 一覧・検索（screens.md §5）。
 * 現在の範囲: ハードコードデータの一覧表示 + 4条件の絞り込み + 解除時の操作列。
 * 関連文書パネル（F-06）・CSV出力（F-08）は未実装。
 */

import type { DocumentRecord, DocumentStatus } from '../../../shared/types';
import { mockDocuments } from '../mock/documents';
import { mockMasters } from '../mock/masters';
import { isUnlocked } from '../auth/session';
import { escapeHtml } from '../lib/html';

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

  app.innerHTML = pageTemplate(filters);
  bindEvents(app, (next) => {
    filters = next;
    renderTable(app, filters);
  });
  renderTable(app, filters);
}

function pageTemplate(filters: Filters): string {
  return `
    <h1>文書一覧・検索</h1>
    <form id="filter-form" class="filter-form">
      ${multiSelect('productCodes', '製品コード', productCodeOptions(), filters.productCodes)}
      ${multiSelect('processNos', '工程番号', processNoOptions(), filters.processNos)}
      ${multiSelect('documentTypes', '文書種類', documentTypeOptions(), filters.documentTypes)}
      ${multiSelect('statuses', '状態', statusOptions(), filters.statuses)}
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

function bindEvents(app: HTMLElement, onChange: (filters: Filters) => void): void {
  const form = app.querySelector<HTMLFormElement>('#filter-form');
  if (form) {
    form.addEventListener('change', () => onChange(readFilters(form)));
  }

  const tbody = app.querySelector<HTMLTableSectionElement>('#document-rows');
  tbody?.addEventListener('click', (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    const button = target.closest<HTMLButtonElement>('.btn-download');
    if (!button) return;

    const label = button.dataset.fileType === 'pdf' ? 'PDF' : 'エクセル';
    window.alert(`モック: ${button.dataset.doc} の${label}ダウンロードは週3で実装します`);
  });
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

function renderTable(app: HTMLElement, filters: Filters): void {
  const tbody = app.querySelector<HTMLTableSectionElement>('#document-rows');
  if (!tbody) return;

  const rows = mockDocuments.filter((doc) => matchesFilters(doc, filters));
  tbody.innerHTML =
    rows.length > 0
      ? rows.map(renderRow).join('')
      : `<tr><td colspan="10" class="empty-row">該当する文書がありません</td></tr>`;
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

function renderRow(doc: DocumentRecord): string {
  const rowClass = doc.status === '一部登録' ? ' class="row-warning"' : '';
  return `
    <tr${rowClass}>
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
    buttons.push(actionLink(doc, 'revise', 'リビジョンアップ'));
    buttons.push(actionLink(doc, 'edit', '修正'));
  }

  return buttons.join(' ') || '—';
}

function actionLink(doc: DocumentRecord, path: 'revise' | 'edit', label: string): string {
  const href = `#/documents/${encodeURIComponent(doc.documentNo)}/${path}`;
  return `<a class="btn-row-link" href="${href}">${label}</a>`;
}

function downloadButton(doc: DocumentRecord, fileType: 'pdf' | 'excel'): string {
  const label = fileType === 'pdf' ? 'PDF' : 'エクセル';
  return `<button type="button" class="btn-download" data-doc="${escapeHtml(doc.documentNo)}" data-file-type="${fileType}">${label}</button>`;
}
