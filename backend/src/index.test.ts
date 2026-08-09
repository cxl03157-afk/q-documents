/**
 * ハンドラを丸ごと呼ぶテスト。
 *
 * **AWS を呼ばない範囲だけを対象にする。** 扱うのは
 *   - パスのデコードとルート照合
 *   - トークンが無い／形が壊れている場合の門前払い
 * の2つで、どちらも DynamoDB にも SSM にも到達しない
 * （`Authorization` が無ければ SSM から署名鍵を読む前に返る）。
 *
 * ---
 *
 * **とくにパスのデコードを覆うためにこれを書いている。**
 *
 * `table.test.ts` は `matchRoute` にデコード済みのパスを直接渡すので、
 * `event.path` をどう解くかという判断は一切通らない。ここが抜けていると、
 * 日本語を含む文書番号（作業指示書は必ず含む）でリビジョンアップが
 * 404 になる、という形で S-4 だけが壊れる。
 *
 * 実測（2026-08-10・CloudWatch Logs）で、API Gateway REST のプロキシ統合は
 * `event.path` を**デコードせずに生のまま**渡すことを確認している。
 *   受け取った値: /documents/P-0001_K002_%E5%B7%A5%E7%A8%8B2_01/revisions
 * したがってハンドラ側の `decodeURIComponent` は1回目であって二重デコードではない。
 * この前提が変わったら（API Gateway 側の仕様変更・HTTP API への移行など）
 * ここが落ちる。
 */

import type { APIGatewayProxyEvent } from 'aws-lambda';
import { describe, expect, it } from 'vitest';
import { handler } from './index';

const ORIGIN = 'https://example.invalid';

function event(
  httpMethod: string,
  path: string,
  headers: Record<string, string> = {},
): APIGatewayProxyEvent {
  return {
    httpMethod,
    path,
    headers: { Origin: ORIGIN, ...headers },
    body: '{}',
    requestContext: { identity: { sourceIp: '203.0.113.10' } },
  } as unknown as APIGatewayProxyEvent;
}

/**
 * 401 と 404 で「照合できたか」を見分ける。
 *
 * ハンドラは 照合 → 認証 の順に進むので、トークンを付けなければ
 *   401 = ルートに一致した（その先で認証に落ちた）
 *   404 = ルートに一致しなかった
 * になる。認証まで進んだかどうかが、そのまま照合の成否を示す。
 */
const MATCHED = 401;
const NOT_MATCHED = 404;

describe('パスのデコード', () => {
  it('パーセントエンコードされた日本語の文書番号が照合できる', async () => {
    // P-0001_K002_工程2_01 を encodeURIComponent したもの。
    // 解かずに照合すると、この先の GetItem が台帳の documentNo と一致しない
    const response = await handler(
      event('POST', '/documents/P-0001_K002_%E5%B7%A5%E7%A8%8B2_01/revisions'),
    );

    expect(response.statusCode).toBe(MATCHED);
  });

  it('小文字のパーセントエンコードでも照合できる', async () => {
    const response = await handler(
      event('POST', '/documents/P-0001_K002_%e5%b7%a5%e7%a8%8b2_01/revisions'),
    );

    expect(response.statusCode).toBe(MATCHED);
  });

  it('文書番号に % が含まれても壊れない', async () => {
    // `#` と `/` は禁止だが `%` は使える（CLAUDE.md §4）。
    // %25 が 1回だけ解けて `100%検査` になる
    const response = await handler(
      event('POST', '/documents/P-0001_K001_100%25%E6%A4%9C%E6%9F%BB_01/revisions'),
    );

    expect(response.statusCode).toBe(MATCHED);
  });

  it('パーセント記号が壊れていれば 400 で止める', async () => {
    // 404 に化けさせない。「そんな文書は無い」と「URL が壊れている」は原因が違う
    const response = await handler(event('GET', '/documents/%E0%A4%A'));

    expect(response.statusCode).toBe(400);
  });

  it('エンコードされたスラッシュでパス変数を越えられない', async () => {
    // %2F を解いた結果でセグメントが増えるなら、照合は失敗しなければならない
    const response = await handler(
      event('POST', '/documents/a%2Fb/revisions'),
    );

    expect(response.statusCode).toBe(NOT_MATCHED);
  });
});

describe('トークンの門前払い', () => {
  it('トークンが無い書き込みは 401', async () => {
    const response = await handler(event('POST', '/documents'));

    expect(response.statusCode).toBe(401);
  });

  it('Bearer 以外のスキームは 401', async () => {
    const response = await handler(
      event('POST', '/documents', { authorization: 'Token abc' }),
    );

    expect(response.statusCode).toBe(401);
  });

  it('401 でも CORS ヘッダーを返す', async () => {
    // これが無いと、ブラウザには「通信できない」としか見えず 401 が読めない
    const response = await handler(event('POST', '/documents'));

    expect(response.headers?.['access-control-allow-origin']).toBe(ORIGIN);
  });

  it('OPTIONS はトークンを見ずに 204', async () => {
    // プリフライトに Authorization は付かない。ここで 401 を返すと全滅する
    const response = await handler(event('OPTIONS', '/documents'));

    expect(response.statusCode).toBe(204);
  });

  it('未定義のパスは 404', async () => {
    const response = await handler(event('GET', '/nope'));

    expect(response.statusCode).toBe(404);
  });
});
