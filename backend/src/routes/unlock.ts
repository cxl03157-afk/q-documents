/**
 * POST /auth/unlock — 生産技術モードの解除（F-18 / docs/API.md）。
 *
 * 氏名と合言葉を受け取り、両方を検証してから短期トークンを返す。
 * **検証はここが正。** 画面側にも同じ検証があるが、あれは誤りを早く知らせるためのもので、
 * 開発者ツールから直接呼ばれれば回避できる（CLAUDE.md §7 の検証の二重化）。
 */

import { createHash, timingSafeEqual } from 'node:crypto';
import type { APIGatewayProxyResult } from 'aws-lambda';
import { issueToken } from '../auth/token';
import { config } from '../config';
import { errorResponse, jsonResponse } from '../http';
import { isActiveOwner } from '../masters';
import { getSecureParameter } from '../ssm';

/**
 * どちらが誤りかを示さない（docs/screens.md S-2）。
 * 氏名だけ当たっていると分かると、合言葉の総当たりの足がかりになる。
 */
const UNLOCK_ERROR = '氏名または合言葉が違います';

/** 入力の上限。極端に長い文字列でハッシュ計算やログを膨らませない */
const MAX_FIELD_LENGTH = 200;

type UnlockRequest = { userName: string; passphrase: string };

function parseRequest(body: string | null): UnlockRequest | null {
  if (body === null) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }

  if (typeof parsed !== 'object' || parsed === null) return null;
  const v = parsed as Record<string, unknown>;

  if (typeof v.userName !== 'string' || typeof v.passphrase !== 'string') return null;
  if (v.userName.length > MAX_FIELD_LENGTH || v.passphrase.length > MAX_FIELD_LENGTH) {
    return null;
  }

  return { userName: v.userName, passphrase: v.passphrase };
}

/**
 * 合言葉の照合。
 *
 * 双方を SHA-256 にしてから比較するのは、`timingSafeEqual` が長さの違う入力で
 * 例外を投げるため。ハッシュにすれば常に32バイトで、長さから合言葉の桁数が
 * 漏れることもなくなる。
 */
function passphraseMatches(input: string, expected: string): boolean {
  const a = createHash('sha256').update(input, 'utf8').digest();
  const b = createHash('sha256').update(expected, 'utf8').digest();
  return timingSafeEqual(a, b);
}

export async function postUnlock(
  origin: string,
  body: string | null
): Promise<APIGatewayProxyResult> {
  const request = parseRequest(body);
  if (request === null) {
    return errorResponse(origin, 400, 'リクエストの形式が正しくありません');
  }

  const [passphrase, signingKey] = await Promise.all([
    getSecureParameter(config.passphraseParam),
    getSecureParameter(config.tokenSecretParam),
  ]);

  /**
   * **2つの判定をどちらも評価してから結果を出す。**
   *
   * 氏名が存在しない時点で早く返すと、応答時間の差から
   * 「この氏名は実在する／しない」が読み取れてしまう。
   * 同じ 401・同じ本文を返しても、速さで区別が付いては意味がない。
   * どちらかが false でも打ち切らず、最後の1回だけで判定する。
   */
  const passphraseOk = passphraseMatches(request.passphrase, passphrase);
  const ownerExists = await isActiveOwner(request.userName);

  if (!ownerExists || !passphraseOk) {
    // 失敗の記録には合言葉を書かない。氏名も、実在しない場合は攻撃者の入力そのものなので
    // ログに残す価値より、そのまま出すことの副作用（ログ汚染）のほうが大きい
    console.log(
      JSON.stringify({
        message: 'unlock rejected',
        ownerExists,
        passphraseOk,
      })
    );
    return errorResponse(origin, 401, UNLOCK_ERROR);
  }

  const { token, expiresAt } = issueToken(
    signingKey,
    request.userName,
    config.tokenTtlSeconds
  );

  console.log(
    JSON.stringify({
      message: 'unlock granted',
      userName: request.userName,
      expiresAt,
    })
  );

  return jsonResponse(origin, 200, { token, expiresAt });
}
