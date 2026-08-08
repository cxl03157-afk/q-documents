/**
 * API 呼び出しの共通部分。
 *
 * 画面と API はドメインが違う（CloudFront と execute-api）ため、呼び出しは
 * すべてクロスオリジンになる。許可オリジンは Lambda 側が返す（docs/API.md）。
 */

/**
 * API のベースURL。**ビルド時に埋め込まれる**（Vite の import.meta.env）。
 *
 * 未設定でも `undefined` のまま動いてしまい、「なぜか通信できない」という
 * 分かりにくい失敗になる。読み込み時に落として原因をその場で見せる。
 *
 * ローカル開発では frontend/.env.local に置く（.env.example をコピーする）。
 * デプロイ時は scripts/deploy-frontend.sh が Terraform の出力から渡すので、
 * 値を控えておく必要はない。
 */
const BASE_URL = import.meta.env.VITE_API_BASE_URL;

if (!BASE_URL) {
  throw new Error(
    'VITE_API_BASE_URL が設定されていません。frontend/.env.example を .env.local にコピーしてください'
  );
}

/**
 * 呼び出しの結果。
 *
 * 例外ではなく戻り値で失敗を表す。呼び出し側が try/catch を書き忘れても
 * 握りつぶしにならず、`ok` を見ないと中身を取り出せないため。
 */
export type ApiResult<T> =
  | { ok: true; data: T }
  | { ok: false; status: number; message: string };

/** 通信そのものが成立しなかった場合の status。HTTP には無い値を使う */
export const NETWORK_ERROR_STATUS = 0;

export async function apiPost<T>(path: string, body: unknown): Promise<ApiResult<T>> {
  let response: Response;

  try {
    response = await fetch(`${BASE_URL}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    // オフライン・DNS 失敗・CORS で弾かれた場合。fetch は理由を教えてくれない
    return {
      ok: false,
      status: NETWORK_ERROR_STATUS,
      message: '通信に失敗しました。時間をおいて試してください',
    };
  }

  // 本文が JSON でないこともある（API Gateway が返す 403 など）
  const payload: unknown = await response.json().catch(() => null);

  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      message: messageOf(payload) ?? '処理に失敗しました',
    };
  }

  return { ok: true, data: payload as T };
}

/** サーバーは失敗時に `{ message }` を返す（backend/src/http.ts） */
function messageOf(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const message = (payload as Record<string, unknown>).message;
  return typeof message === 'string' && message !== '' ? message : null;
}
