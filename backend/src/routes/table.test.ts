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
  { method: 'POST', path: '/auth/passphrase', auth: 'required' },
  { method: 'GET', path: '/masters', auth: 'public' },
  { method: 'POST', path: '/masters', auth: 'required' },
  { method: 'PATCH', path: '/masters/文書種類#Q001', auth: 'required' },
  { method: 'GET', path: '/documents', auth: 'conditional' },
  { method: 'POST', path: '/documents/number-preview', auth: 'public' },
  { method: 'POST', path: '/documents', auth: 'required' },
  { method: 'POST', path: '/documents/Q001_P-0001_01/revisions', auth: 'required' },
  { method: 'POST', path: '/documents/Q001_P-0001_01/upload-url', auth: 'required' },
  { method: 'GET', path: '/documents/Q001_P-0001_01/download-url', auth: 'conditional' },
  { method: 'PATCH', path: '/documents/Q001_P-0001_01', auth: 'required' },
  { method: 'DELETE', path: '/documents/Q001_P-0001_01', auth: 'required' },
] as const;

/**
 * **`docs/API.md` の13本がすべて実装済み**（F-13 で PATCH・DELETE、F-20 で合言葉の変更を追加）。
 *
 * 以前あった「未実装のエンドポイント」の一覧はここから消した。
 * 新しいエンドポイントを足すときは、**docs/API.md の「合言葉」欄を見て**
 * 上の EXPECTED に1行加えること。加えないと
 * 「表に載っているルートはすべて EXPECTED で確認済み」が落ちる。
 * それが狙いで、合言葉の指定を確認しないまま新しい書き込み口が開くのを防いでいる。
 */

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

  it('PATCH /masters/{id} の id を # 込みで取り出せる（shared/masterId.ts）', () => {
    const matched = matchRoute('PATCH', '/masters/文書種類#Q001');

    expect(matched?.params.id).toBe('文書種類#Q001');
  });

  it('number-preview が revisions のパターンに吸われない', () => {
    const matched = matchRoute('POST', '/documents/number-preview');

    expect(matched).not.toBeNull();
    expect(matched?.params.docNo).toBeUndefined();
  });

  it('upload-url と revisions を取り違えない', () => {
    // どちらも POST /documents/{docNo}/... で auth も required なので、
    // 取り違えても「合言葉の指定」のテストでは気づけない。ここで押さえる
    const upload = matchRoute('POST', '/documents/Q001_P-0001_01/upload-url');
    const revisions = matchRoute('POST', '/documents/Q001_P-0001_01/revisions');

    expect(upload?.route.pattern.source).toContain('upload-url');
    expect(revisions?.route.pattern.source).toContain('revisions');
    expect(upload?.params.docNo).toBe('Q001_P-0001_01');
  });

  it('PATCH / DELETE /documents/{docNo} は docNo を取り出す（POST /documents と別物）', () => {
    // POST /documents（新規発行）はパス変数を持たない。同じ `/documents` 始まりで
    // メソッドだけが違うので、取り違えると採番の口が修正の口に化ける
    expect(matchRoute('PATCH', '/documents/Q001_P-0001_01')?.params.docNo).toBe(
      'Q001_P-0001_01',
    );
    expect(matchRoute('DELETE', '/documents/P-0001_K001_組立_仮_02')?.params.docNo).toBe(
      'P-0001_K001_組立_仮_02',
    );
    expect(matchRoute('POST', '/documents')?.params.docNo).toBeUndefined();
  });

  it('PATCH / DELETE は文書番号が無いと一致しない', () => {
    // 一致させると docNo が空のまま台帳を触りに行く
    expect(matchRoute('PATCH', '/documents')).toBeNull();
    expect(matchRoute('DELETE', '/documents')).toBeNull();
    expect(matchRoute('DELETE', '/documents/')).toBeNull();
  });
});
