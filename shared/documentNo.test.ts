/**
 * 文書番号の生成とパースの純粋関数テスト（CLAUDE.md「テストを書く範囲」1）。
 *
 * 対象: 3種別の採番、SK組み立て、2桁ゼロ埋め。
 * 特に「工程名に `_` を含む場合」は末尾から切るパース方式（CLAUDE.md §4）が
 * 成立していることを示す最重要ケース。
 *
 * Rev100（3桁リビジョン）は境界値として除外する（8/8 の合意）。
 */
import { describe, expect, it } from 'vitest';
import { buildDocumentNo, buildSortKey, nextRevision, parseDocumentNo } from './documentNo';

describe('buildDocumentNo', () => {
  it('製品単位: 文書種類_製品コード_Rev を組み立てる', () => {
    expect(
      buildDocumentNo({
        numberingRule: '製品単位',
        documentType: 'Q001',
        productCode: 'P-0001',
        revision: '01',
      }),
    ).toBe('Q001_P-0001_01');
  });

  it('工程単位: 製品コード_工程番号_工程名_Rev を組み立てる', () => {
    expect(
      buildDocumentNo({
        numberingRule: '工程単位',
        documentType: 'COM001', // 工程単位では番号に現れない
        productCode: 'P-0001',
        processNo: 'K001',
        processName: '工程1',
        revision: '01',
      }),
    ).toBe('P-0001_K001_工程1_01');
  });

  it('工程単位・共通コード: 製品コードの位置に COM001 を置いても組み立てられる', () => {
    // buildDocumentNo 自体は productCode の中身を判定しない（isCommon は MasterRecord 側の属性）。
    expect(
      buildDocumentNo({
        numberingRule: '工程単位',
        documentType: 'COM001',
        productCode: 'COM001',
        processNo: 'K001',
        processName: '共通工程',
        revision: '01',
      }),
    ).toBe('COM001_K001_共通工程_01');
  });

  it('工程単位で processNo/processName が未指定なら例外を投げる', () => {
    expect(() =>
      buildDocumentNo({
        numberingRule: '工程単位',
        documentType: 'COM001',
        productCode: 'P-0001',
        revision: '01',
      }),
    ).toThrow();
  });
});

describe('parseDocumentNo', () => {
  it('通常形式を文書IDとリビジョンに分ける', () => {
    expect(parseDocumentNo('Q001_P-0001_01')).toEqual({
      documentId: 'Q001_P-0001',
      revision: '01',
    });
  });

  it('工程名に `_` を含んでいても末尾のRevだけを切り出す', () => {
    // CLAUDE.md §4 が名指しする例: `_` で分割する方式だと壊れるケース。
    expect(parseDocumentNo('P-0001_K001_組立_仮_02')).toEqual({
      documentId: 'P-0001_K001_組立_仮',
      revision: '02',
    });
  });

  it('末尾がリビジョン形式でなければ null', () => {
    expect(parseDocumentNo('Q001_P-0001')).toBeNull();
  });

  it('リビジョンが1桁では null（2桁ゼロ埋めのみ許容）', () => {
    expect(parseDocumentNo('Q001_P-0001_1')).toBeNull();
  });
});

describe('buildSortKey', () => {
  it('文書ID#リビジョン の形式で結合する', () => {
    expect(buildSortKey('Q001_P-0001_01')).toBe('Q001_P-0001#01');
  });

  it('不正な文書番号では null', () => {
    expect(buildSortKey('Q001_P-0001')).toBeNull();
  });
});

describe('nextRevision', () => {
  it('通常の繰り上げ', () => {
    expect(nextRevision('01')).toBe('02');
  });

  it('桁上がりしても2桁ゼロ埋めを保つ', () => {
    expect(nextRevision('09')).toBe('10');
  });

  it('数値でない入力は例外を投げる', () => {
    expect(() => nextRevision('abc')).toThrow();
  });
});
