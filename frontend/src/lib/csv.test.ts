/**
 * CSV 変換の純粋関数テスト（CLAUDE.md「テストを書く範囲」）。
 *
 * 対象は `escapeCell` と `toCsv` の2つ。`downloadCsv` は DOM とブラウザの
 * ダウンロード挙動に依存するのでテストしない（実機で確かめる — 受け入れ基準⑨）。
 *
 * この2つを選ぶ理由は、**間違えても画面上は正常に見える**から。
 * 列がずれた CSV も Excel は黙って開くし、`#NAME?` になったセルは
 * ファイルを作った人ではなく受け取った人が最初に気づく。
 */
import { describe, expect, it } from 'vitest';
import { escapeCell, toCsv } from './csv';

describe('escapeCell', () => {
  it('特別な文字が無ければそのまま返す', () => {
    expect(escapeCell('P-0001')).toBe('P-0001');
    expect(escapeCell('組立工程')).toBe('組立工程');
  });

  it('空文字はそのまま', () => {
    expect(escapeCell('')).toBe('');
  });

  // カンマを許可しているのは、禁止しているのが `#` と `/` だけのため（CLAUDE.md §4）
  it('カンマを含むと引用符でくくる', () => {
    expect(escapeCell('組立,検査')).toBe('"組立,検査"');
  });

  it('引用符は2つ重ねてから、全体をくくる（RFC 4180）', () => {
    expect(escapeCell('いわゆる"仮"組立')).toBe('"いわゆる""仮""組立"');
  });

  it('改行を含むと引用符でくくる', () => {
    expect(escapeCell('1行目\n2行目')).toBe('"1行目\n2行目"');
    expect(escapeCell('1行目\r\n2行目')).toBe('"1行目\r\n2行目"');
  });

  describe('数式として解釈される値の中和', () => {
    it.each(['=', '+', '-', '@'])('先頭が「%s」なら \' を付ける', (char) => {
      expect(escapeCell(`${char}組立`)).toBe(`'${char}組立`);
    });

    // 実際に起こりうるのはこの形。悪意ではなく普通の工程名が #NAME? になる
    it('「-組立」が数式として読まれないようにする', () => {
      expect(escapeCell('-組立')).toBe("'-組立");
    });

    it('途中に記号があるだけなら何もしない', () => {
      expect(escapeCell('組立-仮')).toBe('組立-仮');
      expect(escapeCell('A=B')).toBe('A=B');
    });

    /**
     * 中和とくくりが同時に要る場合。
     * `'` を足してからくくらないと、足した文字がくくりの外に出て列がずれる。
     */
    it('中和した値にカンマがあれば、\' を含めて引用符でくくる', () => {
      expect(escapeCell('-組立,検査')).toBe(`"'-組立,検査"`);
    });
  });
});

describe('toCsv', () => {
  it('ヘッダー行とデータ行を CRLF で繋ぐ', () => {
    const csv = toCsv(['文書番号', '状態'], [['Q001_P-0001_01', '最新']]);
    expect(csv).toBe('文書番号,状態\r\nQ001_P-0001_01,最新');
  });

  it('ヘッダーだけでも出せる（絞り込みの結果が0件のとき）', () => {
    expect(toCsv(['文書番号'], [])).toBe('文書番号');
  });

  it('各セルにエスケープが適用される', () => {
    const csv = toCsv(['工程名'], [['組立,検査'], ['-組立']]);
    expect(csv).toBe(`工程名\r\n"組立,検査"\r\n'-組立`);
  });
});
