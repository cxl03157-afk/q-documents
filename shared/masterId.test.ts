/**
 * `PATCH /masters/{id}` の id 組み立て・分解の純粋関数テスト（CLAUDE.md「テストを書く範囲」1）。
 *
 * 間違えやすいのは分解側。category が固定4値のどれかで `#` を含まないことを
 * 前提に「最初の `#` で区切る」実装にしてあるので、その前提が崩れていないかを確認する。
 */
import { describe, expect, it } from 'vitest';
import { buildMasterId, parseMasterId } from './masterId';

describe('buildMasterId', () => {
  it('category と code を # で結合する', () => {
    expect(buildMasterId('文書種類', 'Q001')).toBe('文書種類#Q001');
  });
});

describe('parseMasterId', () => {
  it('id を category と code に分解する', () => {
    expect(parseMasterId('文書種類#Q001')).toEqual({ category: '文書種類', code: 'Q001' });
  });

  it('4種別すべてで往復できる', () => {
    for (const category of ['文書種類', '製品コード', '工程番号', '担当者'] as const) {
      const id = buildMasterId(category, 'CODE001');
      expect(parseMasterId(id)).toEqual({ category, code: 'CODE001' });
    }
  });

  it('# が無ければ null', () => {
    expect(parseMasterId('Q001')).toBeNull();
  });

  it('category が4値のどれでもなければ null', () => {
    expect(parseMasterId('不明な種別#Q001')).toBeNull();
  });

  it('code が空なら null', () => {
    expect(parseMasterId('文書種類#')).toBeNull();
  });

  it('code に # が含まれていても最初の # で区切る（登録時に弾いているので通常は起きない）', () => {
    // API を直接叩かれた場合の耐性の確認。code 側の # はそのまま残る
    expect(parseMasterId('文書種類#Q001#extra')).toEqual({
      category: '文書種類',
      code: 'Q001#extra',
    });
  });
});
