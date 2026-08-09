import { describe, expect, it } from 'vitest';
import type { DocumentRecord, MasterRecord } from '../../shared/types';
import { deriveDocumentNumber, findBlockingRevision } from './documentNumber';

const MASTERS: MasterRecord[] = [
  { category: '文書種類', code: 'Q001', name: 'PFMEA', status: '有効', registeredAt: '2026-01-10', numberingRule: '製品単位' },
  { category: '文書種類', code: 'Q010', name: '作業指示書', status: '有効', registeredAt: '2026-01-10', numberingRule: '工程単位' },
  { category: '文書種類', code: 'Q090', name: '廃止された種類', status: '無効', registeredAt: '2026-01-10', numberingRule: '製品単位' },
  // 採番ルールを設定し忘れたマスタ。入力の誤りとは区別する
  { category: '文書種類', code: 'Q099', name: 'ルール未設定', status: '有効', registeredAt: '2026-01-10' },

  { category: '製品コード', code: 'P-0001', name: '製品A', status: '有効', registeredAt: '2026-01-10' },
  { category: '製品コード', code: 'P-0003', name: '製品C', status: '無効', registeredAt: '2026-01-10' },
  { category: '製品コード', code: 'COM001', name: '共通作業', status: '有効', registeredAt: '2026-01-10', isCommon: true },

  { category: '工程番号', code: 'K001', name: '工程1', status: '有効', registeredAt: '2026-01-10' },
  // 工程名にアンダースコアが入る場合。末尾から切るパース方式の根拠（CLAUDE.md §4）
  { category: '工程番号', code: 'K002', name: '組立_仮', status: '有効', registeredAt: '2026-01-10' },
  // SK と S3キーを壊す文字。マスタ登録時にも弾くが、採番でも見る
  { category: '工程番号', code: 'K003', name: '検査/最終', status: '有効', registeredAt: '2026-01-10' },
  { category: '工程番号', code: 'K009', name: '廃止工程', status: '無効', registeredAt: '2026-01-10' },
];

function derive(input: { documentType: string; productCode: string; processNo?: string }) {
  return deriveDocumentNumber(MASTERS, input);
}

describe('deriveDocumentNumber — 製品単位', () => {
  it('文書種類_製品コード_01 になる', () => {
    const result = derive({ documentType: 'Q001', productCode: 'P-0001' });

    expect(result).toEqual({
      ok: true,
      value: {
        numberingRule: '製品単位',
        documentType: 'Q001',
        productCode: 'P-0001',
        processNo: undefined,
        processName: undefined,
        documentId: 'Q001_P-0001',
        documentNo: 'Q001_P-0001_01',
        revision: '01',
        sortKey: 'Q001_P-0001#01',
      },
    });
  });

  it('工程番号を送ると拒否する', () => {
    // 黙って捨てると、呼び出し側は工程を指定できたつもりのまま製品単位の番号を受け取る
    const result = derive({ documentType: 'Q001', productCode: 'P-0001', processNo: 'K001' });

    expect(result.ok).toBe(false);
  });

  it('空文字の工程番号は未指定として扱う', () => {
    // フォームは選択なしを空文字で送ってくる
    const result = derive({ documentType: 'Q001', productCode: 'P-0001', processNo: '' });

    expect(result.ok).toBe(true);
  });
});

describe('deriveDocumentNumber — 工程単位', () => {
  it('製品コード_工程番号_工程名_01 になる', () => {
    const result = derive({ documentType: 'Q010', productCode: 'P-0001', processNo: 'K001' });

    expect(result).toEqual({
      ok: true,
      value: {
        numberingRule: '工程単位',
        documentType: 'Q010',
        productCode: 'P-0001',
        processNo: 'K001',
        processName: '工程1',
        documentId: 'P-0001_K001_工程1',
        documentNo: 'P-0001_K001_工程1_01',
        revision: '01',
        sortKey: 'P-0001_K001_工程1#01',
      },
    });
  });

  it('工程名にアンダースコアが入っても文書IDを取り違えない', () => {
    const result = derive({ documentType: 'Q010', productCode: 'P-0001', processNo: 'K002' });

    expect(result.ok && result.value.documentNo).toBe('P-0001_K002_組立_仮_01');
    expect(result.ok && result.value.documentId).toBe('P-0001_K002_組立_仮');
    expect(result.ok && result.value.revision).toBe('01');
  });

  it('工程名は工程番号マスタから引く（申告は使わない）', () => {
    // K001 の工程名は「工程1」。呼び出し側が別の名前を送る余地がそもそも無い
    const result = derive({ documentType: 'Q010', productCode: 'P-0001', processNo: 'K001' });

    expect(result.ok && result.value.processName).toBe('工程1');
  });

  it('工程番号が無ければ拒否する', () => {
    expect(derive({ documentType: 'Q010', productCode: 'P-0001' }).ok).toBe(false);
  });

  it('無効な工程番号は拒否する', () => {
    expect(
      derive({ documentType: 'Q010', productCode: 'P-0001', processNo: 'K009' }).ok,
    ).toBe(false);
  });

  it('マスタに無い工程番号は拒否する', () => {
    expect(
      derive({ documentType: 'Q010', productCode: 'P-0001', processNo: 'K404' }).ok,
    ).toBe(false);
  });

  it('工程名に禁止文字が入っていたら組み立てない', () => {
    // `/` が入ると S3キーの階層が増え、`#` が入ると SK が壊れる（CLAUDE.md §4）
    const result = derive({ documentType: 'Q010', productCode: 'P-0001', processNo: 'K003' });

    expect(result.ok).toBe(false);
  });
});

describe('deriveDocumentNumber — 共通コード', () => {
  it('工程単位なら発行できる', () => {
    const result = derive({ documentType: 'Q010', productCode: 'COM001', processNo: 'K001' });

    expect(result.ok && result.value.documentNo).toBe('COM001_K001_工程1_01');
  });

  it('製品単位は拒否する', () => {
    // 共通作業に PFMEA・QC工程表は存在しない
    expect(derive({ documentType: 'Q001', productCode: 'COM001' }).ok).toBe(false);
  });
});

describe('deriveDocumentNumber — マスタの状態', () => {
  it('無効な文書種類は拒否する', () => {
    expect(derive({ documentType: 'Q090', productCode: 'P-0001' }).ok).toBe(false);
  });

  it('無効な製品コードは拒否する', () => {
    expect(derive({ documentType: 'Q001', productCode: 'P-0003' }).ok).toBe(false);
  });

  it('マスタに無い文書種類は拒否する', () => {
    expect(derive({ documentType: 'Q404', productCode: 'P-0001' }).ok).toBe(false);
  });

  it('採番ルール未設定は入力の誤りと文言を分ける', () => {
    const result = derive({ documentType: 'Q099', productCode: 'P-0001' });

    expect(result.ok).toBe(false);
    expect(!result.ok && result.message).toContain('採番ルール');
  });
});

// ---------------------------------------------------------------------------

function record(revision: string, status: DocumentRecord['status']): DocumentRecord {
  return {
    productCode: 'P-0001',
    sortKey: `Q001_P-0001#${revision}`,
    documentNo: `Q001_P-0001_${revision}`,
    documentType: 'Q001',
    revision,
    owner: '山田太郎',
    issuedAt: '2026-08-10',
    registeredAt: '2026-08-10T00:00:00.000Z',
    status,
  };
}

describe('findBlockingRevision', () => {
  it('リビジョンが無ければ発行できる', () => {
    expect(findBlockingRevision([])).toBeUndefined();
  });

  it('現行リビジョン（最大）を返す', () => {
    const blocking = findBlockingRevision([
      record('01', '旧版'),
      record('02', '最新'),
    ]);

    expect(blocking?.revision).toBe('02');
  });

  it('削除済みだけなら発行できる', () => {
    // 論理削除したものを数えると、同じ番号で発行し直せなくなる（CLAUDE.md §5）
    expect(findBlockingRevision([record('01', '削除済み')])).toBeUndefined();
  });

  it('削除済みは現行リビジョンの判定からも外す', () => {
    const blocking = findBlockingRevision([
      record('01', '最新'),
      record('02', '削除済み'),
    ]);

    expect(blocking?.revision).toBe('01');
  });

  it('Rev 99 を超えても大小を取り違えない', () => {
    // 文字列比較だと '100' < '99' になる
    const blocking = findBlockingRevision([record('99', '旧版'), record('100', '最新')]);

    expect(blocking?.revision).toBe('100');
  });
});
