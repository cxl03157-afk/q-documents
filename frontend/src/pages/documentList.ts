/**
 * S-1 一覧・検索（screens.md §5）。
 * 現在の範囲: 一覧表示 + 4条件の絞り込み + 解除時の操作列 + 関連文書パネル（F-06）
 * + CSV出力（F-08）+ ファイルの閲覧・ダウンロード（F-11）。
 */

import type {
  DocumentRecord,
  DocumentStatus,
  DownloadDisposition,
  FileType,
  MasterCategory,
  MasterRecord,
} from '../../../shared/types';
import { allDocuments } from '../lib/store';
import { allMasters } from '../lib/store';
import { isCommonProductCode } from '../lib/masters';
import { isUnlocked } from '../auth/session';
import { escapeHtml } from '../lib/html';
import { downloadCsv, toCsv } from '../lib/csv';
import { apiGet } from '../lib/api';
import { isDownloadUrlResponse } from '../lib/guards';

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

const FILTERABLE_STATUSES: DocumentStatus[] = ['ファイル未登録', '一部登録', '最新', '旧版'];

/**
 * 「削除済み」は解除時にだけ選べる。
 * 何を消したのかを生産技術が後から追えるようにするため。
 * 一般利用者に見せる必要はないので、ロック時は選択肢自体を出さない。
 */
function filterableStatuses(): DocumentStatus[] {
  return isUnlocked() ? [...FILTERABLE_STATUSES, '削除済み'] : FILTERABLE_STATUSES;
}

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
  /**
   * まとめてダウンロードの実行中フラグ（8/12のレビューで発見）。
   *
   * `renderBulkButtons` は本来「件数が0件かどうか」だけでボタンの disabled を決めるが、
   * それだけだと実行中に他の redraw（絞り込み変更・行選択）が挟まった瞬間、
   * 件数はそのままなのでボタンが再度押せる状態に戻ってしまう。
   * 押すと重複した非同期ループが同時に走り、同じファイルを二重に取得する。
   * このフラグを毎回の `redraw` に渡すことで、実行中は必ず disabled を保つ。
   */
  let bulkInProgress = false;

  app.innerHTML = pageTemplate(filters);

  const redraw = (): void => {
    renderTable(app, filters, selected);
    renderRelatedPanel(app, selected);
    renderBulkButtons(app, filters, bulkInProgress);
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
    onBulkDownload: (fileType) => {
      if (bulkInProgress) return;
      bulkInProgress = true;
      redraw();
      void bulkDownload(filters, fileType).finally(() => {
        bulkInProgress = false;
        redraw();
      });
    },
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
      <div class="filter-actions">
        <button type="button" id="export-csv" class="btn-end">CSV出力</button>
        <!-- PDF とエクセルは対になる操作なので縦に並べる -->
        <div class="bulk-actions">
          <button type="button" id="bulk-pdf" class="btn-end"></button>
          <button type="button" id="bulk-excel" class="btn-end"></button>
        </div>
      </div>
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

/**
 * 絞り込みはチェックボックス群で出す（screens.md S-1）。
 * `<select multiple>` は複数選ぶのに Ctrl/⌘＋クリックが要り、
 * 普通にクリックすると他の選択が消える。PC操作に不慣れな利用者が対象なので使えない。
 *
 * 見出しに `<label>` を使わない。個々の選択肢が `<label>` を必要とするため、
 * 外側も `<label>` にすると入れ子になり、クリックがどちらに効くのか決まらない。
 */
function multiSelect(
  name: keyof Filters,
  label: string,
  options: SelectOption[],
  selected: string[],
): string {
  const optionsHtml = options
    .map((opt) => {
      const isChecked = selected.includes(opt.value) ? ' checked' : '';
      return `
        <label>
          <input type="checkbox" name="${name}" value="${escapeHtml(opt.value)}"${isChecked}>
          <span>${escapeHtml(opt.label)}</span>
        </label>
      `;
    })
    .join('');

  return `
    <fieldset class="filter-field">
      <legend>${escapeHtml(label)}</legend>
      <div class="filter-options">${optionsHtml}</div>
    </fieldset>
  `;
}

/**
 * 検索の選択肢は無効化されたマスタも出す（screens.md S-1）。
 *
 * 登録（S-3）と検索（S-1）では必要な制約が違う。登録は実在しない組み合わせを
 * 作らせないために選択肢を絞るのが正しいが、検索は既にある文書へ到達する手段なので、
 * 絞ると「マスタを無効にした瞬間に過去の文書が探せなくなる」。
 * 無効化は新規発行の停止であって、過去の記録を隠すことではない。
 *
 * 台帳に実在するコードから選択肢を作る案は採らない。週2の API 接続時に、
 * 絞り込みの選択肢を組み立てるためだけに台帳の全件取得が必要になるため。
 */
function masterOptions(
  category: MasterCategory,
  toLabel: (master: MasterRecord) => string,
): SelectOption[] {
  return allMasters()
    .filter((m) => m.category === category)
    // 有効を先に出す。無効は普段使わないので、上に混ざると選びにくい
    .sort((a, b) => Number(a.status === '無効') - Number(b.status === '無効'))
    .map((m) => ({
      value: m.code,
      label: m.status === '無効' ? `${toLabel(m)}（無効）` : toLabel(m),
    }));
}

function productCodeOptions(): SelectOption[] {
  return masterOptions('製品コード', (m) => `${m.code}（${m.name}）`);
}

function processNoOptions(): SelectOption[] {
  return masterOptions('工程番号', (m) => `${m.code}（${m.name}）`);
}

function documentTypeOptions(): SelectOption[] {
  return masterOptions('文書種類', (m) => m.name);
}

function statusOptions(): SelectOption[] {
  return filterableStatuses().map((status) => ({ value: status, label: status }));
}

type Handlers = {
  onFilterChange: (filters: Filters) => void;
  onSelect: (doc: DocumentRecord) => void;
  onExport: () => void;
  onBulkDownload: (fileType: FileType) => void;
};

function bindEvents(app: HTMLElement, handlers: Handlers): void {
  const form = app.querySelector<HTMLFormElement>('#filter-form');
  if (form) {
    form.addEventListener('change', () => handlers.onFilterChange(readFilters(form)));
  }

  app.querySelector<HTMLButtonElement>('#export-csv')?.addEventListener('click', handlers.onExport);
  app.querySelector<HTMLButtonElement>('#bulk-pdf')
    ?.addEventListener('click', () => handlers.onBulkDownload('pdf'));
  app.querySelector<HTMLButtonElement>('#bulk-excel')
    ?.addEventListener('click', () => handlers.onBulkDownload('excel'));

  const tbody = app.querySelector<HTMLTableSectionElement>('#document-rows');
  tbody?.addEventListener('click', (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;

    const button = target.closest<HTMLButtonElement>('.btn-download');
    if (button) {
      const doc = button.dataset.doc === undefined ? undefined : findByDocumentNo(button.dataset.doc);
      const fileType = button.dataset.fileType;
      const mode = button.dataset.mode;
      if (doc !== undefined && (fileType === 'pdf' || fileType === 'excel') && (mode === 'view' || mode === 'download')) {
        void handleFileAction(doc, fileType, mode);
      }
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
  return allDocuments().find((doc) => doc.documentNo === documentNo);
}

function readFilters(form: HTMLFormElement): Filters {
  return {
    productCodes: selectedValues(form, 'productCodes'),
    processNos: selectedValues(form, 'processNos'),
    documentTypes: selectedValues(form, 'documentTypes'),
    statuses: selectedValues(form, 'statuses') as DocumentStatus[],
  };
}

/**
 * 同じ name のチェックボックスから、チェック済みの値だけを集める。
 *
 * `form.elements.namedItem(name)` は使わない。選択肢が1個のときは HTMLInputElement、
 * 2個以上のときは RadioNodeList を返すため、マスタの件数によって型が変わる。
 * querySelectorAll なら件数に関係なく同じコードで済む。
 */
function selectedValues(form: HTMLFormElement, name: string): string[] {
  const checked = form.querySelectorAll<HTMLInputElement>(`input[name="${name}"]:checked`);
  return Array.from(checked).map((input) => input.value);
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

/** 画面に出ている行。CSV出力・まとめてダウンロードの対象もこれと同じにする */
function visibleRows(filters: Filters): DocumentRecord[] {
  return allDocuments().filter((doc) => showsDeleted(doc, filters) && matchesFilters(doc, filters));
}

/**
 * 削除済みは「状態」で明示的に選んだときだけ出す。
 * 絞り込みを空にしたときに紛れ込むと、消したはずのものが通常の一覧に現れる。
 */
function showsDeleted(doc: DocumentRecord, filters: Filters): boolean {
  if (doc.status !== '削除済み') return true;
  return isUnlocked() && filters.statuses.includes('削除済み');
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
  const master = allMasters().find((m) => m.category === '文書種類' && m.code === code);
  return master?.name ?? code;
}

// screens.md §5 S-1 の表（ロック時/解除時でPDF・エクセルの表示可否が変わる）
function renderActions(doc: DocumentRecord): string {
  const unlocked = isUnlocked();
  const buttons: string[] = [];

  if (doc.status === '最新') {
    buttons.push(fileButtons(doc, 'pdf'));
    if (unlocked) buttons.push(fileButtons(doc, 'excel'));
  } else if (doc.status === '旧版' && unlocked) {
    buttons.push(fileButtons(doc, 'pdf'));
    buttons.push(fileButtons(doc, 'excel'));
  } else if (doc.status === '削除済み' && unlocked) {
    // 削除済みでも、万一のときに中身を確認できるようエクセルだけは取得できるようにする。
    // PDFは配布物なので出さない（消したはずの版が現場に出回るのを防ぐ。backend側でも403にする）
    buttons.push(fileButtons(doc, 'excel'));
  }

  // 削除済みは書き込みの対象外。リビジョンアップも修正もできない
  if (doc.status === '削除済み') return buttons.join(' ') || '—';

  // 解除時のみ行に出す書き込み導線（screens.md §5「その他の操作」）
  if (unlocked) {
    // 採番した日とファイルが揃う日は別になるので、一覧からアップロードを再開できるようにする。
    // 「一部登録」にも出す。未登録の種別だけを後から追加できる（要件定義書 F-01）ため、
    // S-5 は登録済みの欄を隠して残りだけを受け付ける — 押しても必ず失敗するわけではない
    if (doc.status === 'ファイル未登録' || doc.status === '一部登録') {
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

/**
 * ファイル種別ごとのボタン（F-11）。
 *
 * **PDFだけ「閲覧」と「ダウンロード」の2つに分ける。** エクセルはブラウザに表示手段が
 * 無いので「閲覧」を用意する意味が無く、ダウンロードの1つだけにする
 * （8/12、現場の利用者は「一度ダウンロードしてから開く」手間を避けたいという指摘を受けて決定）。
 */
function fileButtons(doc: DocumentRecord, fileType: FileType): string {
  if (fileType === 'excel') {
    return fileButton(doc, 'excel', 'download', 'エクセルダウンロード');
  }
  return fileButton(doc, 'pdf', 'view', 'PDF閲覧') + fileButton(doc, 'pdf', 'download', 'PDFダウンロード');
}

function fileButton(doc: DocumentRecord, fileType: FileType, mode: FileMode, label: string): string {
  return (
    `<button type="button" class="btn-download" data-doc="${escapeHtml(doc.documentNo)}" ` +
    `data-file-type="${fileType}" data-mode="${mode}">${label}</button>`
  );
}

// ---------------------------------------------------------------------------
// ファイルの閲覧・ダウンロード（F-11）
// ---------------------------------------------------------------------------

type FileMode = 'view' | 'download';

/**
 * `GET /documents/{docNo}/download-url` のパス組み立て。
 *
 * `productCode` を添えるのは、文書番号だけでは台帳のPK（製品コード）が
 * 導出できないため（製品単位/工程単位で位置が違う。backend/src/routes/downloadUrl.ts と同じ理由）。
 */
function downloadUrlPath(doc: DocumentRecord, fileType: FileType, disposition: DownloadDisposition): string {
  const params = new URLSearchParams({ fileType, productCode: doc.productCode, disposition });
  return `/documents/${encodeURIComponent(doc.documentNo)}/download-url?${params.toString()}`;
}

/**
 * ブラウザにファイルを保存させる。`lib/csv.ts` の `downloadCsv` と同じ
 * 「`<a>` を作ってclickして消す」パターン。**画面は離れない** —
 * サーバー側が `Content-Disposition: attachment` を返すため、ブラウザは
 * ページ遷移ではなくダウンロードとして扱う（backend/src/s3.ts）。
 */
function triggerDownload(url: string): void {
  const link = document.createElement('a');
  link.href = url;
  link.rel = 'noopener';
  document.body.appendChild(link);
  link.click();
  link.remove();
}

/** 行の `[PDF閲覧]` `[PDFダウンロード]` `[エクセルダウンロード]` の共通処理 */
async function handleFileAction(doc: DocumentRecord, fileType: FileType, mode: FileMode): Promise<void> {
  const disposition: DownloadDisposition = mode === 'view' ? 'inline' : 'attachment';
  const result = await apiGet(downloadUrlPath(doc, fileType, disposition), isDownloadUrlResponse);

  if (!result.ok) {
    window.alert(result.message);
    return;
  }

  if (mode === 'download') {
    triggerDownload(result.data.url);
    return;
  }

  /**
   * 閲覧は新しいタブで開く。1クリックにつき1回だけの呼び出しなので、
   * まとめてダウンロードのようなループに比べればポップアップブロックの対象になりにくいが、
   * 直前に `await` を挟んでいる（＝ユーザー操作からの直接呼び出しではない）ため、
   * 回線が遅い・Lambdaのコールドスタートで応答が遅れた場合はブロックされうる
   * （特にSafariは判定が厳しい。8/12のレビューで指摘）。`window.open` の戻り値が
   * `null` ならブロックされているので、無言で終わらせず案内する。
   */
  const win = window.open(result.data.url, '_blank', 'noopener');
  if (win === null) {
    window.alert('ポップアップがブロックされました。ブラウザの設定で許可してから、もう一度お試しください。');
  }
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

  // 共通コードには製品単位の文書（PFMEA・QC工程表）が存在しない。
  // 出すと「なし」が欠品の警告に見えてしまうため、行ごと出さない
  const common = isCommonProductCode(selected.productCode);

  const groups = allMasters()
    .filter((m) => m.category === '文書種類' && (!common || m.numberingRule === '工程単位'))
    .map((type) => ({
      name: type.name,
      documents: allDocuments().filter(
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

// ---------------------------------------------------------------------------
// まとめてダウンロード
// ---------------------------------------------------------------------------

/**
 * 一度に落とせる件数の上限。
 *
 * 絞り込みをせずに押すと台帳の全件が対象になる。実運用は数百〜数千件で、
 * ファイルの総量は400GB規模を見込んでいるため、そのまま流すとブラウザ側が破綻する。
 * ZIPでまとめる案は採らない（Lambdaで大容量を集めて圧縮すると、
 * 実行時間・メモリ・コストのすべてが月1,000円の制約に合わない）。
 */
const BULK_DOWNLOAD_LIMIT = 50;

/**
 * まとめてダウンロードの対象。行ごとのボタンの出し分けと同じ条件にする
 * （ロック時は最新のPDFのみ、解除時は旧版とエクセルも。screens.md §5 S-1 の表）。
 */
function bulkTargets(filters: Filters, fileType: FileType): DocumentRecord[] {
  const unlocked = isUnlocked();

  return visibleRows(filters).filter((doc) => {
    if (fileType === 'excel') {
      // 削除済みのエクセルも対象。行に出ているボタンと対象を揃える
      return unlocked && doc.status !== 'ファイル未登録' && doc.status !== '一部登録';
    }
    if (doc.status === '最新') return true;
    return doc.status === '旧版' && unlocked;
  });
}

/**
 * 押す前に件数が分かるようにボタン自体に出す。押してから件数を知るのでは遅い。
 *
 * `inProgress` は実行中かどうか（8/12のレビューで追加）。**件数だけで disabled を
 * 決めると、実行中に他の理由で redraw が走った瞬間にボタンが再度押せる状態へ戻り、
 * 二重に非同期ループが走ってしまう。** 呼び出し側（`renderDocumentList` の `redraw`）が
 * 実行中フラグを毎回渡すことで、件数に関係なく実行中は必ず disabled を保つ。
 */
function renderBulkButtons(app: HTMLElement, filters: Filters, inProgress: boolean): void {
  const pdfButton = app.querySelector<HTMLButtonElement>('#bulk-pdf');
  if (pdfButton) {
    const count = bulkTargets(filters, 'pdf').length;
    pdfButton.textContent = `PDFをまとめてダウンロード（${count}件）`;
    pdfButton.disabled = inProgress || count === 0;
  }

  const excelButton = app.querySelector<HTMLButtonElement>('#bulk-excel');
  if (excelButton) {
    const count = bulkTargets(filters, 'excel').length;
    // エクセルは解除時のみ（対象0件のときは押せる意味がないので隠す）
    excelButton.hidden = !isUnlocked();
    excelButton.textContent = `エクセルをまとめてダウンロード（${count}件）`;
    excelButton.disabled = inProgress || count === 0;
  }
}

/**
 * 対象1件ずつ `GET /documents/{docNo}/download-url` を呼び、得たURLを順に
 * ダウンロードさせる（`disposition=attachment` 固定。新しいAPIは要らない）。
 * エクセル・旧版のアクセスログ（CLAUDE.md §8-7）もファイル単位で残る。
 *
 * 新しいタブは一切開かない（`triggerDownload` は現在の画面のまま保存させる）ので
 * ポップアップブロックの対象にならない。代わりにブラウザが「複数のファイルを
 * ダウンロードしますか」という確認を一度だけ出すことがある（Chrome/Edgeの標準機能）ため、
 * 開始前に案内する。「ポップアップブロックを解除してください」より、
 * 「画面上部の確認で[許可]を押す」のほうが操作に迷わない（8/12、利用者の指摘）。
 *
 * **実行中のボタンのdisabled管理はこの関数の責務にしない。** 呼び出し側
 * （`renderDocumentList` の `onBulkDownload`）が実行中フラグを持ち、
 * `redraw` を通して disabled を反映する（8/12のレビューで見つかった二重起動バグの対策）。
 */
async function bulkDownload(filters: Filters, fileType: FileType): Promise<void> {
  const targets = bulkTargets(filters, fileType);
  const label = fileType === 'pdf' ? 'PDF' : 'エクセル';

  if (targets.length > BULK_DOWNLOAD_LIMIT) {
    window.alert(
      `一度にダウンロードできるのは${BULK_DOWNLOAD_LIMIT}件までです` +
        `（現在 ${targets.length}件）。絞り込んでから実行してください。`,
    );
    return;
  }
  if (targets.length === 0) return;

  window.alert(
    `${label}を${targets.length}件ダウンロードします。\n` +
      'ブラウザの画面上部に「複数のファイルをダウンロードしますか」という確認が表示されたら、' +
      '[許可]を選んでください。',
  );

  let failed = 0;
  for (const doc of targets) {
    const result = await apiGet(downloadUrlPath(doc, fileType, 'attachment'), isDownloadUrlResponse);
    if (!result.ok) {
      failed++;
      continue;
    }
    triggerDownload(result.data.url);
  }

  if (failed > 0) {
    window.alert(`${failed}件は取得できませんでした。時間をおいて再度お試しください。`);
  }
}
