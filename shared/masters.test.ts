/**
 * マスタ判定の純粋関数テスト（CLAUDE.md「テストを書く範囲」1に準ずる）。
 *
 * 対象は2つに絞る。他の判定関数（`activeMasters` 等）は単純なフィルタで
 * 間違えにくいため対象外（CLAUDE.md「全体網羅はしない」）。
 *
 *   hasAnotherProcessScopedDocumentType — 「工程単位の文書種類は1つまで」
 *   ownerChangeRejection               — S-7 の「変更するときだけ有効を要求する」規律
 *
 * 後者を入れるのは、**他の3経路（新規発行・リビジョンアップ）と規律が違う唯一の場所**だから。
 * 間違えると壊れ方が「本来断るものを通す」か「直せるはずのものを断る」のどちらかで、
 * どちらも正常系のテストでは気づけない。
 */
import { describe, expect, it } from 'vitest';
import { hasAnotherProcessScopedDocumentType, ownerChangeRejection } from './masters';
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

/**
 * S-7（`PATCH /documents/{docNo}`）の担当者。
 *
 * **据え置きなら無効でも通し、変更するなら有効だけ**（docs/context.md 8/14 の決定）。
 * 境界は「新規発行か改訂か」ではなく「利用者が選ぶ値か、引き継ぐ値か」。
 */
describe('ownerChangeRejection', () => {
  const owners: MasterRecord[] = [
    { category: '担当者', code: 'E001', name: '山田太郎', status: '有効', registeredAt: '' },
    { category: '担当者', code: 'E003', name: '鈴木一郎', status: '無効', registeredAt: '' },
  ];

  it('担当者を変えなければ通る（有効な担当者）', () => {
    expect(ownerChangeRejection(owners, '山田太郎', '山田太郎')).toBeNull();
  });

  it('担当者を変えなければ、無効化されていても通る（発行日だけ直せる）', () => {
    expect(ownerChangeRejection(owners, '鈴木一郎', '鈴木一郎')).toBeNull();
  });

  it('マスタから消えた担当者でも、据え置きなら通る（過去の記録を人質にしない）', () => {
    expect(ownerChangeRejection(owners, '退職者', '退職者')).toBeNull();
  });

  it('有効な担当者へ変更できる', () => {
    expect(ownerChangeRejection(owners, '鈴木一郎', '山田太郎')).toBeNull();
  });

  it('無効な担当者へは変更できない', () => {
    expect(ownerChangeRejection(owners, '山田太郎', '鈴木一郎')).toBe(
      'この担当者は無効化されています。有効な担当者を選んでください',
    );
  });

  it('マスタに無い担当者へは変更できない（無効化とは文言を分ける）', () => {
    expect(ownerChangeRejection(owners, '山田太郎', '架空の人')).toBe(
      '担当者がマスタに登録されていません',
    );
  });

  it('担当者以外のマスタに同じ名前があっても引っかからない', () => {
    const masters: MasterRecord[] = [
      ...owners,
      { category: '製品コード', code: 'P-0001', name: '架空の人', status: '有効', registeredAt: '' },
    ];
    expect(ownerChangeRejection(masters, '山田太郎', '架空の人')).toBe(
      '担当者がマスタに登録されていません',
    );
  });
});
