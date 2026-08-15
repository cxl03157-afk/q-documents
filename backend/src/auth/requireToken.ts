/**
 * 受け取ったリクエストから身元を確かめる（F-18）。
 *
 * `token.ts` が「トークンが本物か」を判定する純粋関数で、こちらは
 * 「ヘッダーから取り出して署名鍵を用意する」という外界とのつなぎ目を担当する。
 * 分けているのは、判定のほうをテストしやすい形に保つため。
 *
 * **このファイルは「通す／通さない」を決めない。** 決めるのは index.ts で、
 * ルート表の `auth` に従って判断する。ここは事実（ヘッダーが無い／不正／有効）を
 * 返すところまでにとどめる。同じ「不正」でも、required なら 401、
 * conditional なら…と扱いが変わるので、判断を1か所に集めたい。
 */

import { headerValue } from '../http';
import { getUnlockSecrets, noteRefreshDidNotHelp, refreshUnlockSecrets } from './secrets';
import { verifyToken } from './token';

/**
 * 解除中の利用者。
 *
 * 氏名しか持たない。合言葉は役割単位で共有する1つの値であり、個人を認証しない
 * （docs/API.md）。ここでの氏名は自己申告を担当者マスタと突き合わせたもので、
 * 本人性の証明ではなく、記録に実在の担当者名だけが入ることの担保にとどまる。
 */
export type Identity = { userName: string };

export type AuthOutcome =
  /** `Authorization` ヘッダーが無い。合言葉なしの利用者 */
  | { state: 'absent' }
  /** 署名・期限とも正しい */
  | { state: 'valid'; identity: Identity }
  /** ヘッダーはあるが通らない。偽造・期限切れ・形式不正 */
  | { state: 'invalid'; reason: 'malformed' | 'signature' | 'expired' };

/**
 * `Authorization: Bearer <token>` からトークン部分を取り出す。
 * スキーム名は RFC 6750 上 大文字小文字を区別しない。
 */
function bearerToken(headerLine: string): string | null {
  const match = headerLine.match(/^\s*Bearer\s+(\S+)\s*$/i);
  return match === null ? null : match[1]!;
}

export async function authenticate(
  headers: Record<string, string | undefined> | null | undefined,
): Promise<AuthOutcome> {
  const line = headerValue(headers, 'authorization');
  if (line === '') return { state: 'absent' };

  const token = bearerToken(line);
  if (token === null) return { state: 'invalid', reason: 'malformed' };

  const { signingKey } = await getUnlockSecrets();
  let result = verifyToken(signingKey, token);

  /**
   * 署名が合わないときだけ、鍵を読み直して一度だけやり直す（F-20）。
   *
   * 合言葉を変更すると署名鍵も回るが、**書き込めるのは実行した1つのコンテナだけ**で、
   * 他のコンテナは最大5分（auth/secrets.ts の CACHE_TTL_MS）古い鍵を持つ。
   * 変更した本人には新しい鍵で署名したトークンを渡しているので、読み直さないと
   * **「変更した本人の解除を維持する」という F-20 の設計が5分間成立しない**。
   *
   * `malformed` と `expired` では読み直さない。どちらも鍵とは無関係な理由で、
   * 読み直しても結果は変わらないため（`expired` は署名を確認したあとの判定）。
   *
   * 読み直しには上限がある（auth/secrets.ts）。**空振りした回数だけを数える方式**なので、
   * 打ち間違いが数回あった程度では本物のローテーションを取りこぼさない。
   * 短時間に何度も空振りした直後だけは古い鍵のまま 401 になりうるが、上限を設ける以上
   * この形は消せない（消すには読み直せるまで待つことになり、同時実行の枠を塞ぐ）。
   */
  if (!result.ok && result.reason === 'signature') {
    const latest = await refreshUnlockSecrets();
    if (latest.signingKey !== signingKey) {
      result = verifyToken(latest.signingKey, token);
    } else {
      // 読み直しても鍵は同じ＝この署名不一致は偽造か期限切れの鍵。本数を1つ使う
      noteRefreshDidNotHelp();
    }
  }

  if (!result.ok) return { state: 'invalid', reason: result.reason };

  return { state: 'valid', identity: { userName: result.payload.n } };
}
