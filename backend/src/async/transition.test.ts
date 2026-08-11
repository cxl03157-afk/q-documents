/**
 * 状態遷移の判定のテスト（CLAUDE.md §12 のテスト対象2）。
 *
 * ここが狂うと、ファイルが揃っていないのに「最新」になったり、
 * 前リビジョンが「最新」のまま残って一覧に2行並んだりする。
 * どちらも品質文書の台帳としては通せない壊れ方なので、機械で確認できる範囲は確認する。
 */

import { describe, expect, it } from 'vitest';
import type { DocumentRecord, DocumentStatus } from '../../../shared/types';
import {
  needsStorageClassChange,
  nextStatus,
  revisionsAlreadyArchived,
  revisionsToArchive,
} from './transition';

/** 台帳のレコードを1件組み立てる。試験に関係する属性だけを引数にする */
function record(
  revision: string,
  status: DocumentStatus,
  keys: { pdf?: boolean; excel?: boolean } = {},
): DocumentRecord {
  const documentNo = `Q001_P-0001_${revision}`;
  return {
    productCode: 'P-0001',
    sortKey: `Q001_P-0001#${revision}`,
    documentNo,
    documentType: 'Q001',
    revision,
    owner: '山田太郎',
    issuedAt: '2026-08-10',
    registeredAt: '2026-08-10T00:00:00.000Z',
    status,
    s3KeyPdf: keys.pdf === true ? `P-0001/${documentNo}.pdf` : undefined,
    s3KeyExcel: keys.excel === true ? `P-0001/${documentNo}.xlsx` : undefined,
  };
}

describe('nextStatus', () => {
  it('両方のキーが揃っていれば「最新」', () => {
    expect(nextStatus(record('01', 'ファイル未登録', { pdf: true, excel: true }))).toBe('最新');
  });

  it('PDFだけなら「一部登録」', () => {
    expect(nextStatus(record('01', 'ファイル未登録', { pdf: true }))).toBe('一部登録');
  });

  it('エクセルだけなら「一部登録」', () => {
    expect(nextStatus(record('01', 'ファイル未登録', { excel: true }))).toBe('一部登録');
  });

  it('どちらも無ければ null', () => {
    expect(nextStatus(record('01', 'ファイル未登録'))).toBeNull();
  });

  it('「一部登録」から両方揃えば「最新」へ進む（要件定義書 F-01）', () => {
    expect(nextStatus(record('01', '一部登録', { pdf: true, excel: true }))).toBe('最新');
  });

  /**
   * 現在の状態を見ないことの確認。
   * 「そこへ進んでよいか」は条件付き書き込みが決める（async/ledger.ts）。
   * ここが状態も見て判断すると、規律が2か所に分かれて食い違う余地ができる。
   */
  it('現在の状態では判断を変えない（進んでよいかは条件式が決める）', () => {
    expect(nextStatus(record('01', '最新', { pdf: true, excel: true }))).toBe('最新');
    expect(nextStatus(record('01', '旧版', { pdf: true, excel: true }))).toBe('最新');
    expect(nextStatus(record('01', '削除済み', { pdf: true, excel: true }))).toBe('最新');
  });
});

describe('revisionsToArchive', () => {
  it('今回より前で「最新」のものを拾う', () => {
    const revisions = [
      record('01', '最新', { pdf: true, excel: true }),
      record('02', '最新', { pdf: true, excel: true }),
    ];
    expect(revisionsToArchive(revisions, '02').map((r) => r.revision)).toEqual(['01']);
  });

  it('自分自身は対象にしない', () => {
    const revisions = [record('02', '最新', { pdf: true, excel: true })];
    expect(revisionsToArchive(revisions, '02')).toEqual([]);
  });

  /** 新しい版を旧版に落とすのは「逆方向の遷移はない」に反する（CLAUDE.md §5） */
  it('自分より後のリビジョンは対象にしない', () => {
    const revisions = [record('03', '最新', { pdf: true, excel: true })];
    expect(revisionsToArchive(revisions, '02')).toEqual([]);
  });

  it('「最新」以外は対象にしない', () => {
    const revisions = [
      record('01', '旧版'),
      record('02', 'ファイル未登録'),
      record('03', '一部登録', { pdf: true }),
      record('04', '削除済み'),
    ];
    expect(revisionsToArchive(revisions, '05')).toEqual([]);
  });

  it('前リビジョンが複数「最新」で残っていれば全部拾う', () => {
    const revisions = [
      record('01', '最新', { pdf: true, excel: true }),
      record('02', '最新', { pdf: true, excel: true }),
      record('03', '最新', { pdf: true, excel: true }),
    ];
    expect(revisionsToArchive(revisions, '03').map((r) => r.revision)).toEqual(['01', '02']);
  });

  /** リビジョンは2桁ゼロ埋め固定なので、文字列のまま比較して順序が保たれる */
  it('2桁ゼロ埋めの文字列比較で順序どおりに並ぶ', () => {
    const revisions = [
      record('09', '最新', { pdf: true, excel: true }),
      record('10', '最新', { pdf: true, excel: true }),
    ];
    expect(revisionsToArchive(revisions, '10').map((r) => r.revision)).toEqual(['09']);
    expect(revisionsToArchive(revisions, '09')).toEqual([]);
  });
});

describe('revisionsAlreadyArchived', () => {
  it('今回より前で既に「旧版」のものを拾う', () => {
    const revisions = [
      record('01', '旧版', { pdf: true, excel: true }),
      record('02', '最新', { pdf: true, excel: true }),
    ];
    expect(revisionsAlreadyArchived(revisions, '03').map((r) => r.revision)).toEqual(['01']);
  });

  it('「旧版」以外は対象にしない', () => {
    const revisions = [
      record('01', '最新', { pdf: true, excel: true }),
      record('02', '削除済み'),
      record('03', '一部登録', { excel: true }),
    ];
    expect(revisionsAlreadyArchived(revisions, '04')).toEqual([]);
  });

  it('自分自身と後続は対象にしない', () => {
    const revisions = [record('02', '旧版'), record('03', '旧版')];
    expect(revisionsAlreadyArchived(revisions, '02')).toEqual([]);
  });
});

describe('needsStorageClassChange', () => {
  /**
   * HeadObject は Standard のとき StorageClass を返さない。
   * これを「不明」として扱うと、Standard のオブジェクトに毎回コピーが走る。
   */
  it('未指定は Standard とみなす', () => {
    expect(needsStorageClassChange(undefined, 'STANDARD')).toBe(false);
    expect(needsStorageClassChange(undefined, 'GLACIER_IR')).toBe(true);
  });

  it('すでに目的のクラスなら変更しない（Glacier IR の再コピーを防ぐ）', () => {
    expect(needsStorageClassChange('GLACIER_IR', 'GLACIER_IR')).toBe(false);
    expect(needsStorageClassChange('STANDARD_IA', 'STANDARD_IA')).toBe(false);
  });

  it('違うクラスなら変更する', () => {
    expect(needsStorageClassChange('STANDARD_IA', 'GLACIER_IR')).toBe(true);
    expect(needsStorageClassChange('STANDARD', 'GLACIER_IR')).toBe(true);
  });
});
