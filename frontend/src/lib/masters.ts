/**
 * マスタの判定を、この画面のストアに束ねる層。
 *
 * 判定そのものは `shared/masters.ts` にある。**backend と同じ関数を使うため**で、
 * 片側で書き直すと「画面では選べないのにサーバーが通す」あるいはその逆が起きる。
 *
 * ここが引数（マスタの配列）を埋めるだけの薄い層になっているのは、
 * 呼び出し側を短く保つため。7画面すべてが `activeMasters(allMasters(), '担当者')` と
 * 書くことになると、どのマスタを見ているかより配列を渡す作法のほうが目立つ。
 */

import {
  activeMasters as activeMastersOf,
  findActiveMaster as findActiveMasterOf,
  findMaster as findMasterOf,
  isCommonProductCode as isCommonProductCodeOf,
  selectableDocumentTypes as selectableDocumentTypesOf,
} from '../../../shared/masters';
import type { MasterCategory, MasterRecord } from '../../../shared/types';
import { allMasters } from './store';

/** 登録用の選択肢。無効化されたマスタは新しい文書に選ばせない */
export function activeMasters(category: MasterCategory): MasterRecord[] {
  return activeMastersOf(allMasters(), category);
}

/** 状態を問わず引く。過去の文書が参照している無効なマスタを表示するときに使う */
export function findMaster(category: MasterCategory, code: string): MasterRecord | undefined {
  return findMasterOf(allMasters(), category, code);
}

/** 有効なものだけを引く。「登録に使ってよいか」を1つの関数で答えさせる */
export function findActiveMaster(
  category: MasterCategory,
  code: string,
): MasterRecord | undefined {
  return findActiveMasterOf(allMasters(), category, code);
}

/** 共通コード（製品によらない作業）か。判定は isCommon で行い、コードの形式では判定しない */
export function isCommonProductCode(productCode: string): boolean {
  return isCommonProductCodeOf(allMasters(), productCode);
}

/** その製品コードで発行できる文書種類。共通コードでは工程単位のものだけ */
export function selectableDocumentTypes(productCode: string): MasterRecord[] {
  return selectableDocumentTypesOf(allMasters(), productCode);
}
