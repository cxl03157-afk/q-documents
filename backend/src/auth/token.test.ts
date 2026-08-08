import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { issueToken, verifyToken } from './token';

/** テスト内で「正しい署名が付いた不正なペイロード」を作るための補助 */
function signWith(secret: string, payloadPart: string): string {
  return createHmac('sha256', secret).update(payloadPart, 'utf8').digest('base64url');
}

const SECRET = 'test-signing-key-not-a-real-secret';
const TTL = 7200;

/** 2026-08-07T12:00:00Z */
const NOW = Date.UTC(2026, 7, 7, 12, 0, 0);

describe('issueToken', () => {
  it('発行したトークンを同じ鍵で検証できる', () => {
    const { token } = issueToken(SECRET, '山田太郎', TTL, NOW);
    const result = verifyToken(SECRET, token, NOW);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.payload.n).toBe('山田太郎');
  });

  it('expiresAt は発行時刻 + 有効期間になる', () => {
    const { expiresAt } = issueToken(SECRET, '山田太郎', TTL, NOW);
    expect(expiresAt).toBe('2026-08-07T14:00:00.000Z');
  });

  it('氏名に非ASCII・記号が含まれても往復できる', () => {
    const name = '佐藤 花子（生産技術）';
    const { token } = issueToken(SECRET, name, TTL, NOW);
    const result = verifyToken(SECRET, token, NOW);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.payload.n).toBe(name);
  });

  it('トークンに区切り文字のドットは1つだけ現れる（base64url は . を含まない）', () => {
    const { token } = issueToken(SECRET, '山田太郎', TTL, NOW);
    expect(token.split('.')).toHaveLength(2);
  });
});

describe('verifyToken', () => {
  it('鍵が違うトークンは署名エラーで拒否する', () => {
    const { token } = issueToken(SECRET, '山田太郎', TTL, NOW);
    const result = verifyToken('another-key', token, NOW);

    expect(result).toEqual({ ok: false, reason: 'signature' });
  });

  it('ペイロードを書き換えたトークンを拒否する', () => {
    const { token } = issueToken(SECRET, '山田太郎', TTL, NOW);
    const [, signature] = token.split('.');

    // 氏名を別人に差し替える。署名は元のまま
    const forgedPayload = Buffer.from(
      JSON.stringify({ n: '佐藤花子', iat: NOW / 1000, exp: NOW / 1000 + TTL }),
      'utf8'
    ).toString('base64url');

    const result = verifyToken(SECRET, `${forgedPayload}.${signature}`, NOW);
    expect(result).toEqual({ ok: false, reason: 'signature' });
  });

  it('期限を伸ばした偽造トークンを拒否する（署名を先に見るため）', () => {
    const farFuture = Math.floor(NOW / 1000) + 60 * 60 * 24 * 365;
    const forgedPayload = Buffer.from(
      JSON.stringify({ n: '山田太郎', iat: Math.floor(NOW / 1000), exp: farFuture }),
      'utf8'
    ).toString('base64url');

    const result = verifyToken(SECRET, `${forgedPayload}.signature-does-not-matter`, NOW);
    expect(result).toEqual({ ok: false, reason: 'signature' });
  });

  it('期限が切れたトークンを拒否する', () => {
    const { token } = issueToken(SECRET, '山田太郎', TTL, NOW);
    const result = verifyToken(SECRET, token, NOW + (TTL + 1) * 1000);

    expect(result).toEqual({ ok: false, reason: 'expired' });
  });

  it('期限ちょうどの時刻は切れたものとして扱う', () => {
    const { token } = issueToken(SECRET, '山田太郎', TTL, NOW);
    const result = verifyToken(SECRET, token, NOW + TTL * 1000);

    expect(result).toEqual({ ok: false, reason: 'expired' });
  });

  it('期限の1秒前はまだ有効', () => {
    const { token } = issueToken(SECRET, '山田太郎', TTL, NOW);
    const result = verifyToken(SECRET, token, NOW + (TTL - 1) * 1000);

    expect(result.ok).toBe(true);
  });

  it.each([
    ['空文字', ''],
    ['区切りが無い', 'abcdef'],
    ['区切りが2つ', 'a.b.c'],
    ['ペイロードが空', '.signature'],
    ['署名が空', 'payload.'],
  ])('壊れた形式を拒否する: %s', (_label, token) => {
    const result = verifyToken(SECRET, token, NOW);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('malformed');
  });

  it('署名は正しいが中身が JSON でないトークンを拒否する', () => {
    // 鍵が漏れた場合でも、想定外のペイロードのまま先へ進まないことを確かめる
    const payloadPart = Buffer.from('not json', 'utf8').toString('base64url');

    const result = verifyToken(SECRET, `${payloadPart}.${signWith(SECRET, payloadPart)}`, NOW);
    expect(result).toEqual({ ok: false, reason: 'malformed' });
  });

  it.each([
    ['exp が小数', { n: '山田太郎', iat: 1754_654_400, exp: 1754_661_600.5 }],
    ['exp が文字列', { n: '山田太郎', iat: 1754_654_400, exp: '1754661600' }],
    ['iat が NaN', { n: '山田太郎', iat: Number.NaN, exp: 1754_661_600 }],
    ['氏名が空', { n: '', iat: 1754_654_400, exp: 1754_661_600 }],
  ])('署名が正しくても epoch 秒として不正なペイロードを拒否する: %s', (_label, payload) => {
    // 鍵が漏れた場合や、自前で作ったトークンに想定外の値が混ざった場合を想定する。
    // iat / exp は epoch 秒なので整数以外は受け付けない
    const payloadPart = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');

    const result = verifyToken(SECRET, `${payloadPart}.${signWith(SECRET, payloadPart)}`, NOW);
    expect(result).toEqual({ ok: false, reason: 'malformed' });
  });

  it('必須項目が欠けたペイロードを拒否する', () => {
    // 正しい鍵で署名した「氏名が無い」ペイロード。署名は通るが中身で弾く
    const payloadPart = Buffer.from(
      JSON.stringify({ iat: Math.floor(NOW / 1000), exp: Math.floor(NOW / 1000) + TTL }),
      'utf8'
    ).toString('base64url');

    const result = verifyToken(SECRET, `${payloadPart}.${signWith(SECRET, payloadPart)}`, NOW);
    expect(result).toEqual({ ok: false, reason: 'malformed' });
  });
});
