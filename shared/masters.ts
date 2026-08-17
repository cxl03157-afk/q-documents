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
 *
 * ---
 *
 * **同じ氏名が2件あり得るので、有効なほうを優先して返す。**
 *
 * 担当者マスタのキーは `category` + `code` なので、同姓同名や登録し直しで
 * 同じ `name` が複数並ぶことがある。S-6 は誤登録の直し方として
 * 「無効化して正しい内容で追加し直す」を案内しており（コード欄が編集不可のため）、
 * 担当者でそれを行うと**無効1件＋有効1件**が必ずできる。
 *
 * 単に先頭を返すと、走査順で無効のほうが先に当たった人は
 * **プルダウンには出るのに解除できず（401）、発行もできない（400）**という状態になる。
 * 画面から直す手段が無い（無効なほうを消す操作を用意していない）ので、ここで優先する。
 *
 * **氏名の一意性そのものは縛らない。** 同姓同名は実在し得るし、
 * 記録に残るのが氏名である以上（CLAUDE.md §8-7）、登録できないほうが困る。
 * ただし**同名が2人とも有効な場合は、ログの氏名からどちらか判別できない**。
 * 現在の担当者数では起きないため見送っている（docs/context.md の未解決
 * 「同名の担当者を氏名だけで識別している」）。
 */
export function findOwnerByName(
  masters: MasterRecord[],
  userName: string,
): MasterRecord | undefined {
  const owners = masters.filter((m) => m.category === '担当者' && m.name === userName);
  return owners.find((m) => m.status === '有効') ?? owners[0];
}

/**
 * 担当者を「登録に使ってよい」ものだけに縛るときの文言（`POST /documents` などが使う）。
 *
 * 未登録と無効化を書き分けるのは `findOwnerByName` の説明のとおり。
 * 直し方が正反対（マスタに追加する／別の人を選ぶ）なので同じ文言にしない。
 */
export function activeOwnerRejection(masters: MasterRecord[], owner: string): string | null {
  const master = findOwnerByName(masters, owner);
  if (master === undefined) return '担当者がマスタに登録されていません';
  if (master.status !== '有効') {
    return 'この担当者は無効化されています。有効な担当者を選んでください';
  }
  return null;
}

/**
 * `PATCH /documents/{docNo}`（S-7）で担当者を受け付けてよいか。断る理由、無ければ null。
 *
 * **新規発行・リビジョンアップとは規律が違う。** あちらは常に「有効な担当者のみ」だが、
 * 修正では**変更するときだけ**有効であることを求める。
 *
 * 境界は「新規発行か改訂か」ではなく **「利用者が選ぶ値か、引き継ぐ値か」**
 * （docs/context.md 8/9 の決定）。S-7 で担当者を変えないなら、その氏名は
 * 画面が選ばせた値ではなく既存レコードから引き継いだ値なので、
 * 新規発行と同じ規律を当てる理由がない。
 *
 * 当ててしまうと、**担当者が退職して無効化されただけで、そのレコードの
 * 文書発行日を直せなくなる**（直すには事実と違う担当者へ付け替えるしかない）。
 * 無効化は新規発行を止める操作であって、過去の記録を書き換えさせる操作ではない
 * （docs/context.md 8/6 の決定）。
 *
 * 逆に別の担当者へ**変える**なら、それは画面のプルダウンで選んだ値なので
 * 新規発行と同じく有効なものだけに縛る。
 */
export function ownerChangeRejection(
  masters: MasterRecord[],
  currentOwner: string,
  nextOwner: string,
): string | null {
  // 据え置きなら引き継ぐ値。マスタを引き直さない（無効化されていても通す）
  if (nextOwner === currentOwner) return null;

  return activeOwnerRejection(masters, nextOwner);
}

/**
 * 「工程単位の文書種類は1つまで」を破っていないか（`POST /masters`・`PATCH /masters/{id}`）。
 *
 * 工程単位の文書番号（`製品コード_工程番号_工程名_Rev`）は文書種類コードを含まない。
 * 工程単位の文書種類が2件あると、どちらで登録しても同じ文書IDになり得るため、
 * サーバー側で1件までに縛る（工程単位が作業指示書だけなのは意図的な前提。CLAUDE.md 未解決）。
 *
 * **状態（有効/無効）を問わず数える。** 無効化しても文書番号の形は既に確定した過去の文書に
 * 残っているため、無効化した瞬間に新しい工程単位の文書種類を作れてよいわけではない
 * （無効なマスタは新規発行に使えないだけで、番号の唯一性の話とは別軸）。
 *
 * `excludeCode` は PATCH で自分自身を除くために使う。新規追加（POST）では渡さない。
 */
export function hasAnotherProcessScopedDocumentType(
  masters: MasterRecord[],
  excludeCode?: string,
): boolean {
  return masters.some(
    (m) =>
      m.category === '文書種類' &&
      m.numberingRule === '工程単位' &&
      m.code !== excludeCode,
  );
}
