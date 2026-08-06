/**
 * S-1 の一覧表示で使うハードコードデータ（週2で `GET /documents` に差し替える）。
 * 台帳APIは論理削除済みを除いて返す設計（API.md）なので、削除済みレコードはここに含めない。
 *
 * 状態5値・PFMEA/QC工程表（製品単位）・作業指示書（工程単位）の組み合わせを一通り含める。
 */

import type { DocumentRecord } from '../../../shared/types';

/**
 * モックの台帳。S-3・S-4 の登録はこの配列への追加で表現する。
 * ページを再読込すると初期状態に戻る（永続化は週2の API 接続で入る）。
 */
export const mockDocuments: DocumentRecord[] = [
  // P-0001: PFMEA が旧版→最新でリビジョンアップ済み
  {
    productCode: 'P-0001',
    sortKey: 'Q001_P-0001#01',
    documentNo: 'Q001_P-0001_01',
    documentType: 'Q001',
    revision: '01',
    owner: '山田太郎',
    issuedAt: '2026-06-01',
    registeredAt: '2026-06-01T09:00:00Z',
    status: '旧版',
    s3KeyPdf: 'Q001_P-0001_01.pdf',
    s3KeyExcel: 'Q001_P-0001_01.xlsx',
  },
  {
    productCode: 'P-0001',
    sortKey: 'Q001_P-0001#02',
    documentNo: 'Q001_P-0001_02',
    documentType: 'Q001',
    revision: '02',
    owner: '山田太郎',
    issuedAt: '2026-07-15',
    registeredAt: '2026-07-15T09:00:00Z',
    status: '最新',
    s3KeyPdf: 'Q001_P-0001_02.pdf',
    s3KeyExcel: 'Q001_P-0001_02.xlsx',
  },
  {
    productCode: 'P-0001',
    sortKey: 'Q005_P-0001#01',
    documentNo: 'Q005_P-0001_01',
    documentType: 'Q005',
    revision: '01',
    owner: '山田太郎',
    issuedAt: '2026-06-01',
    registeredAt: '2026-06-01T09:00:00Z',
    status: '最新',
    s3KeyPdf: 'Q005_P-0001_01.pdf',
    s3KeyExcel: 'Q005_P-0001_01.xlsx',
  },
  // P-0001 工程1: 作業指示書も旧版→最新
  {
    productCode: 'P-0001',
    sortKey: 'P-0001_K001_工程1#01',
    documentNo: 'P-0001_K001_工程1_01',
    documentType: 'Q010',
    processNo: 'K001',
    processName: '工程1',
    revision: '01',
    owner: '佐藤花子',
    issuedAt: '2026-06-05',
    registeredAt: '2026-06-05T09:00:00Z',
    status: '旧版',
    s3KeyPdf: 'P-0001_K001_工程1_01.pdf',
    s3KeyExcel: 'P-0001_K001_工程1_01.xlsx',
  },
  {
    productCode: 'P-0001',
    sortKey: 'P-0001_K001_工程1#02',
    documentNo: 'P-0001_K001_工程1_02',
    documentType: 'Q010',
    processNo: 'K001',
    processName: '工程1',
    revision: '02',
    owner: '佐藤花子',
    issuedAt: '2026-07-20',
    registeredAt: '2026-07-20T09:00:00Z',
    status: '最新',
    s3KeyPdf: 'P-0001_K001_工程1_02.pdf',
    s3KeyExcel: 'P-0001_K001_工程1_02.xlsx',
  },
  {
    productCode: 'P-0001',
    sortKey: 'P-0001_K002_工程2#01',
    documentNo: 'P-0001_K002_工程2_01',
    documentType: 'Q010',
    processNo: 'K002',
    processName: '工程2',
    revision: '01',
    owner: '佐藤花子',
    issuedAt: '2026-06-10',
    registeredAt: '2026-06-10T09:00:00Z',
    status: '最新',
    s3KeyPdf: 'P-0001_K002_工程2_01.pdf',
    s3KeyExcel: 'P-0001_K002_工程2_01.xlsx',
  },

  // P-0002: 登録漏れの例（一部登録・ファイル未登録）
  {
    productCode: 'P-0002',
    sortKey: 'Q001_P-0002#01',
    documentNo: 'Q001_P-0002_01',
    documentType: 'Q001',
    revision: '01',
    owner: '山田太郎',
    issuedAt: '2026-07-25',
    registeredAt: '2026-07-25T09:00:00Z',
    status: '一部登録',
    s3KeyPdf: 'Q001_P-0002_01.pdf',
    // s3KeyExcel 未登録
  },
  {
    productCode: 'P-0002',
    sortKey: 'Q005_P-0002#01',
    documentNo: 'Q005_P-0002_01',
    documentType: 'Q005',
    revision: '01',
    owner: '山田太郎',
    issuedAt: '2026-07-28',
    registeredAt: '2026-07-28T09:00:00Z',
    status: 'ファイル未登録',
  },

  // P-0003: 一式そろっている通常ケース
  {
    productCode: 'P-0003',
    sortKey: 'Q001_P-0003#01',
    documentNo: 'Q001_P-0003_01',
    documentType: 'Q001',
    revision: '01',
    owner: '佐藤花子',
    issuedAt: '2026-07-01',
    registeredAt: '2026-07-01T09:00:00Z',
    status: '最新',
    s3KeyPdf: 'Q001_P-0003_01.pdf',
    s3KeyExcel: 'Q001_P-0003_01.xlsx',
  },
  {
    productCode: 'P-0003',
    sortKey: 'Q005_P-0003#01',
    documentNo: 'Q005_P-0003_01',
    documentType: 'Q005',
    revision: '01',
    owner: '佐藤花子',
    issuedAt: '2026-07-01',
    registeredAt: '2026-07-01T09:00:00Z',
    status: '最新',
    s3KeyPdf: 'Q005_P-0003_01.pdf',
    s3KeyExcel: 'Q005_P-0003_01.xlsx',
  },
  {
    productCode: 'P-0003',
    sortKey: 'P-0003_K001_工程1#01',
    documentNo: 'P-0003_K001_工程1_01',
    documentType: 'Q010',
    processNo: 'K001',
    processName: '工程1',
    revision: '01',
    owner: '佐藤花子',
    issuedAt: '2026-07-02',
    registeredAt: '2026-07-02T09:00:00Z',
    status: '最新',
    s3KeyPdf: 'P-0003_K001_工程1_01.pdf',
    s3KeyExcel: 'P-0003_K001_工程1_01.xlsx',
  },
];

export function findMockDocument(documentNo: string): DocumentRecord | undefined {
  return mockDocuments.find((doc) => doc.documentNo === documentNo);
}

/**
 * 週2で `POST /documents` / `POST /documents/{docNo}/revisions` に差し替える。
 *
 * **同じキー（製品コード＋SK）のレコードがあれば置き換える。**
 * DynamoDB は同じ PK/SK への書き込みが上書きになるので、モックもその挙動に揃える。
 * 揃えないと、論理削除したものを発行し直したときに同じ文書番号の行が2つでき、
 * 検索が先に見つけた「削除済み」を返してアップロードできなくなる。
 */
export function addMockDocument(record: DocumentRecord): void {
  const index = mockDocuments.findIndex(
    (doc) => doc.productCode === record.productCode && doc.sortKey === record.sortKey,
  );
  if (index === -1) {
    mockDocuments.push(record);
    return;
  }
  mockDocuments[index] = record;
}
