/**
 * 同期API Lambda のエントリポイント。
 *
 * API Gateway は `ANY /{proxy+}` の Lambda プロキシ1本で、パスの振り分けは
 * ここで行う（8/7 の決定）。エンドポイントを足すたびに terraform apply が要る構成を
 * 避けるためで、引き換えに「どのパスが実在するか」は Terraform から読めない。
 * **正は docs/API.md。**
 *
 * 責務は CLAUDE.md §7 のとおり、合言葉の検証・採番・照合・台帳記録・署名付きURL発行まで。
 * 状態遷移は行わない（新規作成時の「ファイル未登録」の記録を除く）。
 */

import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { errorResponse, preflightResponse } from './http';
import { postUnlock } from './routes/unlock';

/** ヘッダー名の大文字小文字は API Gateway が正規化しないため、両方を見る */
function requestOrigin(event: APIGatewayProxyEvent): string {
  return event.headers?.origin ?? event.headers?.Origin ?? '';
}

export const handler = async (
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> => {
  const origin = requestOrigin(event);
  const method = event.httpMethod;
  const path = event.path;

  // 送信元IPは応答に含めない（疎通確認用の暫定ハンドラでは返していたが、本番に持ち込まない）。
  // ログには残す。IP制限が効かなくなったときの切り分けに要るため。
  console.log(
    JSON.stringify({
      message: 'request',
      method,
      path,
      sourceIp: event.requestContext?.identity?.sourceIp ?? 'unknown',
    })
  );

  if (method === 'OPTIONS') {
    return preflightResponse(origin);
  }

  try {
    // エンドポイントは順次ここへ足していく。正は docs/API.md。
    if (method === 'POST' && path === '/auth/unlock') {
      return await postUnlock(origin, event.body);
    }

    return errorResponse(origin, 404, '該当するエンドポイントがありません');
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
        path,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      })
    );
    return errorResponse(origin, 500, 'サーバー側でエラーが発生しました');
  }
};
