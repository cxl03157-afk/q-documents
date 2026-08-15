/**
 * 合言葉の照合（F-18 / F-20）。
 *
 * `unlock.ts`（解除）と `changePassphrase.ts`（変更時の現行合言葉の確認）の
 * 両方が必要とするため、ここに1つだけ置く。片側で書き直すと、比較の仕方が
 * ずれても**どちらも「一致した／しない」を返すので気づけない**。
 */

import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * 双方を SHA-256 にしてから比較する。
 *
 * `timingSafeEqual` は長さの違う入力で例外を投げるため、そのままでは使えない。
 * ハッシュにすれば常に32バイトになり、**長さから合言葉の桁数が漏れることもなくなる**。
 */
export function passphraseMatches(input: string, expected: string): boolean {
  const a = createHash('sha256').update(input, 'utf8').digest();
  const b = createHash('sha256').update(expected, 'utf8').digest();
  return timingSafeEqual(a, b);
}
