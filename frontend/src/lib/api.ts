/**
 * API 呼び出しの共通部分。
 *
 * 画面と API はドメインが違う（CloudFront と execute-api）ため、呼び出しは
 * すべてクロスオリジンになる。許可オリジンは Lambda 側が返す（docs/API.md）。
 */

import { noteServerRejectedToken } from '../auth/autoLock';
import { endSession, getUnlockToken } from '../auth/session';

/**
 * API のベースURL。**ビルド時に埋め込まれる**（Vite の import.meta.env）。
 *
 * 未設定でも `undefined` のまま動いてしまい、「なぜか通信できない」という
 * 分かりにくい失敗になる。読み込み時に落として原因をその場で見せる。
 *
 * ローカル開発では Vite の dev proxy 経由にするため `/api` を指す
 * （frontend/.env.example）。デプロイ時は scripts/deploy-frontend.sh が
 * Terraform の出力から渡すので、値を控えておく必要はない。
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
 *
 * 失敗時に `payload` を残すのは、`message` だけでは足りない応答があるため。
 * 採番の 409 は現行リビジョン（`existing`）を添えて返し、S-3 がそれを使って
 * S-4 への導線を出す（docs/API.md）。
 */
export type ApiResult<T> =
  | { ok: true; data: T }
  | { ok: false; status: number; message: string; payload: unknown };

/** 通信そのものが成立しなかった場合の status。HTTP には無い値を使う */
export const NETWORK_ERROR_STATUS = 0;

type Options = {
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
  /**
   * 解除中ならトークンを付けるか。
   *
   * `POST /auth/unlock` だけ false にする。トークンを発行する入口なので、
   * まだ持っていないし、持っていても意味がない。
   */
  attachToken: boolean;
};

/**
 * 応答を検証して返す。
 *
 * **型ガードを必須の引数にしている。** 以前は `payload as T` と書いていたが、
 * これは型を主張しているだけで実行時には何も確認しておらず、想定外の応答が
 * 型の付いた値として画面に流れ込んでいた。実際、`expiresAt` が欠けた応答が来ると
 * `Date.parse` が NaN を返し、NaN はどんな比較でも false になるため
 * **30分の自動ロックまで恒久的に無効化される**ことがレビューで判明した。
 *
 * 呼び出し側で `if` を書く方式（＝書き忘れても型エラーにならない）は採らない。
 * エンドポイントが増えるほど必ず漏れるので、規律ではなく型で縛る。
 */
async function request<T>(
  path: string,
  options: Options,
  isExpected: (value: unknown) => value is T
): Promise<ApiResult<T>> {
  const token = options.attachToken ? getUnlockToken() : null;

  const headers: Record<string, string> = {};
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  if (token !== null) headers.authorization = `Bearer ${token}`;

  let response: Response;

  try {
    response = await fetch(`${BASE_URL}${path}`, {
      method: options.method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
  } catch {
    // オフライン・DNS 失敗・CORS で弾かれた場合。fetch は理由を教えてくれない
    return {
      ok: false,
      status: NETWORK_ERROR_STATUS,
      message: '通信に失敗しました。時間をおいて試してください',
      payload: null,
    };
  }

  // 本文が JSON でないこともある（API Gateway が返す 403 など）
  const payload: unknown = await response.json().catch(() => null);

  if (!response.ok) {
    /**
     * **トークンを付けたのに 401 なら、その解除はもう通らない。**
     *
     * サーバー側の期限（2時間）は画面側の無操作ロック（30分）と別に進むので、
     * 画面がまだ解除中のつもりでもサーバーが拒否することがある。
     * そのままだと操作のたびに理由の分からない失敗が続くので、
     * ここでロック状態へ戻す（docs/screens.md §4）。
     *
     * **理由を立ててから `endSession()` を呼ぶ。** 順序が逆だと、
     * SESSION_CHANGE を受けた autoLock が先に「解除済み」の記録を落としてしまい、
     * お知らせが出ないまま解除画面へ飛ぶ（autoLock.ts の該当関数を見ること）。
     */
    if (response.status === 401 && token !== null) {
      noteServerRejectedToken();
      endSession();
    }

    return {
      ok: false,
      status: response.status,
      message: messageOf(payload) ?? '処理に失敗しました',
      payload,
    };
  }

  // 2xx でも中身が想定と違えば失敗として扱う。
  // ここを通さずに先へ渡すと、壊れた値が型の付いた顔をして画面に入る
  if (!isExpected(payload)) {
    return {
      ok: false,
      status: response.status,
      message: '応答の形式が正しくありません',
      payload,
    };
  }

  return { ok: true, data: payload };
}

/** 読み取り。解除中ならトークンを付ける（`GET /documents` は削除済みの有無が変わる） */
export function apiGet<T>(
  path: string,
  isExpected: (value: unknown) => value is T
): Promise<ApiResult<T>> {
  return request(path, { method: 'GET', attachToken: true }, isExpected);
}

/** 合言葉を要さない POST。今は `POST /auth/unlock` と番号プレビューだけ */
export function apiPost<T>(
  path: string,
  body: unknown,
  isExpected: (value: unknown) => value is T
): Promise<ApiResult<T>> {
  return request(path, { method: 'POST', body, attachToken: false }, isExpected);
}

/** 合言葉が要る POST。トークンを付け、401 ならロック状態へ戻す */
export function apiPostAuthed<T>(
  path: string,
  body: unknown,
  isExpected: (value: unknown) => value is T
): Promise<ApiResult<T>> {
  return request(path, { method: 'POST', body, attachToken: true }, isExpected);
}

/** 合言葉が要る PATCH。トークンを付け、401 ならロック状態へ戻す（`PATCH /masters/{id}` 用） */
export function apiPatchAuthed<T>(
  path: string,
  body: unknown,
  isExpected: (value: unknown) => value is T
): Promise<ApiResult<T>> {
  return request(path, { method: 'PATCH', body, attachToken: true }, isExpected);
}

/** 合言葉が要る DELETE。本文を持たない（`DELETE /documents/{docNo}` 用） */
export function apiDeleteAuthed<T>(
  path: string,
  isExpected: (value: unknown) => value is T
): Promise<ApiResult<T>> {
  return request(path, { method: 'DELETE', attachToken: true }, isExpected);
}

/** サーバーは失敗時に `{ message }` を返す（backend/src/http.ts） */
function messageOf(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const message = (payload as Record<string, unknown>).message;
  return typeof message === 'string' && message !== '' ? message : null;
}
