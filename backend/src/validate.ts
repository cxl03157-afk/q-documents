/**
 * リクエスト本文の取り出しと検証。
 *
 * **画面側にも同じ検証があるが、正はここ**（CLAUDE.md §7）。
 * 画面の制御は開発者ツールから回避できるので、サーバー側を省略すると
 * 台帳に壊れた値がそのまま入る。
 *
 * 型を主張するだけの `as` は使わない。`JSON.parse` が返すのは何でもありの値で、
 * `as UnlockRequest` と書いても実行時には何も確かめていない。
 * 8/9 のレビューで画面側の無検証キャストが自動ロックの恒久無効化を招いたのと同じ構図。
 */

/**
 * 文字列項目の長さ上限。
 *
 * 極端に長い入力でログやハッシュ計算を膨らませない。文書番号を構成する値は
 * マスタのコードと工程名なので、実運用では数十文字に収まる。
 */
export const MAX_FIELD_LENGTH = 200;

/** JSON の本文をオブジェクトとして取り出す。配列・null・数値などは受け付けない */
export function parseJsonObject(body: string | null): Record<string, unknown> | null {
  if (body === null || body === '') return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  return parsed as Record<string, unknown>;
}

/** 必須の文字列項目。空文字と長すぎる値は不正として扱う */
export function requiredString(
  source: Record<string, unknown>,
  key: string,
): string | null {
  const value = source[key];
  if (typeof value !== 'string') return null;
  if (value === '' || value.length > MAX_FIELD_LENGTH) return null;
  return value;
}

/**
 * 任意の文字列項目。
 *
 * 未指定と空文字を区別しない（どちらも `undefined`）。フォームは選択なしを
 * 空文字で送ってくるため、ここで寄せておかないと下流で毎回両方を書くことになる。
 * 型が違う・長すぎる場合だけ `null`（＝不正）を返す。
 */
export function optionalString(
  source: Record<string, unknown>,
  key: string,
): string | undefined | null {
  const value = source[key];
  if (value === undefined || value === '') return undefined;
  if (typeof value !== 'string' || value.length > MAX_FIELD_LENGTH) return null;
  return value;
}

/**
 * 文書発行日。`YYYY-MM-DD` の実在する日付だけを通す。
 *
 * 形式の確認だけでは `2026-02-30` が通ってしまう。`Date` に通したあと
 * 元の文字列に戻して一致を見ることで、繰り上がった日付を弾く。
 * `Date.UTC` を使うのは、ローカルタイムゾーンで解釈させると
 * 実行環境によって前後1日ずれるため。
 */
export function isValidIssuedAt(value: string): boolean {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (match === null) return false;

  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));

  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}
