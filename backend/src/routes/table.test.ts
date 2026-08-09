import { describe, expect, it } from 'vitest';
import { matchRoute, routes } from './table';

/**
 * **`docs/API.md` の「合言葉」欄をそのまま写したもの。**
 *
 * 型はルートに `auth` を書き忘れることを止めてくれるが、
 * 「`required` と書くべきところに `public` と書いた」は止められない。
 * そこだけをここで押さえる。実装のほうを見て書かないこと — それでは
 * 実装が自分自身を承認するだけで、何も検証していない。
 *
 * 実際のパスで `matchRoute` を通しているので、照合の誤りも同時に見つかる。
 */
const EXPECTED = [
  { method: 'POST', path: '/auth/unlock', auth: 'public' },
  { method: 'GET', path: '/masters', auth: 'public' },
  { method: 'GET', path: '/documents', auth: 'conditional' },
  { method: 'POST', path: '/documents/number-preview', auth: 'public' },
  { method: 'POST', path: '/documents', auth: 'required' },
  { method: 'POST', path: '/documents/Q001_P-0001_01/revisions', auth: 'required' },
] as const;

/**
 * まだ実装していないエンドポイント（docs/API.md にはある）。
 *
 * 実装したらここから EXPECTED へ移し、**docs/API.md の欄を見て** `auth` を書くこと。
 * 移さずに追加すると下の「表に載っているルートはすべて EXPECTED で確認済み」が落ちる。
 * それが狙いで、合言葉の指定を確認しないまま新しい書き込み口が開くのを防いでいる。
 */
const NOT_IMPLEMENTED_YET = [
  { method: 'POST', path: '/masters' },
  { method: 'PATCH', path: '/masters/E001' },
  { method: 'POST', path: '/documents/Q001_P-0001_01/upload-url' },
  { method: 'GET', path: '/documents/Q001_P-0001_01/download-url' },
  { method: 'PATCH', path: '/documents/Q001_P-0001_01' },
  { method: 'DELETE', path: '/documents/Q001_P-0001_01' },
] as const;

describe('ルート表の合言葉の指定', () => {
  for (const { method, path, auth } of EXPECTED) {
    it(`${method} ${path} は ${auth}`, () => {
      const matched = matchRoute(method, path);
      expect(matched, 'このパスに一致するルートが無い').not.toBeNull();
      expect(matched?.route.auth).toBe(auth);
    });
  }

  it('表に載っているルートはすべて EXPECTED で確認済み', () => {
    const checked = new Set(
      EXPECTED.map(({ method, path }) => matchRoute(method, path)?.route),
    );

    const unchecked = routes.filter((route) => !checked.has(route));
    expect(
      unchecked.map((route) => `${route.method} ${route.pattern.source}`),
      'ルートを追加したら EXPECTED にも追加すること（docs/API.md の合言葉欄を見る）',
    ).toEqual([]);
  });

  it('書き込み系はすべて required', () => {
    const writeMethods = ['POST', 'PATCH', 'DELETE'];
    const writes = EXPECTED.filter(
      // unlock は書き込みではなくトークンの発行口。これ自体にトークンは要求できない
      (e) => writeMethods.includes(e.method) && e.path !== '/auth/unlock',
    );

    const notRequired = writes.filter(
      // 番号プレビューは台帳に何も書かないので例外（docs/API.md）
      (e) => e.auth !== 'required' && e.path !== '/documents/number-preview',
    );

    expect(notRequired.map((e) => `${e.method} ${e.path}`)).toEqual([]);
  });
});

describe('パスの照合', () => {
  it('日本語とアンダースコアを含む文書番号を取り出せる', () => {
    const matched = matchRoute('POST', '/documents/P-0001_K001_組立_仮_02/revisions');

    expect(matched?.params.docNo).toBe('P-0001_K001_組立_仮_02');
  });

  it('パス変数はスラッシュを越えない', () => {
    // 越えると /documents/a/b/revisions のような想定外の形まで吸い込む
    expect(matchRoute('POST', '/documents/a/b/revisions')).toBeNull();
  });

  it('メソッドが違えば一致しない', () => {
    expect(matchRoute('GET', '/documents/Q001_P-0001_01/revisions')).toBeNull();
  });

  it('前後に余分があれば一致しない', () => {
    expect(matchRoute('GET', '/documentsX')).toBeNull();
    expect(matchRoute('GET', '/prod/documents')).toBeNull();
    expect(matchRoute('GET', '/documents/')).toBeNull();
  });

  it('number-preview が revisions のパターンに吸われない', () => {
    const matched = matchRoute('POST', '/documents/number-preview');

    expect(matched).not.toBeNull();
    expect(matched?.params.docNo).toBeUndefined();
  });

  it('未実装のエンドポイントはまだ一致しない', () => {
    for (const { method, path } of NOT_IMPLEMENTED_YET) {
      expect(matchRoute(method, path), `${method} ${path}`).toBeNull();
    }
  });
});
