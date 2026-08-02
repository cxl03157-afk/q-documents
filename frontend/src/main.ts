import './style.css';
import { startRouter, addRoute } from './router';
import { renderHeader } from './components/header';
import { renderDocumentList } from './pages/documentList';

addRoute('/', () => {
  renderHeader();
  renderDocumentList();
});

startRouter();
