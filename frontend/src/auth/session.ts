/**
 * 生産技術モードの解除状態（screens.md §4）。
 *
 * 保持先は sessionStorage（タブを閉じると消える）。トークン・氏名・最終操作時刻を
 * 1つのJSONにまとめて置く。キーを3本に分けると「トークンはあるが氏名がない」といった
 * 中途半端な状態を扱う分岐が増えるため。
 *
 * この層は画面を知らない。状態が変わったら CustomEvent を出すだけにして、
 * 再描画は main.ts 側で行う。
 */

const STORAGE_KEY = 'q-documents:session';

/** 状態が変わったことの通知。main.ts がヘッダーと現在ルートを描き直す */
export const SESSION_CHANGE_EVENT = 'q-documents:session-change';

/** 無操作で自動ロックするまでの時間（screens.md §4: 30分） */
export const LOCK_AFTER_MS = 30 * 60 * 1000;

export type Session = {
  /** ヘッダーに出す氏名（担当者マスタから選ばせた値） */
  userName: string;

  /** サーバー発行のトークン */
  token: string;

  /**
   * サーバーが返したトークンの期限（epoch ms）。
   *
   * **30分の無操作ロックとは別物。** 目的が違うので値も揃えていない。
   *   無操作ロック（30分） — 席を立った隙に使われないための離席対策
   *   この期限（2時間）   — 盗まれたトークンが使われ続けないためのサーバー側の上限
   *
   * これを持たないと、2時間以上続けて操作した場合に、画面はまだ解除中のつもりなのに
   * サーバーが 401 を返す状態になる。操作の途中で理由の分からない失敗が起きるより、
   * 画面側で先にロックして解除し直させるほうがよい。
   *
   * **操作しても伸びない。** 伸ばせるのはサーバーだけで、画面が勝手に延長したら
   * 期限を設けた意味がなくなる。
   */
  expiresAt: number;

  /** 最終操作時刻（epoch ms）。30分判定の起点 */
  lastActiveAt: number;
};

/** どちらの期限で終了する（した）のか */
export type UnlockLimit = 'idle' | 'token';

/**
 * sessionStorage から読んだ値の検証。
 *
 * **時刻は `typeof === 'number'` では足りない。`NaN` も number だから。**
 * `NaN` が入ると `NaN <= 0` が false になり、`getSession()` がセッションを
 * 一度も破棄しなくなる。トークン期限だけでなく **30分の無操作ロックまで無効化**され、
 * しかもリロードしても復活する。
 *
 * API 側でも応答を検証している（lib/api.ts）が、ここでも弾く。
 * sessionStorage は開発者ツールから手で書き換えられるため、入口の検証だけでは塞げない。
 */
function isSession(value: unknown): value is Session {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.userName === 'string' &&
    typeof v.token === 'string' &&
    Number.isFinite(v.expiresAt) &&
    Number.isFinite(v.lastActiveAt)
  );
}

/** sessionStorage を読むだけ。期限は見ない。壊れた値は捨てる */
function read(): Session | null {
  const raw = sessionStorage.getItem(STORAGE_KEY);
  if (raw === null) return null;

  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isSession(parsed)) {
      sessionStorage.removeItem(STORAGE_KEY);
      return null;
    }
    return parsed;
  } catch {
    // 手で書き換えられた場合など。解除状態として扱わず捨てる
    sessionStorage.removeItem(STORAGE_KEY);
    return null;
  }
}

function write(session: Session): void {
  sessionStorage.setItem(STORAGE_KEY, JSON.stringify(session));
}

function emitChange(): void {
  window.dispatchEvent(new CustomEvent(SESSION_CHANGE_EVENT));
}

/**
 * 有効なセッションを返す。期限切れならその場で破棄して null を返す。
 *
 * タイマーが動いていることを前提にしない。PCのスリープやタブの非活性で
 * setInterval は期待どおり発火しないことがあり、タイマーだけを正にすると
 * 期限切れのまま解除状態が残る。**時刻の比較を正とする。**
 *
 * ここでは通知を出さない（描画中に呼ばれるため）。ロックへの切り替わりの通知は
 * autoLock.ts の定期チェックが担当する。
 */
export function getSession(): Session | null {
  const session = read();
  if (session === null) return null;

  if (remaining(session).ms <= 0) {
    sessionStorage.removeItem(STORAGE_KEY);
    return null;
  }
  return session;
}

/**
 * 残り時間と、それを決めている側。
 *
 * 2つの期限のうち**早いほう**が効く。無操作ロックは操作のたびに伸びるが、
 * トークンの期限は伸びないので、長時間続けて操作しているとどこかで逆転する。
 */
function remaining(session: Session): { ms: number; limit: UnlockLimit } {
  const now = Date.now();
  const idleMs = session.lastActiveAt + LOCK_AFTER_MS - now;
  const tokenMs = session.expiresAt - now;

  return idleMs <= tokenMs ? { ms: idleMs, limit: 'idle' } : { ms: tokenMs, limit: 'token' };
}

export function isUnlocked(): boolean {
  return getSession() !== null;
}

export function getUnlockToken(): string | null {
  return getSession()?.token ?? null;
}

/**
 * 自動ロックまでの残り時間と、それを決めている側。ロック中は 0。
 *
 * `limit` を返すのは、警告とお知らせの文面を分けるため。
 * トークンの期限で終わるのに「無操作のため」と出すと、操作していた利用者には
 * 何が起きたのか分からない。
 */
export function remainingUnlock(): { ms: number; limit: UnlockLimit } {
  const session = getSession();
  if (session === null) return { ms: 0, limit: 'idle' };
  return remaining(session);
}

/** S-2 の解除成功時に呼ぶ。expiresAt はサーバーの応答をそのまま渡す */
export function startSession(userName: string, token: string, expiresAt: number): void {
  write({ userName, token, expiresAt, lastActiveAt: Date.now() });
  emitChange();
}

/** ヘッダーの[終了]・自動ロック・401受信時に呼ぶ */
export function endSession(): void {
  sessionStorage.removeItem(STORAGE_KEY);
  emitChange();
}

/** 操作があったことを記録して自動ロックを先送りする。状態は変わらないので通知しない */
export function touch(): void {
  const session = getSession();
  if (session === null) return;
  write({ ...session, lastActiveAt: Date.now() });
}
