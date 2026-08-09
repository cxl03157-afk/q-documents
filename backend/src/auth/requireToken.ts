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

import { config } from '../config';
import { headerValue } from '../http';
import { getSecureParameter } from '../ssm';
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

  const signingKey = await getSecureParameter(config.tokenSecretParam);
  const result = verifyToken(signingKey, token);

  if (!result.ok) return { state: 'invalid', reason: result.reason };

  return { state: 'valid', identity: { userName: result.payload.n } };
}
