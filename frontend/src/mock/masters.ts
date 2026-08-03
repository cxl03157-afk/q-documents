/**
 * S-1 のプルダウン・絞り込みで使うハードコードマスタ（週2で `GET /masters` に差し替える）。
 * 元勤務先が特定できる情報は入れない（CLAUDE.md §8-10）。製品コード・工程名は例示用の仮名。
 */

import type { MasterCategory, MasterRecord } from '../../../shared/types';

export const mockMasters: MasterRecord[] = [
  { category: '文書種類', code: 'Q001', name: 'PFMEA', status: '有効', registeredAt: '2026-01-10', numberingRule: '製品単位' },
  { category: '文書種類', code: 'Q005', name: 'QC工程表', status: '有効', registeredAt: '2026-01-10', numberingRule: '製品単位' },
  { category: '文書種類', code: 'Q010', name: '作業指示書', status: '有効', registeredAt: '2026-01-10', numberingRule: '工程単位' },

  { category: '製品コード', code: 'P-0001', name: '製品A', status: '有効', registeredAt: '2026-01-10' },
  { category: '製品コード', code: 'P-0002', name: '製品B', status: '有効', registeredAt: '2026-01-10' },
  { category: '製品コード', code: 'P-0003', name: '製品C', status: '有効', registeredAt: '2026-01-10' },
  // 文書が1件もない製品。新規発行を最後まで通して確認するために置いている
  { category: '製品コード', code: 'P-0004', name: '製品D', status: '有効', registeredAt: '2026-01-10' },
  // 製品によらない共通作業。作業指示書だけが紐づく（PFMEA・QC工程表は存在しない）
  { category: '製品コード', code: 'COM001', name: '共通作業', status: '有効', registeredAt: '2026-01-10', isCommon: true },

  { category: '工程番号', code: 'K001', name: '工程1', status: '有効', registeredAt: '2026-01-10' },
  { category: '工程番号', code: 'K002', name: '工程2', status: '有効', registeredAt: '2026-01-10' },

  { category: '担当者', code: 'E001', name: '山田太郎', status: '有効', registeredAt: '2026-01-10' },
  { category: '担当者', code: 'E002', name: '佐藤花子', status: '有効', registeredAt: '2026-01-10' },
];

/**
 * 登録用の選択肢。無効化されたマスタは新しい文書に選ばせない。
 * （S-1 の検索側で無効を除外してよいかは 8/3 のモックレビューで判断する。
 *   過去の文書が無効化されたマスタを参照しているため、検索では出したい可能性がある）
 */
export function activeMasters(category: MasterCategory): MasterRecord[] {
  return mockMasters.filter((m) => m.category === category && m.status === '有効');
}

export function findMaster(category: MasterCategory, code: string): MasterRecord | undefined {
  return mockMasters.find((m) => m.category === category && m.code === code);
}

/**
 * 共通コード（製品によらない作業）か。
 * 共通コードには工程単位の文書（作業指示書）しか存在しない。
 */
export function isCommonProductCode(productCode: string): boolean {
  return findMaster('製品コード', productCode)?.isCommon === true;
}

/** その製品コードで発行できる文書種類。共通コードでは工程単位のものだけ */
export function selectableDocumentTypes(productCode: string): MasterRecord[] {
  const types = activeMasters('文書種類');
  if (!isCommonProductCode(productCode)) return types;
  return types.filter((t) => t.numberingRule === '工程単位');
}
