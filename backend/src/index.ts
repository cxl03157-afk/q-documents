/**
 * 同期API Lambda のエントリポイント。
 *
 * API Gateway は `ANY /{proxy+}` の Lambda プロキシ1本で、パスの振り分けは
 * ルート表（routes/table.ts）が行う。**正は docs/API.md。**
 *
 * 責務は CLAUDE.md §7 のとおり、合言葉の検証・採番・照合・台帳記録・署名付きURL発行まで。
 * 状態遷移は行わない（新規作成時の「ファイル未登録」の記録を除く）。
 *
 * ---
 *
 * **トークンの検証をここに集約している。**
 *
 * 各ハンドラの中で検証する方式は採らない。1本でも書き忘れると、その時点で
 * 台帳が誰でも触れる状態になる。しかも壊れ方が「本来止まるはずのものが通る」なので、
 * 正常系のテストは全部緑のままになり、気づく機会がない。
 *
 * ルート表の `auth` は省略できない3値で、ハンドラが受け取る文脈の型も
 * その値ごとに変えてある（routes/context.ts）。表に書き忘れることも、
 * 表の指定とハンドラの想定がずれることも、コンパイルで止まる。
 */

import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { authenticate } from './auth/requireToken';
import { errorResponse, headerValue, preflightResponse } from './http';
import { matchRoute } from './routes/table';

/** トークンが必要なのに無い・通らない場合の文言。画面はこれを見てロック状態へ戻す */
const UNAUTHORIZED = 'セッションが終了しました。再度解除してください';

export const handler = async (
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> => {
  const origin = headerValue(event.headers, 'origin');
  const method = event.httpMethod;
  const rawPath = event.path;

  // 送信元IPは応答に含めない（疎通確認用の暫定ハンドラでは返していたが、本番に持ち込まない）。
  // ログには残す。IP制限が効かなくなったときの切り分けに要るため。
  console.log(
    JSON.stringify({
      message: 'request',
      method,
      path: rawPath,
      sourceIp: event.requestContext?.identity?.sourceIp ?? 'unknown',
    })
  );

  if (method === 'OPTIONS') {
    return preflightResponse(origin);
  }

  try {
    /**
     * 文書番号には日本語が入る（`P-0001_K001_工程1_02`）ため、画面側は
     * `encodeURIComponent` を通して送る。照合の前に元に戻す。
     *
     * 壊れたパーセント記号は例外になるので、その場で 400 にする。
     * ここで落とさないと、後段で「該当なし」の 404 に化けて原因が見えなくなる。
     */
    let path: string;
    try {
      path = decodeURIComponent(rawPath);
    } catch {
      return errorResponse(origin, 400, 'URL の形式が正しくありません');
    }

    const matched = matchRoute(method, path);
    if (matched === null) {
      return errorResponse(origin, 404, '該当するエンドポイントがありません');
    }

    const { route, params } = matched;
    const base = {
      origin,
      body: event.body,
      params,
      query: event.queryStringParameters ?? {},
    };

    /**
     * `auth` ごとに、トークンをどう扱うかを決める。
     *
     * `conditional` で「ヘッダーはあるが通らない」を public に落とさないのが要点。
     * 落とすと、期限切れのトークンを付けたまま操作した利用者に対して
     * 応答が黙って変わる（削除済みが一覧から消える）。何が起きたか分からないので、
     * 401 を返して解除し直させる。
     */
    switch (route.auth) {
      case 'public':
        return await route.handler(base);

      case 'required': {
        const outcome = await authenticate(event.headers);
        if (outcome.state !== 'valid') {
          console.log(
            JSON.stringify({
              message: 'unauthorized',
              method,
              path,
              // 理由はログにだけ書く。応答で分けると、偽造と期限切れの区別が外から付く
              reason: outcome.state === 'invalid' ? outcome.reason : 'absent',
            })
          );
          return errorResponse(origin, 401, UNAUTHORIZED);
        }
        return await route.handler({ ...base, identity: outcome.identity });
      }

      case 'conditional': {
        const outcome = await authenticate(event.headers);
        if (outcome.state === 'invalid') {
          console.log(
            JSON.stringify({ message: 'unauthorized', method, path, reason: outcome.reason })
          );
          return errorResponse(origin, 401, UNAUTHORIZED);
        }
        const identity = outcome.state === 'valid' ? outcome.identity : null;
        return await route.handler({ ...base, identity });
      }
    }
  } catch (error) {
    /**
     * 例外の中身はクライアントへ返さない。SSM パラメータ名やテーブル名が
     * エラーメッセージに載ることがあり、構成の手がかりになる。
     * 調査に要る情報はログにだけ書く（このロググループは1年保持・CLAUDE.md §8-7）。
     */
    console.error(
      JSON.stringify({
        message: 'unhandled error',
        method,
        path: rawPath,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      })
    );
    return errorResponse(origin, 500, 'サーバー側でエラーが発生しました');
  }
};
