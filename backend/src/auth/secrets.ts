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
 * 読み直しの最短間隔。
 *
 * **読み直しは失敗を引き金に起きる**（合言葉が一致しない・署名が合わない）ので、
 * 誤った入力を連打されるとそのまま SSM の呼び出し回数になる。GetParameter には
 * 秒あたりの上限があり、そこを突かれると**正しい合言葉での解除まで巻き添えで失敗する**。
 */
const MIN_REFRESH_INTERVAL_MS = 10 * 1000;

let cache: { secrets: UnlockSecrets; fetchedAt: number } | null = null;

/** この時刻までは読み直さない。**空振りだったときだけ**設定する（下記参照） */
let refreshBlockedUntil = 0;

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
 * **間隔制限は「空振りだったとき」だけ設定する。**
 *
 * 読み直して値が変わっていれば、それは本物のローテーションが起きた証拠で、
 * 攻撃者には起こせない。そこで間隔を開けると、**変更の伝播をこちらから遅らせる**ことになる。
 * 値が同じだった読み直し（＝誤った入力による空振り）だけを数えれば、連打は抑えつつ
 * 本物の変更は即座に伝わる。
 *
 * 時刻を**呼び出しの後**に記録するのも同じ理由で、SSM 側の一時的な失敗で
 * 読み直せなかった回に間隔を消費させない。
 */
export async function refreshUnlockSecrets(): Promise<UnlockSecrets> {
  if (Date.now() < refreshBlockedUntil) {
    return getUnlockSecrets();
  }

  const previous = cache?.secrets ?? null;
  const latest = await fetchBoth();

  const unchanged =
    previous !== null &&
    previous.passphrase === latest.passphrase &&
    previous.signingKey === latest.signingKey;

  refreshBlockedUntil = unchanged ? Date.now() + MIN_REFRESH_INTERVAL_MS : 0;

  return latest;
}

/**
 * 片方を書き換える（F-20 の合言葉変更）。
 *
 * **書いた値でキャッシュも更新する。** 更新しないと、書き込んだ本人のコンテナが
 * 直後の照合で古い値を使い、「変更した直後に、変更した端末で入れない」という
 * 最も分かりにくい失敗になる。
 *
 * 取得時刻は動かさない。**書いていないほうの値の期限を、書き込みで延ばさない**ため。
 * 保存が片方で失敗した場合も、キャッシュは SSM の実際の状態と一致したままになる。
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
      fetchedAt: cache.fetchedAt,
    };
  }
}
