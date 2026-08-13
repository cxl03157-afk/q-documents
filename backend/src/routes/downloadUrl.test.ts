/**
 * ファイル種別×状態の組み合わせで可否が変わる部分のテスト。
 *
 * **組み合わせで間違えやすいのでここだけ切り出して試験する**（CLAUDE.md「テストを書く範囲」2 に近い性質）。
 * 判断を誤ると、削除済みの配布物が出回ったり、逆に取得できるはずのファイルが404になったりする。
 */
import { describe, expect, it } from 'vitest';
import type { DocumentRecord } from '../../../shared/types';
import { resolveDownload } from './downloadUrl';

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
    status: '最新',
    s3KeyPdf: 'P-0001/Q001_P-0001_01.pdf',
    s3KeyExcel: 'P-0001/Q001_P-0001_01.xlsx',
    ...overrides,
  };
}

describe('resolveDownload', () => {
  it('最新版PDFはトークン不要で取得できる', () => {
    const result = resolveDownload(record({ status: '最新' }), 'pdf');
    expect(result).toEqual({ ok: true, key: 'P-0001/Q001_P-0001_01.pdf', requiresToken: false });
  });

  it('最新版エクセルはトークンが要る', () => {
    const result = resolveDownload(record({ status: '最新' }), 'excel');
    expect(result).toEqual({ ok: true, key: 'P-0001/Q001_P-0001_01.xlsx', requiresToken: true });
  });

  it('旧版はPDFでもトークンが要る', () => {
    const result = resolveDownload(record({ status: '旧版' }), 'pdf');
    expect(result).toEqual({ ok: true, key: 'P-0001/Q001_P-0001_01.pdf', requiresToken: true });
  });

  it('旧版のエクセルもトークンが要る', () => {
    const result = resolveDownload(record({ status: '旧版' }), 'excel');
    expect(result).toEqual({ ok: true, key: 'P-0001/Q001_P-0001_01.xlsx', requiresToken: true });
  });

  it('削除済みのPDFはトークンがあっても断る（配布物なので現場に出さない）', () => {
    const result = resolveDownload(record({ status: '削除済み' }), 'pdf');
    expect(result).toEqual({ ok: false, status: 403, message: '削除済みの文書のPDFは取得できません' });
  });

  it('削除済みのエクセルはトークンがあれば取得できる（万一の確認用）', () => {
    const result = resolveDownload(record({ status: '削除済み' }), 'excel');
    expect(result).toEqual({ ok: true, key: 'P-0001/Q001_P-0001_01.xlsx', requiresToken: true });
  });

  it('ファイル未登録はキーが無いので404（状態より先にキーの有無で判断される）', () => {
    const doc = record({ status: 'ファイル未登録', s3KeyPdf: undefined, s3KeyExcel: undefined });
    expect(resolveDownload(doc, 'pdf')).toEqual({
      ok: false,
      status: 404,
      message: 'このファイルはまだ登録されていません',
    });
    expect(resolveDownload(doc, 'excel')).toEqual({
      ok: false,
      status: 404,
      message: 'このファイルはまだ登録されていません',
    });
  });

  it('一部登録でも、埋まっている種別だけは取得できる', () => {
    const doc = record({ status: '一部登録', s3KeyExcel: undefined });
    expect(resolveDownload(doc, 'pdf')).toEqual({
      ok: true,
      key: 'P-0001/Q001_P-0001_01.pdf',
      requiresToken: true, // 一部登録は「最新」ではないのでPDFでもトークンが要る
    });
    expect(resolveDownload(doc, 'excel')).toEqual({
      ok: false,
      status: 404,
      message: 'このファイルはまだ登録されていません',
    });
  });
});
