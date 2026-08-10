/**
 * `PATCH /masters/{id}` の `id` の組み立て・分解。
 *
 * マスタのキーは PK=項目種別（category）/ SK=コード（code）の複合キーだが
 * （docs/DynamoDBテーブル設計.md）、パスは1セグメントしか持てない。
 * `${category}#${code}` を結合してこれを `id` とする。
 *
 * `#` を区切りに使えるのは、コード・名称の禁止文字だから（CLAUDE.md §3・shared/masters.ts）。
 * 名称やコードに `#` が混ざる余地が無いので、結合しても分解時に取り違えない。
 *
 * backend（パスから category/code を復元する）と frontend（S-6 がリンクを組み立てる）の
 * 両方が使うため shared に置く（documentNo.ts と同じ理由）。
 */

import type { MasterCategory } from './types';

const CATEGORIES: readonly MasterCategory[] = ['文書種類', '製品コード', '工程番号', '担当者'];

/** `PATCH /masters/{id}` の URL に載せる `id`。呼び出し側で `encodeURIComponent` すること */
export function buildMasterId(category: MasterCategory, code: string): string {
  return `${category}#${code}`;
}

/**
 * `id` を category と code に分解する。
 *
 * **`#` の最初の出現で区切る。** category は固定4値のどれかで `#` を含まないため、
 * 最初の区切りが必ず category と code の境界になる。code 側に `#` が混ざる心配はない
 * （登録時に弾いているため）が、万一 API を直接叩かれても取り違えない書き方にしてある。
 */
export function parseMasterId(id: string): { category: MasterCategory; code: string } | null {
  const separatorIndex = id.indexOf('#');
  if (separatorIndex === -1) return null;

  const category = id.slice(0, separatorIndex);
  const code = id.slice(separatorIndex + 1);

  if (!isMasterCategory(category) || code === '') return null;
  return { category, code };
}

function isMasterCategory(value: string): value is MasterCategory {
  return (CATEGORIES as readonly string[]).includes(value);
}
