/**
 * S-8 合言葉の変更（screens.md §5 / F-20）。
 *
 * 従来この操作は AWS CLI（`aws ssm put-parameter --overwrite`）しか手段がなく、
 * 文書管理者が自分で実行できなかった。
 *
 * **検証はサーバーが正**（CLAUDE.md §7）。この画面の事前確認は誤りを早く知らせるためで、
 * 要件の判定は `shared/passphrasePolicy.ts` を**サーバーと同じ関数**で行う。
 * 別々に書くと「画面では通ったのにサーバーが違う理由で拒否する」が起きる。
 */

import {
  MAX_PASSPHRASE_LENGTH,
  MIN_PASSPHRASE_LENGTH,
  normalizePassphrase,
  passphraseRejectionReason,
} from '../../../shared/passphrasePolicy';
import { endSession, getSession, updateToken } from '../auth/session';
import { NETWORK_ERROR_STATUS, apiPostAuthed } from '../lib/api';
import { escapeHtml } from '../lib/html';

/** POST /auth/passphrase の成功応答（docs/API.md）。`unlock` と同じ形 */
type ChangeResponse = {
  token: string;

  /**
   * 有効期間（秒）。**絶対時刻ではなくこちらを使う**理由は unlock.ts と同じ。
   * 端末の時計とサーバーの時計をまたぐと「解除しても解除されない」状態になる。
   */
  expiresInSeconds: number;
};

function isChangeResponse(value: unknown): value is ChangeResponse {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.token === 'string' &&
    v.token !== '' &&
    Number.isInteger(v.expiresInSeconds) &&
    (v.expiresInSeconds as number) > 0
  );
}

/**
 * 500 応答に載る、**どこまで進んだか**（backend/src/routes/changePassphrase.ts）。
 *
 *   none           何も変わっていない。そのまま再試行できる
 *   secret-rotated 署名鍵が変わり、全員の解除が切れた。
 *                  **合言葉が変わったかどうかはサーバーにも分からない**
 *
 * 文言だけで見分けると、通信エラーなど別の失敗にまで「解除が切れました」と
 * 出してしまう。画面の出し分けはこの値で行う。
 */
function isSecretRotated(payload: unknown): boolean {
  if (typeof payload !== 'object' || payload === null) return false;
  return (payload as Record<string, unknown>).stage === 'secret-rotated';
}

/** この画面のルート。描き直されても「まだこの画面か」を判断できる基準にする */
const ROUTE = '#/passphrase';

/**
 * 応答待ちの間に画面が変わっていないか。
 *
 * **数え上げた番号では足りない**（documentEdit.ts などが使っている方式）。
 * 番号が増えるのは同じ画面をもう一度開いたときだけなので、`[一覧へ戻る]` や
 * ヘッダーの `[一覧]` で**別の画面へ移った場合は増えず**、応答が届いた時点で
 * 完了表示が一覧を上書きしてしまう（セルフレビューで発見）。
 *
 * `#app` の中身を差し替えれば、それ以前の要素は文書から切り離される。
 * **描画のたびに増える番号を管理するより、要素がまだ繋がっているかを直接見るほうが
 * 移動の仕方を問わない。**
 */
function isStillVisible(form: HTMLFormElement): boolean {
  return form.isConnected;
}

export function renderPassphrase(): void {
  const app = document.querySelector<HTMLElement>('#app');
  if (!app) return;

  app.innerHTML = formPage();
  bindEvents(app);
}

function formPage(): string {
  return `
    <h1>合言葉の変更</h1>

    <p class="form-note">
      変更すると、<strong>いま解除中の端末はすべて終了します</strong>（この端末を除く）。
      反映まで最大5分かかることがあります。
    </p>

    <form id="passphrase-form" class="entry-form">
      <fieldset class="entry-fieldset">
        <label class="form-field">
          <span>現在の合言葉</span>
          <input type="password" name="current" required autocomplete="off" />
        </label>
        <label class="form-field">
          <span>新しい合言葉</span>
          <input type="password" name="next" required autocomplete="off" />
        </label>
        <label class="form-field">
          <span>新しい合言葉（確認）</span>
          <input type="password" name="confirm" required autocomplete="off" />
        </label>
      </fieldset>

      <p class="form-note">
        新しい合言葉は${MIN_PASSPHRASE_LENGTH}〜${MAX_PASSPHRASE_LENGTH}文字で、前後に空白を入れないでください。
      </p>

      <p id="passphrase-error" class="form-error" role="alert"></p>

      <div class="result-actions">
        <button type="submit" class="btn-primary">変更</button>
        <a class="btn-end" href="#/">一覧へ戻る</a>
      </div>
    </form>
  `;
}

function bindEvents(app: HTMLElement): void {
  const form = app.querySelector<HTMLFormElement>('#passphrase-form');
  if (!form) return;

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    void submit(app, form);
  });
}

async function submit(app: HTMLElement, form: HTMLFormElement): Promise<void> {
  /**
   * 氏名は**送信前に**控える。応答を待つ間にちょうど期限が切れると、
   * その時点でセッションが破棄されて氏名も読めなくなる。新しいトークンを
   * 載せ替えるときにヘッダーへ出す名前が必要なので、先に取っておく。
   */
  const userName = getSession()?.userName ?? '';

  const current = fieldValue(form, 'current');
  const next = fieldValue(form, 'next');
  const confirm = fieldValue(form, 'confirm');

  /**
   * **確認欄の一致はここでしか見られない。** サーバーは合言葉を1つしか保存しないので、
   * 2つ送っても検証のしようがない。打ち間違えたまま登録されると、次に入力するときに
   * 再現できず**誰も解除できなくなる**ため、この確認は必須。
   *
   * **比べる前に正規化する。** 片方を貼り付け（NFD）・もう片方を手入力（NFC）すると、
   * 見た目が同じなのに一致せず、`showError` が3欄とも消すので**打ち直しても同じ場所で
   * 止まり続ける**。保存も照合も正規化後の値で行う以上（shared/passphrasePolicy.ts）、
   * ここだけ素で比べる理由がない。
   */
  if (normalizePassphrase(next) !== normalizePassphrase(confirm)) {
    showError(app, form, '新しい合言葉が一致しません');
    return;
  }

  // サーバーと同じ関数で事前に判定する（正はサーバー側）
  const rejection = passphraseRejectionReason(next, current);
  if (rejection !== null) {
    showError(app, form, rejection);
    return;
  }

  const button = form.querySelector<HTMLButtonElement>('button[type="submit"]');
  setSubmitting(button, true);
  clearError(app);

  const result = await apiPostAuthed(
    '/auth/passphrase',
    { currentPassphrase: current, newPassphrase: next },
    isChangeResponse,
  );

  if (result.ok) {
    /**
     * **セッションの載せ替えは、画面を見ているかどうかに関わらず行う。**
     * 署名鍵が回った以上、いま持っているトークンはもう通らない。応答待ちの間に
     * 別の画面へ移っていた場合こそ、載せ替えないと次の操作が 401 で落ちる
     * （documentEdit.ts の「store への反映はセッションで絞らない」と同じ考え方）。
     */
    updateToken(userName, result.data.token, Date.now() + result.data.expiresInSeconds * 1000);

    /**
     * **ここだけは要素ではなくルートで判断する。**
     *
     * 失効から復活した場合、`updateToken` が通知を出して `main.ts` がこの画面を
     * 描き直す。すると手元の `form` は切り離されるので、要素で判断すると
     * **変更は成功しているのに完了表示が出ない**（真っ白なフォームに戻る）。
     * 利用者はもう使えない古い合言葉で再試行して 403 を踏むことになる
     * （セルフレビューで発見）。
     *
     * `#app` は使い回しの要素なので、ルートが変わっていなければ書き込んでよい。
     *
     * **失効から復活した場合に必ず出せるわけではない。** `autoLock` の定期確認が先に
     * 走っていると、その時点でルートが `#/unlock` へ移っているのでここは通らない。
     * ただしその場合も**復活の通知で解除中として描き直され、一覧へ移る**
     * （`pages/unlock.ts` が解除中なら `#/` へ送る）ので、解除画面に取り残されたり
     * 古い合言葉で再試行させられたりはしない。出せないのは完了の文言だけ。
     */
    if (location.hash !== ROUTE) return;
    app.innerHTML = completedPage();
    return;
  }

  /**
   * 署名鍵が変わったあとで失敗した場合（サーバー側の⑤で失敗）。
   *
   * この端末を含む全員の解除が切れている。**合言葉が新旧どちらかは分からない**
   * （書き込みが済んで応答だけ失われたかもしれない）。
   * そのまま再試行させると、まだ有効な操作に見えて 401 が返るだけなので、
   * 解除し直す導線を出す。どちらの合言葉で入るかは、そこで試してもらう。
   *
   * **画面を離れていても、持っているトークンが死んだ事実は変わらない。**
   * 成功時のセッション載せ替えと同じで、状態の後始末は画面の有無で絞らない
   * （説明を読ませる相手がいないので、その場で解除を終わらせる）。
   */
  if (isSecretRotated(result.payload)) {
    if (!isStillVisible(form)) {
      endSession();
      return;
    }

    /**
     * `endSession()` はここでは呼ばない。呼ぶと `main.ts` が描き直してガードが
     * `#/unlock` へ飛ばし、**この説明を読む前に画面が消える**。
     * 解除を終わらせるのはボタンを押した時点でよい（トークンはどのみち通らない）。
     */
    app.innerHTML = reunlockPage(result.message);
    app.querySelector<HTMLButtonElement>('#reunlock')?.addEventListener('click', () => {
      endSession();
      location.hash = '#/unlock';
    });
    return;
  }

  if (!isStillVisible(form)) return;

  setSubmitting(button, false);

  /**
   * **通信が失敗した場合は、成否が分からないことを伝える。**
   *
   * 応答が届かなかっただけで、サーバー側では両方の書き込みが終わっているかもしれない。
   * その場合は合言葉が既に変わっていて、この端末のトークンも死んでいる。
   * 単に「通信に失敗しました」とだけ出すと、利用者は古い合言葉で再試行して 403 を踏む。
   *
   * どちらに転んでも成り立つ案内は「解除し直して確かめる」こと — 変わっていなければ
   * 元の合言葉で、変わっていれば新しい合言葉で解除できる。
   */
  showError(
    app,
    form,
    result.status === NETWORK_ERROR_STATUS
      ? `${result.message}。変更が完了している可能性があります。一度[終了]して、新しい合言葉で解除できるか確認してください`
      : result.message,
  );
}

function completedPage(): string {
  return `
    <h1>合言葉の変更</h1>
    <p class="form-info" role="status">
      合言葉を変更しました。次回からは新しい合言葉を使ってください。
    </p>
    <p class="form-note">
      他の端末の解除は5分以内にすべて終了します。この端末は解除したまま続けて操作できます。
    </p>
    <p><a href="#/">一覧へ戻る</a></p>
  `;
}

/**
 * 署名鍵が変わったあとで失敗した場合。解除し直してもらう。
 *
 * **どちらの合言葉で入れるかは断定しない。** サーバー側でも判別できない
 * （backend/src/routes/changePassphrase.ts の⑤）。断定して外すと、
 * 利用者は「合言葉が壊れた」と受け取って復旧作業に入ってしまう。
 */
function reunlockPage(message: string): string {
  return `
    <h1>合言葉の変更</h1>
    <p class="form-error" role="alert">${escapeHtml(message)}</p>
    <p class="form-note">新しい合言葉で解除できない場合は、これまでの合言葉をお試しください。</p>
    <p><button type="button" id="reunlock" class="btn-primary">解除し直す</button></p>
  `;
}

function setSubmitting(button: HTMLButtonElement | null, submitting: boolean): void {
  if (!button) return;
  button.disabled = submitting;
  button.textContent = submitting ? '変更中…' : '変更';
}

function clearError(app: HTMLElement): void {
  const error = app.querySelector<HTMLElement>('#passphrase-error');
  if (error) error.textContent = '';
}

/**
 * 失敗したら**入力欄を空にして現在の合言葉に戻す**。
 * 打ち直しの手間より、伏字のまま何が入っているか分からない状態で送り直すほうが危ない。
 */
function showError(app: HTMLElement, form: HTMLFormElement, message: string): void {
  const error = app.querySelector<HTMLElement>('#passphrase-error');
  if (error) error.textContent = message;

  for (const name of ['current', 'next', 'confirm']) {
    const el = form.elements.namedItem(name);
    if (el instanceof HTMLInputElement) el.value = '';
  }

  const first = form.elements.namedItem('current');
  if (first instanceof HTMLInputElement) first.focus();
}

function fieldValue(form: HTMLFormElement, name: string): string {
  const el = form.elements.namedItem(name);
  return el instanceof HTMLInputElement ? el.value : '';
}
