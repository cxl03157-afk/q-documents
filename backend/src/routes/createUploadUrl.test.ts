/**
 * 台帳の状態から見た拒否判定のテスト。
 *
 * **組み合わせで間違えやすいのでここだけ切り出して試験する**（CLAUDE.md「テストを行う範囲」2）。
 * 実際、案内文（「エクセルのみ登録できます」）を要求された種別から組み立てると、
 * 「PDFだけ要求・両方とも登録済み」のときに嘘をつく。書いている最中に踏んだ。
 *
 * ここを抜けると、直接呼び出しで**配布済みのPDFを差し替えられる**署名付きURLが出る。
 */
import { describe, expect, it } from 'vitest';
import type { DocumentRecord } from '../../../shared/types';
import { rejectionReason } from './createUploadUrl';

function record(overrides: Partial<DocumentRecord> = {}): DocumentRecord {
  return {
    productCode: 'P-0001',
    sortKey: 'Q001_P-0001#01',
    documentNo: 'Q001_P-0001_01',
    documentType: 'Q001',
    revision: '01',
    owner: '山田太郎',
    issuedAt: '2026-08-10',
    registeredAt: '2026-08-10T00:00:00.000Z',
    status: 'ファイル未登録',
    ...overrides,
  };
}

const BOTH = { pdfName: 'Q001_P-0001_01.pdf', excelName: 'Q001_P-0001_01.xlsx' };
const PDF_ONLY = { pdfName: 'Q001_P-0001_01.pdf' };
const EXCEL_ONLY = { excelName: 'Q001_P-0001_01.xlsx' };

describe('rejectionReason', () => {
  it('何も登録されていなければ通す', () => {
    expect(rejectionReason(record(), BOTH)).toBeNull();
  });

  it('旧版は状態だけで断る（キーの有無より先に見る）', () => {
    expect(rejectionReason(record({ status: '旧版' }), BOTH)).toBe(
      'このリビジョンは旧版です。最新のリビジョンにアップロードしてください',
    );
  });

  it('削除済みも断る（screens.md の拒否理由3つには無いが、通すと消した版の実体がS3に入る）', () => {
    expect(rejectionReason(record({ status: '削除済み' }), BOTH)).toBe(
      'この文書は削除済みです。新規発行でやり直してください',
    );
  });

  /**
   * ここからが「一部登録」を復旧可能にしたことの中身（要件定義書 F-01）。
   * 判断に使うのは状態ではなく**S3キーの有無**。段1（キーの記録）から
   * 段2（状態の更新）までに隙があり、その間は状態が追いついていない。
   */
  it('未登録の種別だけを要求すれば通す（状態が追いついていなくても）', () => {
    const partial = record({ s3KeyPdf: 'P-0001/Q001_P-0001_01.pdf' });

    expect(rejectionReason(partial, EXCEL_ONLY)).toBeNull();
    expect(rejectionReason(record({ ...partial, status: '一部登録' }), EXCEL_ONLY)).toBeNull();
  });

  it('登録済みの種別を要求したら断り、空いている種別を案内する', () => {
    const partial = record({ s3KeyPdf: 'P-0001/Q001_P-0001_01.pdf' });

    expect(rejectionReason(partial, PDF_ONLY)).toBe(
      'このリビジョンのPDFは既に登録されています。エクセルのみ登録できます',
    );
    // 両方送られてきても同じ。要求したURLが黙って返らない形にはしない
    expect(rejectionReason(partial, BOTH)).toBe(
      'このリビジョンのPDFは既に登録されています。エクセルのみ登録できます',
    );
  });

  it('両方とも登録済みなら案内しない（案内を要求から組み立てると嘘になる箇所）', () => {
    const full = record({
      s3KeyPdf: 'P-0001/Q001_P-0001_01.pdf',
      s3KeyExcel: 'P-0001/Q001_P-0001_01.xlsx',
      status: '最新',
    });

    // PDFだけ要求しても「エクセルのみ登録できます」とは言わない
    expect(rejectionReason(full, PDF_ONLY)).toBe('このリビジョンのPDFは既に登録されています');
    expect(rejectionReason(full, EXCEL_ONLY)).toBe('このリビジョンのエクセルは既に登録されています');
    expect(rejectionReason(full, BOTH)).toBe(
      'このリビジョンのPDFとエクセルは既に登録されています',
    );
  });

  it('エクセルだけ登録済みの場合も対称に扱う', () => {
    const partial = record({ s3KeyExcel: 'P-0001/Q001_P-0001_01.xlsx' });

    expect(rejectionReason(partial, PDF_ONLY)).toBeNull();
    expect(rejectionReason(partial, BOTH)).toBe(
      'このリビジョンのエクセルは既に登録されています。PDFのみ登録できます',
    );
  });
});
