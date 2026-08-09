/**
 * HTTP 応答の組み立て。CORS とレスポンス形式をここ1か所に閉じ込める。
 *
 * 疎通確認用だった backend/hello/index.mjs から引き継いだ内容が中心。
 * 8/7 の実測で、`ANY /{proxy+}` は OPTIONS も Lambda に流すことを確認済みなので、
 * プリフライトの応答もここで返す（API Gateway 側に別統合は要らない）。
 */

import type { APIGatewayProxyResult } from 'aws-lambda';
import { config } from './config';

/**
 * ヘッダーを名前で引く。**見つからなければ空文字**。
 *
 * API Gateway はヘッダー名の大文字小文字を正規化せず、送られてきたままを渡す。
 * ブラウザの fetch は小文字で送るが curl は `Authorization` のように送るため、
 * どちらか一方だけを見ると片方の経路で必ず落ちる（`origin` / `Origin` を
 * 書き分けていた箇所も、書き忘れれば同じことが起きる）。
 *
 * 呼び出しごとに書き分けるのをやめ、**キーを1度だけ小文字に揃えて**引く。
 */
export function headerValue(
  headers: Record<string, string | undefined> | null | undefined,
  name: string,
): string {
  if (!headers) return '';

  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === target) return value ?? '';
  }
  return '';
}

/**
 * CORS の応答ヘッダー。
 *
 * 許可するのは画面（CloudFront）のドメイン1つだけで、ワイルドカードは使わない
 * （docs/API.md §補足：セキュリティ）。値は環境変数から取る — ディストリビューションを
 * 作り直すとドメインが変わり、直書きだと追随できないため（8/7 の決定）。
 *
 * 未設定の検出は config.ts の `required()` に任せている。ここで `?? ''` に
 * フォールバックすると、設定漏れが「ブラウザからだけ通信できない」という
 * 別の症状に化けて原因が見えなくなる。
 *
 * `Vary: Origin` を常に付けるのは、許可オリジン以外に対してヘッダーを付けない応答が
 * キャッシュされ、それが別のオリジンに使い回されるのを防ぐため。
 */
export function corsHeaders(requestOrigin: string): Record<string, string> {
  if (requestOrigin !== config.allowedOrigin) {
    return { vary: 'Origin' };
  }

  return {
    'access-control-allow-origin': config.allowedOrigin,
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

/**
 * エラー応答。本文の形を `{ message }` に統一して画面側の分岐を減らす。
 *
 * `extra` は、画面が次の操作を出すために追加の情報が要る場合にだけ使う。
 * 今のところ採番の 409 だけで、既に登録済みの現行リビジョンを添える
 * （S-3 が「リビジョンアップへ」の導線を出すのに要る）。
 * 例外の中身やテーブル名など、構成の手がかりになるものは入れない。
 */
export function errorResponse(
  requestOrigin: string,
  statusCode: number,
  message: string,
  extra?: Record<string, unknown>
): APIGatewayProxyResult {
  return jsonResponse(requestOrigin, statusCode, { message, ...extra });
}
