/**
 * ファイル種別×状態の組み合わせで可否が変わる部分のテスト。
 *
 * **組み合わせで間違えやすいのでここだけ切り出して試験する**（CLAUDE.md「テストを書く範囲」2 に近い性質）。
 * 判断を誤ると、削除済みの配布物が出回ったり、逆に取得できるはずのファイルが404になったりする。
 *
 * `requiresToken` と `resolveDownload` を分けてテストするのは、実装（downloadUrl.ts）で
 * 分けた理由と同じ — トークンの要否は理由付きの404/403より**先に**判定しないと、
 * トークン無しの相手に応答コードだけで削除済みかどうかが伝わってしまう（8/12のレビューで判明）。
 */
import { describe, expect, it } from 'vitest';
import type { DocumentRecord } from '../../../shared/types';
import { requiresToken, resolveDownload } from './downloadUrl';

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

describe('requiresToken', () => {
  it('最新版PDFだけトークン不要', () => {
    expect(requiresToken(record({ status: '最新' }), 'pdf')).toBe(false);
  });

  it('最新版エクセルはトークンが要る', () => {
    expect(requiresToken(record({ status: '最新' }), 'excel')).toBe(true);
  });

  it('旧版はPDFでもエクセルでもトークンが要る', () => {
    expect(requiresToken(record({ status: '旧版' }), 'pdf')).toBe(true);
    expect(requiresToken(record({ status: '旧版' }), 'excel')).toBe(true);
  });

  it('削除済みもPDF・エクセルとも「まず」トークンが要る', () => {
    // 削除済みPDFがトークンがあっても403になる判定は resolveDownload 側。
    // ここで確認するのは「トークン無しでは、削除済みかどうかが分かる手前で止まる」こと
    expect(requiresToken(record({ status: '削除済み' }), 'pdf')).toBe(true);
    expect(requiresToken(record({ status: '削除済み' }), 'excel')).toBe(true);
  });

  it('ファイル未登録・一部登録はPDFでもトークンが要る（最新ではないため）', () => {
    expect(requiresToken(record({ status: 'ファイル未登録' }), 'pdf')).toBe(true);
    expect(requiresToken(record({ status: '一部登録' }), 'pdf')).toBe(true);
  });
});

describe('resolveDownload（トークンの関門を通過した後の判定）', () => {
  it('何も問題が無ければキーを返す', () => {
    expect(resolveDownload(record({ status: '最新' }), 'pdf')).toEqual({
      ok: true,
      key: 'P-0001/Q001_P-0001_01.pdf',
    });
  });

  it('削除済みのPDFはトークンがあっても断る（配布物なので現場に出さない）', () => {
    expect(resolveDownload(record({ status: '削除済み' }), 'pdf')).toEqual({
      ok: false,
      status: 403,
      message: '削除済みの文書のPDFは取得できません',
    });
  });

  it('削除済みのエクセルは取得できる（万一の確認用）', () => {
    expect(resolveDownload(record({ status: '削除済み' }), 'excel')).toEqual({
      ok: true,
      key: 'P-0001/Q001_P-0001_01.xlsx',
    });
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
    });
    expect(resolveDownload(doc, 'excel')).toEqual({
      ok: false,
      status: 404,
      message: 'このファイルはまだ登録されていません',
    });
  });
});
