/**
 * POST /auth/unlock — 生産技術モードの解除（F-18 / docs/API.md）。
 *
 * 氏名と合言葉を受け取り、両方を検証してから短期トークンを返す。
 * **検証はここが正。** 画面側にも同じ検証があるが、あれは誤りを早く知らせるためのもので、
 * 開発者ツールから直接呼ばれれば回避できる（CLAUDE.md §7 の検証の二重化）。
 */

import type { APIGatewayProxyResult } from 'aws-lambda';
import { isActiveOwner } from '../../../shared/masters';
import { passphraseMatches } from '../auth/passphrase';
import { getUnlockSecrets, refreshUnlockSecrets } from '../auth/secrets';
import { issueToken } from '../auth/token';
import { config } from '../config';
import { errorResponse, jsonResponse } from '../http';
import { loadMasters } from '../masters';
import { parseJsonObject, requiredString } from '../validate';
import type { PublicContext } from './context';

/**
 * どちらが誤りかを示さない（docs/screens.md S-2）。
 * 氏名だけ当たっていると分かると、合言葉の総当たりの足がかりになる。
 */
const UNLOCK_ERROR = '氏名または合言葉が違います';

type UnlockRequest = { userName: string; passphrase: string };

function parseRequest(body: string | null): UnlockRequest | null {
  const source = parseJsonObject(body);
  if (source === null) return null;

  const userName = requiredString(source, 'userName');
  const passphrase = requiredString(source, 'passphrase');
  if (userName === null || passphrase === null) return null;

  return { userName, passphrase };
}

export async function postUnlock(context: PublicContext): Promise<APIGatewayProxyResult> {
  const origin = context.origin;

  const request = parseRequest(context.body);
  if (request === null) {
    return errorResponse(origin, 400, 'リクエストの形式が正しくありません');
  }

  /**
   * マスタの取得も同じ `Promise.all` に入れる。
   *
   * SSM の2本とマスタの Scan は互いに依存しないので、直列にする理由がない。
   * 短縮されるのは主にコールドスタート時だが、**順序を変えても下のタイミング差対策は
   * 保たれる** — 対策の中身は「両方を評価してから判定する」ことであって、
   * 評価の順番ではないため。
   */
  const [secrets, masters] = await Promise.all([getUnlockSecrets(), loadMasters()]);

  /**
   * **2つの判定をどちらも評価してから結果を出す。**
   *
   * 氏名が存在しない時点で早く返すと、応答時間の差から
   * 「この氏名は実在する／しない」が読み取れてしまう。
   * 同じ 401・同じ本文を返しても、速さで区別が付いては意味がない。
   * どちらかが false でも打ち切らず、最後の1回だけで判定する。
   */
  let passphraseOk = passphraseMatches(request.passphrase, secrets.passphrase);
  const ownerExists = isActiveOwner(masters, request.userName);

  /** トークンの署名に使う鍵。読み直したときは、合言葉と対で新しくなったほうを使う */
  let signingKey = secrets.signingKey;

  /**
   * 失敗したら SSM を読み直して照合し直す（F-20）。
   *
   * 合言葉は画面から変更できる。**変更を書き込めるのは実行した1つのコンテナだけ**で、
   * 他のコンテナは最大5分（auth/secrets.ts の CACHE_TTL_MS）古い値を持つ。読み直さないと
   * 「変更したのに新しい合言葉で解除できない」が最大5分続き、利用者からは不具合に見える。
   *
   * **引き金を「合言葉の不一致」ではなく「失敗したこと」にしてある。**
   * 不一致だけを条件にすると、氏名が誤りのときは読み直しが起きずに速く返り、
   * 合言葉が誤りのときだけ遅くなる。**応答時間からどちらが誤りかが読めてしまい**、
   * 上で守っている性質がここで崩れる。どちらの失敗でも同じ経路を通す。
   *
   * 読み直しは対で行われるので、**合言葉が新しくなったなら署名鍵も必ず新しい**。
   * 古い鍵でトークンを発行してしまう経路が残らない（auth/secrets.ts）。
   */
  if (!ownerExists || !passphraseOk) {
    const latest = await refreshUnlockSecrets();
    passphraseOk = passphraseMatches(request.passphrase, latest.passphrase);
    signingKey = latest.signingKey;
  }

  if (!ownerExists || !passphraseOk) {
    // 失敗の記録には合言葉を書かない。氏名も、実在しない場合は攻撃者の入力そのものなので
    // ログに残す価値より、そのまま出すことの副作用（ログ汚染）のほうが大きい
    console.log(
      JSON.stringify({
        message: 'unlock rejected',
        ownerExists,
        passphraseOk,
      })
    );
    return errorResponse(origin, 401, UNLOCK_ERROR);
  }

  const { token, expiresAt } = issueToken(
    signingKey,
    request.userName,
    config.tokenTtlSeconds
  );

  console.log(
    JSON.stringify({
      message: 'unlock granted',
      userName: request.userName,
      expiresAt,
    })
  );

  /**
   * `expiresInSeconds` も返す。
   *
   * `expiresAt` はサーバーが生成した絶対時刻なので、画面がこれを自分の時計と
   * 引き算すると**2つの時計をまたぐ**ことになる。端末の時計が2時間以上進んでいると
   * 解除した直後にセッションが切れ、「解除しても解除されない」状態になる
   * （遅れていれば逆に期限を越えて生き残る）。
   *
   * 秒数で渡せば、画面は `Date.now() + 秒数` として**自分の時計だけで完結**できる。
   * `expiresAt` は残す — 画面表示や、ログと突き合わせるときに絶対時刻のほうが読みやすい。
   */
  return jsonResponse(origin, 200, {
    token,
    expiresAt,
    expiresInSeconds: config.tokenTtlSeconds,
  });
}
