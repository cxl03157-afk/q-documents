/**
 * 解除に使う2つの秘密（合言葉・トークン署名鍵）の保持（F-18 / F-20）。
 *
 * ---
 *
 * **なぜ「対」で1つのキャッシュにするか。**
 *
 * 合言葉を変更すると署名鍵も必ず同時に回る（F-20）。にもかかわらず名前ごとに
 * 別々の期限で持つと、2つの取得時刻がずれて**片方だけ新しい**状態が生まれる。
 * 使う側が3か所（解除・トークン検証・合言葉変更）あり、それぞれ必要な秘密が違うため、
 * ずれは自然に起きる。
 *
 * 実際にレビューで見つかった経路:
 *   トークン検証は署名鍵しか読まないので、署名鍵の取得時刻だけが更新され続ける
 *   → 合言葉の期限が先に切れる → 解除で合言葉だけが再取得されて一致する
 *   → 失敗しないので読み直しの経路に入らない → **古い署名鍵でトークンを発行する**
 *   → そのトークンは他のコンテナで 401 になり、利用者は解除画面へ戻され続ける
 *
 * 「使う側が忘れずに両方を読み直す」という規律で防ぐ形にはしない。使う側が増えるたびに
 * 同じ判断を書くことになり、1か所忘れれば上の症状に戻る。**対でしか取り出せない形**に
 * すれば、ずれるという状態を作れなくなる。
 */

import { config } from '../config';
import { getSecureParameter, putSecureParameter } from '../ssm';

export type UnlockSecrets = {
  passphrase: string;
  signingKey: string;
};

/**
 * キャッシュの期限。
 *
 * Lambda の実行環境は再利用されるので、モジュールスコープに置けばコンテナが
 * 生きている間は SSM を呼ばずに済む。SSM の GetParameter には秒あたりの上限があり、
 * リクエストのたびに呼ぶとそこが先に詰まる。
 *
 * **ただし期限を付ける。** 無期限だと、合言葉を差し替えても暖まったコンテナが
 * 古い値を持ち続け、「変えたのに古い合言葉で入れる」状態が最大で数時間続く。
 */
const CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * **解決しなかった**読み直しを何回まで許すか（使い切ると、窓が変わるまで読み直さない）。
 *
 * ---
 *
 * **なぜ上限が要るか。** 読み直しは誤った入力（合言葉の不一致・署名の不一致）で起きるので、
 * 連打されるとそのまま SSM の呼び出し回数になる。GetParameter には秒あたりの上限があり、
 * そこを突かれると**正しい合言葉での解除まで巻き添えで失敗する**。
 *
 * **なぜ「◯秒に1回まで」ではないか。** それだと単発の事象を取りこぼす。誰かが1回
 * 打ち間違えただけで制限が張られ、その直後に合言葉が変更されると、変更した本人の
 * 新しいトークンが署名不一致のまま読み直しを抑止されて 401 になる（画面は解除を終える）。
 * **F-20 が防ごうとした失敗そのもの**で、間隔を短くしても形は消えない。
 *
 * **なぜ数えるのが「解決しなかった回」なのか。** 当初は「読み直しても値が同じだった回」を
 * 数えていたが、それだと**正常な解除まで本数を消費する**（解除のたびに読み直すため・
 * セルフレビューで発見）。同じコンテナで解除が続くと本数が尽き、その窓でローテーションが
 * 起きると古い値を返してしまう。**正しい合言葉での解除は攻撃者には起こせない**ので、
 * 数に入れる理由がない。数えるべきは**読み直してもなお拒否した回**だけで、
 * それは誤った入力の回数と一致する。判断は結果を知っている呼び出し側が行う
 * （`noteRefreshDidNotHelp`）。
 *
 * 上限の見積もり: 10秒あたり5回・同時実行の上限が10なので、最悪でも
 * 毎秒5回（GetParameter は2本なので10回）。SSM の上限（40 TPS）に対して余裕がある。
 */
const FAILED_REFRESH_BUDGET = 5;

/** 本数を数える窓。使い切っても、窓が変われば補充される */
const REFRESH_WINDOW_MS = 10 * 1000;

let cache: { secrets: UnlockSecrets; fetchedAt: number } | null = null;

/** いまの窓で「読み直しても解決しなかった」回数と、その窓の開始時刻 */
let failedRefreshes = 0;
let windowStartedAt = 0;

/** 2本まとめて読む。片方だけ新しい状態を作らないため、必ずこの関数を通す */
async function fetchBoth(): Promise<UnlockSecrets> {
  const [passphrase, signingKey] = await Promise.all([
    getSecureParameter(config.passphraseParam),
    getSecureParameter(config.tokenSecretParam),
  ]);

  const secrets = { passphrase, signingKey };
  cache = { secrets, fetchedAt: Date.now() };
  return secrets;
}

/** 期限内ならキャッシュ、切れていれば2本まとめて読み直す */
export async function getUnlockSecrets(): Promise<UnlockSecrets> {
  if (cache !== null && Date.now() - cache.fetchedAt < CACHE_TTL_MS) {
    return cache.secrets;
  }
  return fetchBoth();
}

/**
 * キャッシュを迂回して読み直す（F-20）。
 *
 * ---
 *
 * **なぜ要るか。** 合言葉と署名鍵は画面から変更できるようになったが、変更を書き込めるのは
 * **その処理を実行した1つの Lambda コンテナ**だけで、他の暖まったコンテナは最大5分
 * （CACHE_TTL_MS）古い値を持ち続ける。放置すると変更した直後に次の症状が出る。
 *
 *   解除          新しい合言葉を入力したのに、古い値を持つコンテナに当たると 401
 *   トークン検証  変更した本人に発行した新しいトークンが、古い鍵を持つコンテナで 401
 *   再変更        正しい現行の合言葉を入力したのに 403
 *
 * どれも「変更したのに反映されない」という同じ原因で、利用者からは不具合にしか見えない。
 * **失敗したときに一度だけ読み直して照合し直せば、いずれも解消する。**
 *
 * **逆側（古い合言葉・古いトークンが最大5分通り続ける）は塞がらない。**
 * 照合に成功してしまうので読み直しの引き金が引かれないため。締め出しの即時性は
 * この設計では保証しない（docs/API.md・README の「実運用時の課題」）。
 *
 * ---
 *
 * **本数を消費するのは呼び出し側**（`noteRefreshDidNotHelp`）。読み直した結果それでも
 * 拒否したときだけ数える。正常な解除やローテーションの検出では消費しない
 * （FAILED_REFRESH_BUDGET の説明を参照）。
 *
 * **値の変化を見つけたら本数を戻す。** ローテーションの直後は他の利用者も古い値で
 * 失敗してくるため、そこで本数が尽きていると伝播が止まる。
 *
 * **残る限界。** 同じコンテナで10秒のうちに5回**誤った入力**があり、かつその窓の中で
 * ローテーションが起きた場合は、まだ古い値を返す。この場合は 401 になり、
 * 画面は解除を終える（次の窓で解消する）。**上限を設ける以上この形は消せない** —
 * 消すには読み直せるまで待つ必要があり、待てば同時実行の枠を掴んだまま塞ぐことになって、
 * かえって全員が使えなくなる。
 */
export async function refreshUnlockSecrets(): Promise<UnlockSecrets> {
  const now = Date.now();

  if (now - windowStartedAt >= REFRESH_WINDOW_MS) {
    windowStartedAt = now;
    failedRefreshes = 0;
  }

  if (failedRefreshes >= FAILED_REFRESH_BUDGET) {
    return getUnlockSecrets();
  }

  const previous = cache?.secrets ?? null;
  const latest = await fetchBoth();

  const changed =
    previous !== null &&
    (previous.passphrase !== latest.passphrase || previous.signingKey !== latest.signingKey);

  if (changed) failedRefreshes = 0;

  return latest;
}

/**
 * **本数に関係なく必ず読み直す。**
 *
 * 上限のある `refreshUnlockSecrets` は、使い切ると黙って古い値を返す。それでよいのは
 * 「古い値でも拒否になるだけ」の経路（解除・トークン検証）に限られる。
 *
 * **合言葉の変更だけは、古い値を掴むと拒否では済まない。** 変更前の合言葉が
 * 「現在の合言葉」として通り、直前の変更を巻き戻して本人を締め出せてしまう
 * （セルフレビューで発見）。ここは上限を外す。
 *
 * 外してよい根拠は**呼べる相手が限られていること** — この関数を使うのは
 * `POST /auth/passphrase` だけで、有効なトークンが要る。資格の要らない解除と違い、
 * 通りすがりに大量に叩ける経路ではない。そのぶん SSM への呼び出しが増えうるが、
 * 実行できるのは既に解除している人だけで、頻度も1日に数えるほどしかない。
 */
export async function forceRefreshUnlockSecrets(): Promise<UnlockSecrets> {
  return fetchBoth();
}

/**
 * 直前の読み直しでも解決しなかったことを伝える（本数を1つ使う）。
 *
 * **呼び出し側が判断する。** 読み直しが役に立ったかどうかは結果を見ないと分からず、
 * この関数の中では「値が同じだった」ことしか分からない。値が同じでも、正しい合言葉での
 * 解除なら**それは成功であって空振りではない**。区別できるのは呼び出し側だけ。
 */
export function noteRefreshDidNotHelp(): void {
  failedRefreshes += 1;
}

/**
 * 片方を書き換える（F-20 の合言葉変更）。
 *
 * **書いた値でキャッシュも更新する。** 更新しないと、書き込んだ本人のコンテナが
 * 直後の照合で古い値を使い、「変更した直後に、変更した端末で入れない」という
 * 最も分かりにくい失敗になる。
 *
 * **取得時刻も打ち直す。** 据え置くと、期限が切れる直前に書き込んだ場合に
 * 直後のリクエストで SSM を読み直すことになり、Parameter Store が書き込み前の値を
 * 返した瞬間に**変更した本人が 401 で落ちる**（この関数が防ごうとしている失敗そのもの・
 * セルフレビューで発見）。書いた値が最新であることはこちらが知っているので、
 * 読み直して確かめる必要がない。
 *
 * 書いていないほうの値の期限も延びるが、実害はない。この2つを変えるのは
 * `POST /auth/passphrase` だけで、いまその処理を実行しているのがこのコンテナだから。
 */
export async function writeUnlockSecret(
  kind: keyof UnlockSecrets,
  value: string,
): Promise<void> {
  const name = kind === 'passphrase' ? config.passphraseParam : config.tokenSecretParam;
  await putSecureParameter(name, value);

  if (cache !== null) {
    cache = {
      secrets: { ...cache.secrets, [kind]: value },
      fetchedAt: Date.now(),
    };
  }
}
