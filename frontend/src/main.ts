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
import { SESSION_CHANGE_EVENT } from './auth/session';
import { requireUnlock } from './auth/guard';
import { startAutoLock } from './auth/autoLock';

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

// 解除/ロックが切り替わったら、ヘッダーと現在の画面を描き直す
window.addEventListener(SESSION_CHANGE_EVENT, () => {
  renderHeader();
  refreshRoute();
});

startAutoLock();
startRouter();
