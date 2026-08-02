/**
 * 生産技術モードの解除状態。トークンは sessionStorage に保持する（screens.md §4）。
 *
 * 今日（8/1）は isUnlocked() が常に false を返す状態で使う。
 * 解除フロー（S-2・トークン発行・30分自動ロック）は 8/2 に実装する。
 */

const TOKEN_KEY = 'q-documents:unlock-token';

export function isUnlocked(): boolean {
  return sessionStorage.getItem(TOKEN_KEY) !== null;
}

export function getUnlockToken(): string | null {
  return sessionStorage.getItem(TOKEN_KEY);
}

export function setUnlockToken(token: string): void {
  sessionStorage.setItem(TOKEN_KEY, token);
}

export function clearUnlockToken(): void {
  sessionStorage.removeItem(TOKEN_KEY);
}
