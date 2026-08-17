/**
 * 合言葉の照合（F-18 / F-20）。
 *
 * `unlock.ts`（解除）と `changePassphrase.ts`（変更時の現行合言葉の確認）の
 * 両方が必要とするため、ここに1つだけ置く。片側で書き直すと、比較の仕方が
 * ずれても**どちらも「一致した／しない」を返すので気づけない**。
 */

import { createHash, timingSafeEqual } from 'node:crypto';
import { normalizePassphrase } from '../../../shared/passphrasePolicy';

/**
 * 双方を SHA-256 にしてから比較する。
 *
 * `timingSafeEqual` は長さの違う入力で例外を投げるため、そのままでは使えない。
 * ハッシュにすれば常に32バイトになり、**長さから合言葉の桁数が漏れることもなくなる**。
 *
 * **ハッシュ化の前に Unicode 正規化（NFC）する。** 濁点付きの文字は
 * 見た目が同じでもバイト列が2通りあり、ハッシュにすると当然別の値になる
 * （`shared/passphrasePolicy.ts` の `normalizePassphrase`）。
 *
 * **保存側（`changePassphrase.ts`）と対で効く。** 保存だけ正規化して照合を
 * 素のままにすると、`aws ssm put-parameter` で手動投入された NFD の値が
 * 照合できなくなる。逆に照合だけ正規化しても、保存が素のままなら
 * 「保存はできたが解除できない」が残る。両側とも通す。
 */
export function passphraseMatches(input: string, expected: string): boolean {
  const a = createHash('sha256').update(normalizePassphrase(input), 'utf8').digest();
  const b = createHash('sha256').update(normalizePassphrase(expected), 'utf8').digest();
  return timingSafeEqual(a, b);
}
