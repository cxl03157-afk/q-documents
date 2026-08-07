/**
 * 疎通確認用のハンドラ（暫定）。
 *
 * 目的は「CloudFront・API Gateway・Lambda の配線が通っているか」と
 * 「API Gateway から見た送信元IPが本物のクライアントIPか」の2点だけ。
 * 本物の同期API（合言葉・採番・台帳）は 8/9 以降に backend/src へ TypeScript で書き、
 * このファイルは消す。
 *
 * TypeScript + esbuild を今日は入れない。配線の確認に必要ないものを増やすと、
 * 疎通しなかったときに原因の候補が増える。
 */

export const handler = async (event) => {
  const sourceIp = event.requestContext?.identity?.sourceIp ?? 'unknown';

  console.log(
    JSON.stringify({
      message: 'hello handler invoked',
      method: event.httpMethod,
      path: event.path,
      sourceIp,
    })
  );

  return {
    statusCode: 200,
    headers: {
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
