/**
 * 状態遷移の「判断」だけを集めた純粋関数。AWS を呼ばない。
 *
 * CLAUDE.md §12 が挙げるテスト対象2つのうちの片方（「状態遷移の判定 —
 * 両ファイルが揃ったか、前リビジョンをどう扱うか」）がここに当たる。
 *
 * **判断と書き込みを分けているのは、書き込み側が試験しにくいため。**
 * 条件付き書き込みの正しさは本番の実測でしか確かめられないが、
 * 「両方揃ったか」「どのリビジョンが対象か」はここで機械的に確認できる。
 */

import type { DocumentRecord } from '../../../shared/types';

/**
 * S3キーの状況から、目指すべき状態を決める（Issue #19 段2の表）。
 *
 *   両方のキーが存在 → '最新'
 *   片方だけ         → '一部登録'
 *   どちらも無い     → null（段1の直後にこれは起きないが、判断としては「何もしない」）
 *
 * **現在の状態は見ない。** 「そこへ進んでよいか」は条件式が決めることで、
 * ここが決めるのは「揃い方から言えばどこにいるべきか」だけ。
 * 両方で判断すると、規律が2か所に分かれて食い違う余地ができる。
 */
export function nextStatus(record: DocumentRecord): '最新' | '一部登録' | null {
  const pdf = record.s3KeyPdf !== undefined;
  const excel = record.s3KeyExcel !== undefined;

  if (pdf && excel) return '最新';
  if (pdf || excel) return '一部登録';
  return null;
}

/**
 * 今回より前のリビジョン。
 *
 * **比較は文字列のまま行う。** リビジョンは2桁ゼロ埋め固定なので、
 * `'01' < '02'` がそのまま大小になる。`Number()` を挟むと、値が壊れていたときに
 * `NaN` との比較が常に false になり、**前リビジョンが黙って旧版化されない**
 * という気づきにくい壊れ方をする。前提と同じ形で書くほうが素直。
 *
 * 自分自身は `<` で自然に外れる。後続のリビジョンも対象にしない
 * — 新しい版が先に「最新」になっている場合、それを旧版に落とすのは
 * CLAUDE.md §5 の「逆方向の遷移はない」に反する。
 */
function previousRevisions(
  records: DocumentRecord[],
  currentRevision: string,
): DocumentRecord[] {
  return records.filter((record) => record.revision < currentRevision);
}

/**
 * 旧版へ落とす対象（段3-B）。今回より前で、まだ「最新」のもの。
 *
 * 通常は0件か1件だが、複数あっても全部拾う。片方だけ登録して放置された
 * リビジョンが混ざるなど、1件とは限らない履歴になりうるため。
 */
export function revisionsToArchive(
  records: DocumentRecord[],
  currentRevision: string,
): DocumentRecord[] {
  return previousRevisions(records, currentRevision).filter(
    (record) => record.status === '最新',
  );
}

/**
 * すでに旧版になっている前リビジョン（段3-D の対象に足すもの）。
 *
 * **自分が落としたものだけを Glacier へ送ると、取りこぼす。**
 * 段3-B の書き込みは先勝ちなので、別の実行が先に落としていると条件不成立になる。
 * その実行が Glacier まで進めていれば良いが、途中で落ちていれば誰も送らない。
 * ここで拾っておけば、**次のイベントで必ず回収される**（重複コピーは
 * ストレージクラスの確認が防ぐ）。
 *
 * 「ファイル未登録」「一部登録」のまま取り残された前リビジョンは対象にしない。
 * 一度も「最新」になっていないものを旧版として扱う根拠がないため。
 */
export function revisionsAlreadyArchived(
  records: DocumentRecord[],
  currentRevision: string,
): DocumentRecord[] {
  return previousRevisions(records, currentRevision).filter(
    (record) => record.status === '旧版',
  );
}

/**
 * ストレージクラスを変える必要があるか。
 *
 * **`HeadObject` は Standard のとき `StorageClass` を返さない。**
 * 未指定を「クラス不明」ではなく Standard と読み替えるのがここの役目で、
 * これを忘れると Standard のオブジェクトが「一致しない」と判定され続けて
 * 毎回コピーが走る（＝Glacier IR の early deletion 料金が積み上がる）。
 */
export function needsStorageClassChange(
  current: string | undefined,
  target: string,
): boolean {
  return (current ?? 'STANDARD') !== target;
}
