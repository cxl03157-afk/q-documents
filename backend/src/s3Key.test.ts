/**
 * S3キーの組み立て・分解のテスト。
 *
 * ここが狂うと、実体は S3 にあるのに台帳のどのレコードのものか分からなくなる。
 * 非同期Lambdaはこの関数の結果だけを頼りに PK と SK を決めるため、
 * **日本語・空白・`_` を含む工程名**を重点的に確認する。
 */
import { describe, expect, it } from 'vitest';
import { buildS3Key, decodeS3EventKey, parseS3Key } from './s3Key';

describe('buildS3Key', () => {
  it('製品単位の文書番号からキーを組み立てる', () => {
    expect(buildS3Key('P-0001', 'Q001_P-0001_01', 'pdf')).toBe('P-0001/Q001_P-0001_01.pdf');
    expect(buildS3Key('P-0001', 'Q001_P-0001_01', 'excel')).toBe('P-0001/Q001_P-0001_01.xlsx');
  });

  it('工程単位（日本語の工程名）からキーを組み立てる', () => {
    expect(buildS3Key('P-0001', 'P-0001_K001_工程1_02', 'pdf')).toBe(
      'P-0001/P-0001_K001_工程1_02.pdf',
    );
  });

  it('共通コードでも同じ形になる', () => {
    expect(buildS3Key('COM001', 'COM001_K001_工程1_01', 'excel')).toBe(
      'COM001/COM001_K001_工程1_01.xlsx',
    );
  });

  it('`/` が混ざっていたら投げる（想定より深い階層に実体が入るのを防ぐ）', () => {
    expect(() => buildS3Key('P-0001', '../secret_01', 'pdf')).toThrow();
    expect(() => buildS3Key('P/0001', 'Q001_P-0001_01', 'pdf')).toThrow();
  });

  it('空の値では組み立てない', () => {
    expect(() => buildS3Key('', 'Q001_P-0001_01', 'pdf')).toThrow();
    expect(() => buildS3Key('P-0001', '', 'pdf')).toThrow();
  });
});

describe('parseS3Key', () => {
  it('組み立てたキーを元に戻せる（製品単位）', () => {
    expect(parseS3Key('P-0001/Q001_P-0001_01.pdf')).toEqual({
      productCode: 'P-0001',
      documentNo: 'Q001_P-0001_01',
      fileType: 'pdf',
    });
  });

  it('組み立てたキーを元に戻せる（工程単位・日本語）', () => {
    expect(parseS3Key('P-0001/P-0001_K001_工程1_02.xlsx')).toEqual({
      productCode: 'P-0001',
      documentNo: 'P-0001_K001_工程1_02',
      fileType: 'excel',
    });
  });

  it('工程名に `_` が含まれていても製品コードと文書番号を取り違えない', () => {
    // 文書番号の中の `_` は触らない。割るのは最初の `/` だけ
    expect(parseS3Key('P-0001/P-0001_K001_組立_仮_02.pdf')).toEqual({
      productCode: 'P-0001',
      documentNo: 'P-0001_K001_組立_仮_02',
      fileType: 'pdf',
    });
  });

  it('buildS3Key の結果を必ず読み戻せる', () => {
    const cases = [
      ['P-0001', 'Q001_P-0001_01'],
      ['P-0002', 'P-0002_K010_検査 工程_11'],
      ['COM001', 'COM001_K001_工程1_01'],
    ] as const;

    for (const [productCode, documentNo] of cases) {
      for (const fileType of ['pdf', 'excel'] as const) {
        expect(parseS3Key(buildS3Key(productCode, documentNo, fileType))).toEqual({
          productCode,
          documentNo,
          fileType,
        });
      }
    }
  });

  it('想定外の形は推測せず null を返す', () => {
    expect(parseS3Key('Q001_P-0001_01.pdf')).toBeNull(); // 製品コードが無い
    expect(parseS3Key('/Q001_P-0001_01.pdf')).toBeNull(); // 製品コードが空
    expect(parseS3Key('P-0001/sub/Q001_P-0001_01.pdf')).toBeNull(); // 階層が深い
    expect(parseS3Key('P-0001/Q001_P-0001_01.txt')).toBeNull(); // 許容しない拡張子
    expect(parseS3Key('P-0001/Q001_P-0001_01')).toBeNull(); // 拡張子が無い
    expect(parseS3Key('P-0001/.pdf')).toBeNull(); // 文書番号が空
  });

  it('拡張子が大文字のキーは扱わない（キーは常に小文字で組み立てるため）', () => {
    expect(parseS3Key('P-0001/Q001_P-0001_01.PDF')).toBeNull();
  });
});

describe('decodeS3EventKey', () => {
  it('日本語の工程名を含むキーを元に戻す', () => {
    const encoded = 'P-0001/P-0001_K001_%E5%B7%A5%E7%A8%8B1_01.pdf';
    expect(decodeS3EventKey(encoded)).toBe('P-0001/P-0001_K001_工程1_01.pdf');
  });

  it('`+` は空白として戻す（S3 は空白を `+` で送ってくる）', () => {
    expect(decodeS3EventKey('P-0001/P-0001_K001_検査+工程_01.xlsx')).toBe(
      'P-0001/P-0001_K001_検査 工程_01.xlsx',
    );
  });

  it('元から `+` を含むキーは `%2B` で届くので `+` に戻る', () => {
    expect(decodeS3EventKey('P-0001/P-0001_K001_A%2BB_01.pdf')).toBe(
      'P-0001/P-0001_K001_A+B_01.pdf',
    );
  });

  it('デコードした結果がそのまま parseS3Key に渡せる', () => {
    const decoded = decodeS3EventKey('P-0001/P-0001_K001_%E5%B7%A5%E7%A8%8B1_01.pdf');
    expect(decoded).not.toBeNull();
    expect(parseS3Key(decoded as string)).toEqual({
      productCode: 'P-0001',
      documentNo: 'P-0001_K001_工程1_01',
      fileType: 'pdf',
    });
  });

  it('壊れたパーセント記号は null を返す', () => {
    expect(decodeS3EventKey('P-0001/%E5%B7.pdf')).toBeNull();
  });
});
