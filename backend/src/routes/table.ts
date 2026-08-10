/**
 * ルート表。**`docs/API.md` の表と1対1に対応させる。**
 *
 * API Gateway は `ANY /{proxy+}` の Lambda プロキシ1本で、パスの振り分けはここで行う
 * （8/7 の決定）。エンドポイントを足すたびに terraform apply が要る構成を避けるため。
 * 引き換えに「どのパスが実在するか」は Terraform から読めないので、**正は docs/API.md**。
 *
 * **ここが合言葉の制御の全体像でもある。** `auth` を1か所にまとめてあるので、
 * どのエンドポイントがトークンを要求するかは、この配列を上から読めば分かる。
 * 各ハンドラに検証を書く方式だと、この一覧がどこにも存在しなくなる。
 *
 * 追加するときの注意
 *   - `auth` は省略できない（型で強制される）。迷ったら docs/API.md の「合言葉」欄を見る
 *   - `pattern` は `^` と `$` で全体を縛る。部分一致だと別のパスまで拾う
 *   - パス変数は名前付きグループにする。`context.params` に同じ名前で入る
 */

import type { Route } from './context';
import { postDocument } from './createDocument';
import { postMaster } from './createMaster';
import { postRevision } from './createRevision';
import { getMasters } from './getMasters';
import { listDocuments } from './listDocuments';
import { postNumberPreview } from './numberPreview';
import { postUnlock } from './unlock';
import { patchMaster } from './updateMaster';

/**
 * パス変数に許す文字。
 *
 * `/` を含めないのが要点。含めると `/documents/a/b/revisions` のような
 * 想定外の形まで1つの変数として吸い込む。文書番号に `/` は使えない（CLAUDE.md §4）。
 */
const SEGMENT = '[^/]+';

export const routes: Route[] = [
  {
    method: 'POST',
    pattern: /^\/auth\/unlock$/,
    // これ自体がトークンを発行する入口なので、トークンは要求できない
    auth: 'public',
    handler: postUnlock,
  },
  {
    method: 'GET',
    pattern: /^\/masters$/,
    auth: 'public',
    handler: getMasters,
  },
  {
    method: 'POST',
    pattern: /^\/masters$/,
    auth: 'required',
    handler: postMaster,
  },
  {
    method: 'PATCH',
    // id は `${category}#${code}` の URL エンコード（shared/masterId.ts）。SEGMENT は `/` を含まない
    pattern: new RegExp(`^/masters/(?<id>${SEGMENT})$`),
    auth: 'required',
    handler: patchMaster,
  },
  {
    method: 'GET',
    pattern: /^\/documents$/,
    // トークンがあれば削除済みも返す（docs/API.md 補足）
    auth: 'conditional',
    handler: listDocuments,
  },
  {
    method: 'POST',
    pattern: /^\/documents\/number-preview$/,
    // 番号を見るだけでは台帳が変わらない
    auth: 'public',
    handler: postNumberPreview,
  },
  {
    method: 'POST',
    pattern: /^\/documents$/,
    auth: 'required',
    handler: postDocument,
  },
  {
    method: 'POST',
    pattern: new RegExp(`^/documents/(?<docNo>${SEGMENT})/revisions$`),
    auth: 'required',
    handler: postRevision,
  },
];

/**
 * パスとメソッドに一致するルートと、取り出したパス変数。
 *
 * `POST /documents/number-preview` と `POST /documents/{docNo}/revisions` のように
 * 形の近いパスがあるため、**表に書いた順で上から照合する**。
 * `number-preview` を先に置いているのは、後者のパターンが `/documents/…/revisions` で
 * 終端を縛っている以上は衝突しないが、順序に意味を持たせない書き方をすると
 * 将来 `/documents/{docNo}` を足したときに静かに取り違えるため。
 */
export function matchRoute(
  method: string,
  path: string,
): { route: Route; params: Record<string, string> } | null {
  for (const route of routes) {
    if (route.method !== method) continue;

    const match = path.match(route.pattern);
    if (match === null) continue;

    return { route, params: { ...match.groups } };
  }

  return null;
}
