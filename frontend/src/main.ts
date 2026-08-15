import './style.css';
import { startRouter, addRoute, refreshRoute } from './router';
import { renderHeader } from './components/header';
import { renderDocumentList } from './pages/documentList';
import { renderUnlock } from './pages/unlock';
import { renderDocumentNew } from './pages/documentNew';
import { renderDocumentRevise } from './pages/documentRevise';
import { renderDocumentUpload } from './pages/documentUpload';
import { renderDocumentEdit } from './pages/documentEdit';
import { renderMasters } from './pages/masters';
import { renderPassphrase } from './pages/passphrase';
import { SESSION_CHANGE_EVENT } from './auth/session';
import { requireUnlock } from './auth/guard';
import { startAutoLock } from './auth/autoLock';
import { loadDocuments, loadMasters } from './lib/store';
import { escapeHtml } from './lib/html';

addRoute('/', () => {
  renderHeader();
  renderDocumentList();
});

// S-2 は解除前に開く画面なので guard を付けない
addRoute('/unlock', () => {
  renderHeader();
  renderUnlock();
});

// S-3〜S-7 はロック中に開かせない（screens.md §2）
addRoute(
  '/documents/new',
  requireUnlock(() => {
    renderHeader();
    renderDocumentNew();
  }),
);

addRoute(
  '/documents/:docNo/revise',
  requireUnlock(({ docNo }) => {
    renderHeader();
    renderDocumentRevise(docNo!);
  }),
);

addRoute(
  '/documents/:docNo/upload',
  requireUnlock(({ docNo }) => {
    renderHeader();
    renderDocumentUpload(docNo!);
  }),
);

addRoute(
  '/documents/:docNo/edit',
  requireUnlock(({ docNo }) => {
    renderHeader();
    renderDocumentEdit(docNo!);
  }),
);

addRoute(
  '/masters',
  requireUnlock(() => {
    renderHeader();
    renderMasters();
  }),
);

// S-8 合言葉の変更（F-20）。解除中の利用者だけが開ける
addRoute(
  '/passphrase',
  requireUnlock(() => {
    renderHeader();
    renderPassphrase();
  }),
);

/**
 * 解除/ロックが切り替わったら、ヘッダーと現在の画面を描き直す。
 *
 * **台帳も取り直す。** `GET /documents` はトークンがあるときだけ削除済みを
 * 含めて返す（docs/API.md）。取り直さないと、解除しても削除済みが現れず、
 * ロックしても消えない。マスタは解除の状態で結果が変わらないので触らない。
 *
 * 描き直しを2回に分けているのは、通信の完了を待たせないため。
 * ヘッダーの表示が数百ミリ秒遅れると、押した操作が効いていないように見える。
 */
window.addEventListener(SESSION_CHANGE_EVENT, () => {
  /**
   * 起動処理の途中で来たものは無視する。
   *
   * 起動時の `GET /documents` が 401 だと、その場で解除状態が破棄されて
   * ここへ入ってくる。まだ `startRouter()` を呼んでいない段階で描画と再取得を
   * 始めると、`start()` 側の描画と混ざって、どちらが最後に描いたか分からなくなる。
   * 起動時の 401 は store 側が取り直すので、ここで面倒を見る必要もない。
   */
  if (!routingStarted) return;

  renderHeader();
  refreshRoute();

  void loadDocuments().then((error) => {
    // 取り直しに失敗しても画面は動かしたままにする。手元の台帳が古いだけで、
    // 書き込みはサーバー側が検証する（CLAUDE.md §7）
    if (error !== null) {
      console.error('台帳の取り直しに失敗した:', error);
      return;
    }
    refreshRoute();
  });
});

/**
 * 起動時にストアを埋めてからルーティングを始める。
 *
 * 先に画面を出すと、一覧が空の状態が一瞬見えてから行が現れることになる。
 * 「文書が無い」と読めてしまうので、読み終えてから描く。
 *
 * 失敗したときに一覧を空で描かないのも同じ理由。社外IPからのアクセスや
 * API の障害を「文書が0件」と見せると、利用者は登録されていないと判断する。
 */
/** 再読み込みで startRouter を二重に呼ばないための印。リスナーが増えると描画も二重になる */
let routingStarted = false;

async function start(): Promise<void> {
  const app = document.querySelector<HTMLElement>('#app');
  if (app) app.innerHTML = '<p class="loading">読み込み中…</p>';

  const [mastersError, documentsError] = await Promise.all([loadMasters(), loadDocuments()]);
  const error = mastersError ?? documentsError;

  if (error !== null) {
    renderHeader();
    if (app) {
      app.innerHTML = `
        <h1>読み込みに失敗しました</h1>
        <p class="form-error" role="alert">${escapeHtml(error)}</p>
        <p>社内のネットワークから開いているか確認してください。</p>
        <p><button type="button" id="retry" class="btn-primary">再読み込み</button></p>
      `;
      app
        .querySelector<HTMLButtonElement>('#retry')
        ?.addEventListener('click', () => void start());
    }
    return;
  }

  if (routingStarted) {
    refreshRoute();
    return;
  }

  routingStarted = true;
  startAutoLock();
  startRouter();
}

void start();
