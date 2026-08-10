/**
 * 「工程単位の文書種類は1つまで」判定の純粋関数テスト（CLAUDE.md「テストを書く範囲」1に準ずる）。
 *
 * 対象を `hasAnotherProcessScopedDocumentType` に絞る。他の判定関数（`activeMasters` 等）は
 * 単純なフィルタで間違えにくいため対象外（CLAUDE.md「全体網羅はしない」）。
 */
import { describe, expect, it } from 'vitest';
import { hasAnotherProcessScopedDocumentType } from './masters';
import type { MasterRecord } from './types';

const base: Omit<MasterRecord, 'code' | 'numberingRule'> = {
  category: '文書種類',
  name: 'テスト文書種類',
  status: '有効',
  registeredAt: '2026-08-10T00:00:00.000Z',
};

describe('hasAnotherProcessScopedDocumentType', () => {
  it('工程単位が1件も無ければ false', () => {
    const masters: MasterRecord[] = [{ ...base, code: 'Q001', numberingRule: '製品単位' }];
    expect(hasAnotherProcessScopedDocumentType(masters)).toBe(false);
  });

  it('工程単位が1件あれば true（新規追加＝excludeCode無しのとき）', () => {
    const masters: MasterRecord[] = [{ ...base, code: 'Q010', numberingRule: '工程単位' }];
    expect(hasAnotherProcessScopedDocumentType(masters)).toBe(true);
  });

  it('excludeCode で自分自身を除ける（PATCH で他に無ければ false）', () => {
    const masters: MasterRecord[] = [{ ...base, code: 'Q010', numberingRule: '工程単位' }];
    expect(hasAnotherProcessScopedDocumentType(masters, 'Q010')).toBe(false);
  });

  it('自分以外に工程単位があれば excludeCode を渡しても true', () => {
    const masters: MasterRecord[] = [
      { ...base, code: 'Q010', numberingRule: '工程単位' },
      { ...base, code: 'Q011', numberingRule: '工程単位' },
    ];
    expect(hasAnotherProcessScopedDocumentType(masters, 'Q011')).toBe(true);
  });

  it('無効化されていても数える（無効は新規発行を止めるだけで番号の唯一性とは別軸）', () => {
    const masters: MasterRecord[] = [
      { ...base, code: 'Q010', numberingRule: '工程単位', status: '無効' },
    ];
    expect(hasAnotherProcessScopedDocumentType(masters)).toBe(true);
  });

  it('文書種類以外（製品コード等）は数えない', () => {
    const masters: MasterRecord[] = [
      { category: '製品コード', code: 'P-0001', name: '製品A', status: '有効', registeredAt: '' },
    ];
    expect(hasAnotherProcessScopedDocumentType(masters)).toBe(false);
  });
});
