/**
 * ハッシュルーティング（screens.md §1「ハッシュ方式」の理由: S3+CloudFrontの静的配信で
 * サーバー側の書き換えが不要になり、SPAルーティング用の CloudFront Function を増やさずに済む）。
 *
 * パスパラメータは `[^/]+` でマッチさせる。工程名に `/` を含めない前提
 * （CLAUDE.md §4）があるため、この単純なマッチで壊れない。
 */

export type RouteParams = Record<string, string>;
export type RouteHandler = (params: RouteParams) => void;

type Route = {
  pattern: RegExp;
  paramNames: string[];
  handler: RouteHandler;
};

const routes: Route[] = [];

function compile(path: string): { pattern: RegExp; paramNames: string[] } {
  const paramNames: string[] = [];
  const segments = path
    .split('/')
    .map((segment) => {
      if (segment.startsWith(':')) {
        paramNames.push(segment.slice(1));
        return '([^/]+)';
      }
      return segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    });
  return { pattern: new RegExp(`^${segments.join('/')}$`), paramNames };
}

export function addRoute(path: string, handler: RouteHandler): void {
  const { pattern, paramNames } = compile(path);
  routes.push({ pattern, paramNames, handler });
}

function resolve(): void {
  const hash = location.hash.slice(1) || '/';
  const path = hash.split('?')[0]!;

  for (const route of routes) {
    const match = path.match(route.pattern);
    if (!match) continue;

    const params: RouteParams = {};
    route.paramNames.forEach((name, i) => {
      params[name] = decodeURIComponent(match[i + 1]!);
    });
    route.handler(params);
    return;
  }

  // マッチしないハッシュは一覧へ（screens.md: URL直叩き時のリダイレクト方針に合わせる）
  location.hash = '#/';
}

export function startRouter(): void {
  window.addEventListener('hashchange', resolve);
  resolve();
}
