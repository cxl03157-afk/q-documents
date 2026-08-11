/**
 * Rev up を断るときの文言のテスト。
 *
 * 「最新でなければ Rev up させない」という規律そのものは DynamoDB を伴うので
 * 本番の実測で確認する。ここで確かめるのは、**利用者が次に何をすればよいか**が
 * 状態ごとに正しく出ることだけ。
 */

import { describe, expect, it } from 'vitest';
import type { DocumentRecord } from '../../../shared/types';
import { incompleteRevisionMessage } from './createRevision';

function record(keys: { pdf?: boolean; excel?: boolean }): DocumentRecord {
  return {
    productCode: 'P-0001',
    sortKey: 'Q001_P-0001#01',
    documentNo: 'Q001_P-0001_01',
    documentType: 'Q001',
    revision: '01',
    owner: '山田太郎',
    issuedAt: '2026-08-11',
    registeredAt: '2026-08-11T00:00:00.000Z',
    status: '一部登録',
    s3KeyPdf: keys.pdf === true ? 'P-0001/Q001_P-0001_01.pdf' : undefined,
    s3KeyExcel: keys.excel === true ? 'P-0001/Q001_P-0001_01.xlsx' : undefined,
  };
}

describe('incompleteRevisionMessage', () => {
  it('両方とも無ければ、2種類とも登録するよう案内する', () => {
    expect(incompleteRevisionMessage(record({}))).toContain('PDFとエクセルを登録して');
  });

  it('PDFだけ登録済みなら、足りないのはエクセルだと名指しする', () => {
    const message = incompleteRevisionMessage(record({ pdf: true }));
    expect(message).toContain('エクセルが未登録');
    expect(message).not.toContain('PDFが未登録');
  });

  it('エクセルだけ登録済みなら、足りないのはPDFだと名指しする', () => {
    const message = incompleteRevisionMessage(record({ excel: true }));
    expect(message).toContain('PDFが未登録');
    expect(message).not.toContain('エクセルが未登録');
  });

  /**
   * 段1（キーの記録）から段2（状態の更新）までの隙に入った場合。
   * 足りないものは無いので、待てば解消することを伝える。
   */
  it('両方揃っているのに最新でなければ、処理中として待つよう案内する', () => {
    expect(incompleteRevisionMessage(record({ pdf: true, excel: true }))).toContain(
      'しばらく待ってから',
    );
  });
});
