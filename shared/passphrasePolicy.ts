/**
 * 新しい合言葉が満たすべき要件（F-20）。
 *
 * **backend と frontend の両方が同じ判定を必要とする**（shared/masters.ts と同じ理由）。
 *   backend  — ここが正。画面の制御は開発者ツールから回避できる（CLAUDE.md §7）
 *   frontend — 送信前に誤りを知らせるため
 *
 * ---
 *
 * **この要件は「新しい合言葉」にだけ適用する。**
 * 現在の合言葉は照合するだけで、長さも文字種も見ない。要件を後から足した以上、
 * 運用中の合言葉がこれを満たしていない可能性があり、そこで弾くと変更操作そのものが
 * できなくなる（＝この機能が最も必要な状況で使えない）。
 *
 * **文字種（記号必須など）は強制しない。** 合言葉は役割単位で共有する1つの値で、
 * 複雑にするほど紙に書き出される方向へ働く。上限を20文字にしているのも同じ理由で、
 * 覚えきれない長さにしないことのほうが、この運用では強度に効く。
 */

/** 社内での共有値なので、覚えられる範囲に収める（8〜20文字） */
export const MIN_PASSPHRASE_LENGTH = 8;
export const MAX_PASSPHRASE_LENGTH = 20;

/**
 * 見た目の文字数を数える。
 *
 * `String.prototype.length` は UTF-16 の符号単位を数えるので、絵文字や一部の記号が
 * 2文字と数えられる。「20文字入れたのに21文字だと言われる」というずれになり、
 * 利用者からは原因が分からない。コードポイントで数えれば、ほぼ見た目どおりになる。
 */
function characterLength(value: string): number {
  return Array.from(value).length;
}

/**
 * 満たしていない要件の理由。満たしていれば `null`。
 *
 * 真偽値ではなく理由の文字列を返すのは、画面とサーバーで文言を揃えるため。
 * 別々に書くと「画面では通ったのにサーバーが違う理由で拒否する」が起きる。
 */
export function passphraseRejectionReason(
  newPassphrase: string,
  currentPassphrase: string,
): string | null {
  const length = characterLength(newPassphrase);

  if (length < MIN_PASSPHRASE_LENGTH || length > MAX_PASSPHRASE_LENGTH) {
    return `新しい合言葉は${MIN_PASSPHRASE_LENGTH}〜${MAX_PASSPHRASE_LENGTH}文字にしてください`;
  }

  /**
   * 前後の空白を弾く。
   *
   * 見えない文字が端に付いたまま登録されると、次に誰かが入力するときに再現できず、
   * **誰も解除できなくなる**。中の空白は本人が意図して入れられるので許可する。
   *
   * `\s` は**全角スペース（U+3000）も含む**ので、これ1つで足りる
   * （日本語入力のまま打つと混入しやすく、実際に一番起きやすいのはこれ）。
   */
  if (/^\s|\s$/.test(newPassphrase)) {
    return '新しい合言葉の前後に空白を入れないでください';
  }

  // 変えたつもりで変わっていない状態を防ぐ
  if (newPassphrase === currentPassphrase) {
    return '新しい合言葉が現在の合言葉と同じです';
  }

  return null;
}
