/**
 * HTTP 応答の組み立て。CORS とレスポンス形式をここ1か所に閉じ込める。
 *
 * 疎通確認用だった backend/hello/index.mjs から引き継いだ内容が中心。
 * 8/7 の実測で、`ANY /{proxy+}` は OPTIONS も Lambda に流すことを確認済みなので、
 * プリフライトの応答もここで返す（API Gateway 側に別統合は要らない）。
 */

import type { APIGatewayProxyResult } from 'aws-lambda';

/**
 * 許可するオリジン。画面（CloudFront）のドメイン1つだけで、ワイルドカードは使わない
 * （docs/API.md §補足：セキュリティ）。
 *
 * ハンドラに直書きせず環境変数で渡すのは、ディストリビューションを作り直すと
 * ドメインが変わり、コードが追随できなくなるため（8/7 の決定）。
 */
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN ?? '';

/**
 * CORS の応答ヘッダー。
 *
 * `Vary: Origin` を常に付けるのは、許可オリジン以外に対してヘッダーを付けない応答が
 * キャッシュされ、それが別のオリジンに使い回されるのを防ぐため。
 */
export function corsHeaders(requestOrigin: string): Record<string, string> {
  if (ALLOWED_ORIGIN === '' || requestOrigin !== ALLOWED_ORIGIN) {
    return { vary: 'Origin' };
  }

  return {
    'access-control-allow-origin': ALLOWED_ORIGIN,
    vary: 'Origin',
  };
}

/**
 * プリフライトの応答。本文を返さないので 204。
 *
 * `authorization` を許可ヘッダーに含めている。合言葉トークンは
 * `Authorization: Bearer <token>` で送るため（F-18）。これが無いと、
 * トークンを付けたリクエストがプリフライトの段階でブラウザに止められる。
 */
export function preflightResponse(requestOrigin: string): APIGatewayProxyResult {
  return {
    statusCode: 204,
    headers: {
      ...corsHeaders(requestOrigin),
      'access-control-allow-methods': 'GET, POST, PATCH, DELETE, OPTIONS',
      'access-control-allow-headers': 'content-type, authorization',
      'access-control-max-age': '600',
    },
    body: '',
  };
}

/**
 * JSON の応答。
 *
 * `cache-control: no-store` を全応答に付ける。台帳の内容もトークンも、
 * ブラウザや中間キャッシュに残してよいものではない。
 */
export function jsonResponse(
  requestOrigin: string,
  statusCode: number,
  body: unknown
): APIGatewayProxyResult {
  return {
    statusCode,
    headers: {
      ...corsHeaders(requestOrigin),
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
    body: JSON.stringify(body),
  };
}

/** エラー応答。本文の形を `{ message }` に統一して画面側の分岐を減らす */
export function errorResponse(
  requestOrigin: string,
  statusCode: number,
  message: string
): APIGatewayProxyResult {
  return jsonResponse(requestOrigin, statusCode, { message });
}
