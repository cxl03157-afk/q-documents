/**
 * S-1 のプルダウン・絞り込みで使うハードコードマスタ（週2で `GET /masters` に差し替える）。
 * 元勤務先が特定できる情報は入れない（CLAUDE.md §8-10）。製品コード・工程名は例示用の仮名。
 */

import type { MasterRecord } from '../../../shared/types';

export const mockMasters: MasterRecord[] = [
  { category: '文書種類', code: 'Q001', name: 'PFMEA', status: '有効', registeredAt: '2026-01-10', numberingRule: '製品単位' },
  { category: '文書種類', code: 'Q005', name: 'QC工程表', status: '有効', registeredAt: '2026-01-10', numberingRule: '製品単位' },
  { category: '文書種類', code: 'Q010', name: '作業指示書', status: '有効', registeredAt: '2026-01-10', numberingRule: '工程単位' },

  { category: '製品コード', code: 'P-0001', name: '製品A', status: '有効', registeredAt: '2026-01-10' },
  { category: '製品コード', code: 'P-0002', name: '製品B', status: '有効', registeredAt: '2026-01-10' },
  { category: '製品コード', code: 'P-0003', name: '製品C', status: '有効', registeredAt: '2026-01-10' },

  { category: '工程番号', code: 'K001', name: '工程1', status: '有効', registeredAt: '2026-01-10' },
  { category: '工程番号', code: 'K002', name: '工程2', status: '有効', registeredAt: '2026-01-10' },

  { category: '担当者', code: 'E001', name: '山田太郎', status: '有効', registeredAt: '2026-01-10' },
  { category: '担当者', code: 'E002', name: '佐藤花子', status: '有効', registeredAt: '2026-01-10' },
];
