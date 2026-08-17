/**
 * POST /auth/passphrase — 合言葉の変更（F-20 / docs/API.md）。
 *
 * 従来この操作は `aws ssm put-parameter --overwrite` の CLI しかなく、
 * 文書管理者が自分で実行できなかった。画面から変更できるようにする。
 *
 * ---
 *
 * **処理の順序が、この機能の設計そのもの。**
 *
 *   ① 現在の合言葉を照合する（不一致は 403）
 *   ② 新しい署名鍵を生成する（メモリ上のみ）
 *   ③ **新しい鍵で、本人のトークンを先に作る**
 *   ④ 署名鍵を SSM へ保存する
 *   ⑤ 新しい合言葉を SSM へ保存する
 *   ⑥ ③で作ったトークンを返す
 *
 * **③を④より前に置くのが要点。** 書き込みのあとに失敗しうる処理を残さないことで、
 * 部分失敗が下の2通りに収まる。
 *
 *   ④で失敗 — 何も変わっていない。そのまま再試行できる
 *   ⑤で失敗 — 署名鍵は変わり、全員（本人含む）の解除が切れる。
 *              **合言葉が変わったかどうかは分からない** — 例外は要求が届かなかった
 *              場合にも、書き込みが済んで応答だけ失われた場合にも出る。
 *              解除し直して再試行する（新しい合言葉が通らなければ元の合言葉）
 *
 * **この順序でも、⑤の曖昧さは消せない**（SSM にトランザクションは無い）。
 * 消せるのは④のほうで、**先に書くのが署名鍵だからこそ「何も変わっていない」と
 * 言い切れる**。逆の順序（合言葉を先に書く）にすると、1本目で同じ曖昧さが出たうえ、
 * そこで止まれば署名鍵が古いまま合言葉だけ変わった状態になる。
 * 利用者は失敗と聞いて元の合言葉を試すため入れず、**解除の導線も出ない**。
 * 原子性ではなく「曖昧さを1か所に寄せ、そこでは解除し直しを案内できる」形で解く。
 *
 * ③の時点ではトークンは無害。署名鍵がまだ SSM のどこにも無いので、④が失敗すれば
 * このトークンはどのコンテナでも検証を通らない。
 */

import { randomBytes } from 'node:crypto';
import type { APIGatewayProxyResult } from 'aws-lambda';
import { isActiveOwner } from '../../../shared/masters';
import { normalizePassphrase, passphraseRejectionReason } from '../../../shared/passphrasePolicy';
import { passphraseMatches } from '../auth/passphrase';
import { forceRefreshUnlockSecrets, writeUnlockSecret } from '../auth/secrets';
import { issueToken } from '../auth/token';
import { config } from '../config';
import { errorResponse, jsonResponse } from '../http';
import { loadMasters } from '../masters';
import { parseJsonObject, requiredString } from '../validate';
import type { AuthedContext } from './context';

/** 署名鍵の長さ。`openssl rand -base64 32`（手動投入時の手順）と揃えてある */
const SIGNING_KEY_BYTES = 32;

type ChangeRequest = { currentPassphrase: string; newPassphrase: string };

function parseRequest(body: string | null): ChangeRequest | null {
  const source = parseJsonObject(body);
  if (source === null) return null;

  const currentPassphrase = requiredString(source, 'currentPassphrase');
  const newPassphrase = requiredString(source, 'newPassphrase');
  if (currentPassphrase === null || newPassphrase === null) return null;

  return { currentPassphrase, newPassphrase };
}

export async function postPassphrase(context: AuthedContext): Promise<APIGatewayProxyResult> {
  const origin = context.origin;
  const userName = context.identity.userName;

  const request = parseRequest(context.body);
  if (request === null) {
    // 形式で弾いた事実だけを残す（理由は unlock.ts の同じ箇所を参照）。中身は書かない
    console.log(
      JSON.stringify({ message: 'passphrase change rejected', userName, reason: 'malformed request' }),
    );
    return errorResponse(origin, 400, 'リクエストの形式が正しくありません');
  }

  // --- ① 担当者の確認と、現在の合言葉の照合 ---------------------------------

  /**
   * **キャッシュを信用せず、毎回読み直す**（`unlock.ts` と同じ扱い）。
   *
   * 当初はキャッシュから読み、一致しなかったときだけ読み直していた。
   * しかしそれだと**古い合言葉が「現在の合言葉」として通ってしまう** —
   * 古い値を持つコンテナでは最初の照合で一致してしまい、読み直しの経路に入らない
   * （セルフレビューで発見）。
   *
   * 実害が大きい。誰かが合言葉を変えた直後に、**変更前の合言葉を知っている人が
   * 古い値のまま変更を実行できる**（古いトークンも最大5分は通る）。結果として
   * 直前の変更が巻き戻り、変更した本人が締め出される。
   *
   * **解除より権限の強い操作なのに、解除より緩い読み方をしていた**のが誤り。
   *
   * さらに、連打対策の**上限にも縛られない**読み方を使う（`forceRefreshUnlockSecrets`）。
   * 上限のある読み方だと、誤った解除を短時間に繰り返して本数を使い切らせるだけで、
   * 同じ「古い合言葉が通る」状態を意図的に作れてしまう。
   * この経路は有効なトークンが要るので、資格なしに大量には叩けない。
   */
  const [secrets, masters] = await Promise.all([forceRefreshUnlockSecrets(), loadMasters()]);

  /**
   * **無効化された担当者は変更できない。**
   *
   * 当初は「トークンが通っている＝権限の根拠」として再確認しない方針だったが、
   * この経路だけは**新しいトークンを発行する**ので他の書き込み系と性質が違う。
   * 再確認しないと、無効化された担当者が「合言葉を変える」だけで自分のトークンを
   * 何度でも更新でき、`unlock` の `isActiveOwner` による締め出しを迂回できる
   * （セルフレビューで発見）。**担当者の無効化は人を外すための手段**なので、
   * その人が共有の合言葉を変えられるのは逆立ちしている。
   */
  if (!isActiveOwner(masters, userName)) {
    console.log(JSON.stringify({ message: 'passphrase change rejected', userName, reason: 'inactiveOwner' }));
    return errorResponse(origin, 403, '担当者が無効化されているため、この操作はできません');
  }

  const stored = secrets.passphrase;
  const currentOk = passphraseMatches(request.currentPassphrase, stored);

  if (!currentOk) {
    /**
     * **本数は消費しない。** この経路の読み直しは上限に縛られていないので、
     * ここで数えると、有効なトークンを持つ相手が誤った合言葉を繰り返すだけで
     * 解除側の読み直しを痩せさせられる（他人に影響を出せてしまう）。
     */
    /**
     * 失敗も記録する（CLAUDE.md §8-7）。解除中の端末からしか到達できない操作なので、
     * ここが並ぶのは端末が放置されている兆候になる。**合言葉の値は書かない。**
     */
    console.log(JSON.stringify({ message: 'passphrase change rejected', userName, reason: 'currentMismatch' }));
    return errorResponse(origin, 403, '現在の合言葉が違います');
  }

  /**
   * 新しい合言葉の要件（shared/passphrasePolicy.ts）。**判定はここが正**で、
   * 画面側の同じ判定は誤りを早く知らせるためのもの（CLAUDE.md §7）。
   */
  const rejection = passphraseRejectionReason(request.newPassphrase, stored);
  if (rejection !== null) {
    console.log(JSON.stringify({ message: 'passphrase change rejected', userName, reason: 'policy' }));
    return errorResponse(origin, 400, rejection);
  }

  // --- ②③ 鍵とトークンを先に作る（まだ何も永続化していない） -----------------

  const newSigningKey = randomBytes(SIGNING_KEY_BYTES).toString('base64');
  const { token, expiresAt } = issueToken(newSigningKey, userName, config.tokenTtlSeconds);

  // --- ④ 署名鍵の保存 -------------------------------------------------------

  try {
    await writeUnlockSecret('signingKey', newSigningKey);
  } catch (error) {
    console.error(JSON.stringify({ message: 'passphrase change failed', userName, stage: 'token-secret' }), error);
    return errorResponse(origin, 500, '合言葉を変更できませんでした。もう一度お試しください', {
      stage: 'none',
    });
  }

  // --- ⑤ 合言葉の保存 -------------------------------------------------------

  try {
    /**
     * **保存するのは正規化した値。** `passphraseRejectionReason` が見たのも
     * 正規化後の文字列なので、判定した値と保存する値が一致する。
     * 照合側（`passphraseMatches`）も同じ関数を通る（shared/passphrasePolicy.ts）。
     */
    await writeUnlockSecret('passphrase', normalizePassphrase(request.newPassphrase));
  } catch (error) {
    /**
     * **ここだけは人が気づく必要がある。**
     * 署名鍵は変わっており、全員の解除が切れている。原因が分からないと
     * 「突然みんなログアウトした」で終わる。
     *
     * **合言葉が変わったかどうかは、ここからは分からない。**
     * 例外は「要求が届かなかった」場合だけでなく「書き込みは終わったが応答が
     * 返らなかった」場合にも出る。**断定できるのは④まで**（署名鍵は必ず変わった）で、
     * ⑤は新旧どちらの可能性もある。案内は両方に耐える書き方にする
     * — 同じファイルの通信エラーの案内が既にそうしているのと揃える。
     */
    console.error(
      JSON.stringify({ message: 'passphrase change failed after token-secret rotation', userName, stage: 'passphrase' }),
      error,
    );
    return errorResponse(
      origin,
      500,
      '合言葉は変更されている可能性があります。解除が切れるので、新しい合言葉で解除し直し、入れない場合は元の合言葉をお試しください',
      { stage: 'secret-rotated' },
    );
  }

  /**
   * 成功の記録（CLAUDE.md §8-7）。**新旧どちらの合言葉も書かない。**
   * 残すのは「誰が・いつ変えたか」だけで、それが監査に要る全部。
   */
  console.log(JSON.stringify({ message: 'passphrase changed', userName, expiresAt }));

  // --- ⑥ 先に作っておいたトークンを返す -------------------------------------

  return jsonResponse(origin, 200, {
    token,
    expiresAt,
    expiresInSeconds: config.tokenTtlSeconds,
  });
}
