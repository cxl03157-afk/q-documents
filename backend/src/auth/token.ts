/**
 * 合言葉トークンの発行と検証（F-18）。
 *
 * 形式は自前の2部構成。
 *
 *   base64url(JSON のペイロード) . base64url(HMAC-SHA256(署名鍵, 第1部))
 *
 * **JWT は採らない。** JWT はヘッダ部に署名アルゴリズム名を持つため、`alg: none` や
 * HMAC/RSA の取り違えへの対処が要る。ここで使う方式は1つしかないので、
 * アルゴリズムを可変にしない形のほうが短く、事故りにくい。標準ライブラリだけで書けて
 * 依存も増えない。
 *
 * このファイルは SSM も DynamoDB も環境変数も見ない。署名鍵と現在時刻を引数で受け取る
 * 純粋関数に近い形にしてある（テストを書く対象・CLAUDE.md「テストを書く範囲」）。
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

export type TokenPayload = {
  /**
   * 氏名。担当者マスタと照合済みの値が入る。
   * ログに残る唯一の識別子になる（CLAUDE.md §8-7）。
   */
  n: string;

  /** 発行時刻（epoch 秒） */
  iat: number;

  /** 期限（epoch 秒） */
  exp: number;
};

export type VerifyResult =
  | { ok: true; payload: TokenPayload }
  | { ok: false; reason: 'malformed' | 'signature' | 'expired' };

function encodePayload(payload: TokenPayload): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

function sign(secret: string, payloadPart: string): string {
  return createHmac('sha256', secret).update(payloadPart, 'utf8').digest('base64url');
}

/**
 * 長さが違えば即 false、同じなら定数時間で比較する。
 *
 * `timingSafeEqual` は長さが違うと例外を投げるので、先に長さを見る必要がある。
 * 期待値（HMAC-SHA256 の base64url）は常に固定長なので、長さの違いから漏れるのは
 * 「桁数が違う」ことだけで、鍵の手がかりにはならない。
 */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * ペイロードの検証。
 *
 * `iat` / `exp` は epoch 秒なので整数以外は受け付けない。
 * `Number.isInteger` は型変換をせず（`'5'` は false）、NaN と Infinity も false になるので、
 * これ1つで「数値であること・有限であること・整数であること」を満たせる。
 */
function isTokenPayload(value: unknown): value is TokenPayload {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.n === 'string' && v.n !== '' && Number.isInteger(v.iat) && Number.isInteger(v.exp)
  );
}

export function issueToken(
  secret: string,
  userName: string,
  ttlSeconds: number,
  nowMs: number = Date.now()
): { token: string; expiresAt: string } {
  const iat = Math.floor(nowMs / 1000);
  const exp = iat + ttlSeconds;

  const payloadPart = encodePayload({ n: userName, iat, exp });

  return {
    token: `${payloadPart}.${sign(secret, payloadPart)}`,
    expiresAt: new Date(exp * 1000).toISOString(),
  };
}

/**
 * トークンを検証する。
 *
 * **署名を確かめる前にペイロードの中身を信用しない。** 順序を逆にすると、
 * 誰でも書き換えられる JSON を先に読むことになり、`exp` を伸ばした偽造トークンを
 * 期限内として扱ってしまう。
 */
export function verifyToken(
  secret: string,
  token: string,
  nowMs: number = Date.now()
): VerifyResult {
  const parts = token.split('.');
  if (parts.length !== 2) return { ok: false, reason: 'malformed' };

  const [payloadPart, signaturePart] = parts;
  if (payloadPart === '' || signaturePart === '') {
    return { ok: false, reason: 'malformed' };
  }

  if (!safeEqual(sign(secret, payloadPart), signaturePart)) {
    return { ok: false, reason: 'signature' };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(payloadPart, 'base64url').toString('utf8'));
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (!isTokenPayload(parsed)) return { ok: false, reason: 'malformed' };

  if (parsed.exp <= Math.floor(nowMs / 1000)) {
    return { ok: false, reason: 'expired' };
  }

  return { ok: true, payload: parsed };
}
