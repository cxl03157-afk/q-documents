/**
 * 30分の無操作でロック状態へ戻す（screens.md §4）。
 *
 * 期限そのものの判定は session.ts が時刻の比較で行う。ここがやるのは
 * 「操作の記録」「残り1分の警告」「ロックへ切り替わったことの通知」の3つだけ。
 */

import { SESSION_CHANGE_EVENT, endSession, isUnlocked, remainingUnlockMs, touch } from './session';

/** 残りこれを切ったら警告を出す（screens.md §4: 残り1分で警告） */
const WARN_BEFORE_MS = 60 * 1000;

/** 残り時間の確認間隔 */
const CHECK_INTERVAL_MS = 10 * 1000;

/**
 * 最終操作時刻の書き込み間隔。
 * クリック・キー入力のたびに sessionStorage へ書くと書き込みが多すぎるため、
 * 10秒に1回までに間引く。30分の判定に対して10秒の誤差は問題にならない。
 */
const TOUCH_INTERVAL_MS = 10 * 1000;

const ACTIVITY_EVENTS = ['click', 'keydown', 'scroll'] as const;

let lastTouchedAt = 0;
let wasUnlocked = false;

/** 自動ロックが起きた直後だけ出すお知らせ。次の操作で消す */
let showAutoLockedNotice = false;

export function startAutoLock(): void {
  for (const type of ACTIVITY_EVENTS) {
    // capture: true — 画面側が stopPropagation してもタイマーが延びるようにする
    window.addEventListener(type, onActivity, { passive: true, capture: true });
  }

  // 解除・終了が起きた時点で「前回の状態」を覚え直す。
  // これがないと、ヘッダーの[終了]で手動ロックした直後の tick が
  // 「解除済み → ロック」の変化を見て自動ロックと誤判定し、
  // 自分で終了したのに「無操作のため終了しました」と出る。
  window.addEventListener(SESSION_CHANGE_EVENT, () => {
    wasUnlocked = isUnlocked();
    if (wasUnlocked) showAutoLockedNotice = false; // 解除し直したらお知らせを消す
    renderNotice();
  });

  wasUnlocked = isUnlocked();
  window.setInterval(tick, CHECK_INTERVAL_MS);
  renderNotice();
}

function onActivity(): void {
  if (!isUnlocked()) {
    if (showAutoLockedNotice) {
      showAutoLockedNotice = false;
      renderNotice();
    }
    return;
  }

  const now = Date.now();
  if (now - lastTouchedAt < TOUCH_INTERVAL_MS) return;
  lastTouchedAt = now;
  touch();
  renderNotice();
}

function tick(): void {
  const unlocked = isUnlocked();

  if (wasUnlocked && !unlocked) {
    showAutoLockedNotice = true;
    // getSession() が期限切れを検出済みでも、ヘッダーと一覧を描き直すために通知は出す
    endSession();
  }
  wasUnlocked = unlocked;

  renderNotice();
}

function renderNotice(): void {
  const el = document.querySelector<HTMLElement>('#app-notice');
  if (!el) return;

  if (showAutoLockedNotice) {
    el.className = 'notice notice-locked';
    el.textContent = '無操作のため生産技術モードを終了しました。再度解除してください。';
    return;
  }

  const remaining = remainingUnlockMs();
  if (remaining > 0 && remaining <= WARN_BEFORE_MS) {
    const seconds = Math.ceil(remaining / 1000);
    el.className = 'notice notice-warning';
    el.textContent = `無操作のため、あと約${seconds}秒で生産技術モードが終了します。画面を操作すると延長されます。`;
    return;
  }

  // 空にすると CSS の :empty で非表示になる
  el.className = 'notice';
  el.textContent = '';
}
