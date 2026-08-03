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

  /** サーバー発行のトークン。週2でAPIに接続するまではモック値が入る */
  token: string;

  /** 最終操作時刻（epoch ms）。30分判定の起点 */
  lastActiveAt: number;
};

function isSession(value: unknown): value is Session {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.userName === 'string' &&
    typeof v.token === 'string' &&
    typeof v.lastActiveAt === 'number'
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

  if (Date.now() - session.lastActiveAt >= LOCK_AFTER_MS) {
    sessionStorage.removeItem(STORAGE_KEY);
    return null;
  }
  return session;
}

export function isUnlocked(): boolean {
  return getSession() !== null;
}

export function getUnlockToken(): string | null {
  return getSession()?.token ?? null;
}

/** 自動ロックまでの残り時間（ms）。ロック中は 0 */
export function remainingUnlockMs(): number {
  const session = getSession();
  if (session === null) return 0;
  return session.lastActiveAt + LOCK_AFTER_MS - Date.now();
}

/** S-2 の解除成功時に呼ぶ */
export function startSession(userName: string, token: string): void {
  write({ userName, token, lastActiveAt: Date.now() });
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
