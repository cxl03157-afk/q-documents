/**
 * 疎通確認用のハンドラ（暫定）。
 *
 * 目的は3つだけ。
 *   1. CloudFront・API Gateway・Lambda の配線が通っているか
 *   2. API Gateway から見た送信元IPが本物のクライアントIPか
 *   3. **ANY /{proxy+} が OPTIONS も Lambda に流すか**（CORS のプリフライト）
 *
 * 3 を今日確かめるのは、別に OPTIONS 用の統合が要るなら、画面から API を叩く
 * 8/11 ではなく今日のうちに気づきたいため。
 *
 * 本物の同期API（合言葉・採番・台帳）は 8/9 以降に backend/src へ TypeScript で書き、
 * このファイルは消す。**応答に sourceIp を含めているので、そのまま本番へ持ち込まない。**
 *
 * TypeScript + esbuild を今日は入れない。配線の確認に必要ないものを増やすと、
 * 疎通しなかったときに原因の候補が増える。
 */

const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN ?? '';

/**
 * CORS の応答ヘッダー。
 *
 * 許可するのは画面のオリジン1つだけで、ワイルドカードは使わない
 * （docs/API.md §補足：セキュリティ）。
 * Vary: Origin を付けるのは、許可オリジン以外からのリクエストに対して
 * ヘッダーを付けない場合に、その応答がキャッシュされて他のオリジンに使われるのを防ぐため。
 */
const corsHeaders = (requestOrigin) => {
  if (!ALLOWED_ORIGIN || requestOrigin !== ALLOWED_ORIGIN) {
    return { vary: 'Origin' };
  }

  return {
    'access-control-allow-origin': ALLOWED_ORIGIN,
    vary: 'Origin',
  };
};

export const handler = async (event) => {
  const sourceIp = event.requestContext?.identity?.sourceIp ?? 'unknown';
  const requestOrigin = event.headers?.origin ?? event.headers?.Origin ?? '';

  console.log(
    JSON.stringify({
      message: 'hello handler invoked',
      method: event.httpMethod,
      path: event.path,
      sourceIp,
    })
  );

  /**
   * プリフライト。本文は返さないので 204。
   * 合言葉トークンを載せるヘッダー名は F-18 の実装で決めるため、
   * ここでは content-type だけを許可している。
   */
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 204,
      headers: {
        ...corsHeaders(requestOrigin),
        'access-control-allow-methods': 'GET, POST, PATCH, DELETE, OPTIONS',
        'access-control-allow-headers': 'content-type',
        'access-control-max-age': '600',
      },
      body: '',
    };
  }

  return {
    statusCode: 200,
    headers: {
      ...corsHeaders(requestOrigin),
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
    body: JSON.stringify({
      message: 'hello from q-documents api',
      method: event.httpMethod,
      path: event.path,
      // リソースポリシーが見ているIPと同じ値。許可リストを直すときの確認に使う
      sourceIp,
      time: new Date().toISOString(),
    }),
  };
};
