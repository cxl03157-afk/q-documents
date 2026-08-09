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

/**
 * POST して応答を検証する。
 *
 * **型ガードを必須の引数にしている。** 以前は `payload as T` と書いていたが、
 * これは型を主張しているだけで実行時には何も確認しておらず、想定外の応答が
 * 型の付いた値として画面に流れ込んでいた。実際、`expiresAt` が欠けた応答が来ると
 * `Date.parse` が NaN を返し、NaN はどんな比較でも false になるため
 * **30分の自動ロックまで恒久的に無効化される**ことがレビューで判明した。
 *
 * 呼び出し側で `if` を書く方式（＝書き忘れても型エラーにならない）は採らない。
 * 8/10 以降でエンドポイントが7本増えるため、規律ではなく型で縛る。
 * ガードを渡さなければ、そもそもコンパイルが通らない。
 */
export async function apiPost<T>(
  path: string,
  body: unknown,
  isExpected: (value: unknown) => value is T
): Promise<ApiResult<T>> {
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

  // 200 でも中身が想定と違えば失敗として扱う。
  // ここを通さずに先へ渡すと、壊れた値が型の付いた顔をして画面に入る
  if (!isExpected(payload)) {
    return {
      ok: false,
      status: response.status,
      message: '応答の形式が正しくありません',
    };
  }

  return { ok: true, data: payload };
}

/** サーバーは失敗時に `{ message }` を返す（backend/src/http.ts） */
function messageOf(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const message = (payload as Record<string, unknown>).message;
  return typeof message === 'string' && message !== '' ? message : null;
}
