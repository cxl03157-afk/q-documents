/**
 * 選択肢マスタに対する判定（CLAUDE.md §7 の「型の単一の正」と同じ理由でここに置く）。
 *
 * **backend と frontend の両方が同じ判定を必要とする。**
 *   backend  — 採番時の検証。ここが正（画面の制御は開発者ツールから回避できる）
 *   frontend — 選択肢の組み立てと、誤りを早く知らせるための事前検証
 *
 * 片側で書き直すと「画面では選べないのにサーバーが通す」あるいはその逆が起きる。
 *
 * どの関数もマスタの配列を引数で受け取る純粋関数にしてある。
 * 取得元（DynamoDB の Scan / `GET /masters` の応答）を知らせないことで、
 * 両側から同じものを呼べるようにしている。
 */

import type { MasterCategory, MasterRecord } from './types';

/**
 * 登録用の選択肢。無効化されたマスタは新しい文書に選ばせない。
 *
 * 検索（S-1）では無効も出す。無効化は新規発行の停止であって過去の記録を隠すことではなく、
 * 検索から外すと廃番になった瞬間にその製品の文書へ到達できなくなるため
 * （docs/context.md 8/6 の決定・docs/screens.md S-6）。
 */
export function activeMasters(
  masters: MasterRecord[],
  category: MasterCategory,
): MasterRecord[] {
  return masters.filter((m) => m.category === category && m.status === '有効');
}

/** 状態を問わず引く。過去の文書が参照している無効なマスタを表示するときに使う */
export function findMaster(
  masters: MasterRecord[],
  category: MasterCategory,
  code: string,
): MasterRecord | undefined {
  return masters.find((m) => m.category === category && m.code === code);
}

/**
 * 有効なものだけを引く。
 *
 * サーバー側の検証はこちらを使う。`findMaster` で引いてから状態を見る書き方だと、
 * 状態の確認を忘れても動いてしまい、無効化した製品コードで新しい文書番号が
 * 発行できる状態になる。「登録に使ってよいか」を1つの関数で答えさせる。
 */
export function findActiveMaster(
  masters: MasterRecord[],
  category: MasterCategory,
  code: string,
): MasterRecord | undefined {
  const found = findMaster(masters, category, code);
  return found?.status === '有効' ? found : undefined;
}

/**
 * 共通コード（製品によらない作業）か。
 * 共通コードには工程単位の文書（作業指示書）しか存在しない。
 *
 * 判定は `isCommon` で行い、コードの形式（`P-` で始まる等）では判定しない。
 * 命名規則で判定すると、記号の付け方を変えた瞬間に壊れる（CLAUDE.md §3）。
 */
export function isCommonProductCode(masters: MasterRecord[], productCode: string): boolean {
  return findMaster(masters, '製品コード', productCode)?.isCommon === true;
}

/** その製品コードで発行できる文書種類。共通コードでは工程単位のものだけ */
export function selectableDocumentTypes(
  masters: MasterRecord[],
  productCode: string,
): MasterRecord[] {
  const types = activeMasters(masters, '文書種類');
  if (!isCommonProductCode(masters, productCode)) return types;
  return types.filter((t) => t.numberingRule === '工程単位');
}

/**
 * その氏名が有効な担当者として存在するか。
 *
 * **氏名で引いている。** 担当者マスタの `name` が氏名で、画面（S-2・S-3・S-4）も
 * 氏名を値にしているため。
 *
 * 照合する理由は、氏名がログに残る唯一の識別子だから（CLAUDE.md §8-7）。
 * 自由入力を通すと「誰がエクセルを持ち出したか」の記録が意味を失う。
 * 合言葉は個人を認証しないので、これは本人性の確認ではなく
 * 「実在する担当者の名前しか記録に入らない」ことの担保にとどまる（docs/API.md）。
 *
 * **新規発行もリビジョンアップも同じ規則で有効な担当者だけを受け付ける。**
 * 無効化は新規発行を止める操作であり、リビジョンアップは新規発行にあたるため。
 * 過去のリビジョンに残っている氏名は履歴としてそのまま保持する（docs/screens.md S-4）。
 */
export function isActiveOwner(masters: MasterRecord[], userName: string): boolean {
  return findOwnerByName(masters, userName)?.status === '有効';
}

/**
 * 氏名で担当者マスタを引く（状態は問わない）。
 *
 * **「登録が無い」と「無効化されている」を呼び出し側で区別するために要る。**
 * 同じ文言で断ると、無効化された担当者を選んだ人に「マスタに登録されていません」と
 * 出ることになり、S-6 で探しても見つかって混乱する。直し方が正反対
 * （追加する／別の人を選ぶ）なので、ここは分けられるようにしておく。
 *
 * コードではなく氏名で引くのは、担当者マスタの `name` が氏名で、
 * 画面（S-2・S-3・S-4）も氏名を値にしているため。
 */
export function findOwnerByName(
  masters: MasterRecord[],
  userName: string,
): MasterRecord | undefined {
  return masters.find((m) => m.category === '担当者' && m.name === userName);
}
