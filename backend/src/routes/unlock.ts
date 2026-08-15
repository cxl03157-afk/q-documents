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
import { noteRefreshDidNotHelp, refreshUnlockSecrets } from '../auth/secrets';
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
    /**
     * **記録を残す。** ここは合言葉の照合まで到達していないので、以前は 400 を返しつつ
     * ログに1行も残らなかった。実際にそれで切り分けに手間取った — 画面から空の合言葉が
     * 送られたとき、サーバー側には「リクエストが来た」以外の痕跡が無く、
     * 401（合言葉が違う）なのか 400（形式が不正）なのかがログから判別できなかった。
     *
     * **中身は書かない。** ここへ来る値は検証を通っていない入力そのもので、
     * 合言葉が含まれている可能性がある。残すのは「形式で弾いた」という事実だけでよい。
     */
    console.log(JSON.stringify({ message: 'unlock rejected', reason: 'malformed request' }));
    return errorResponse(origin, 400, 'リクエストの形式が正しくありません');
  }

  /**
   * **解除のたびに SSM を読み直す**（キャッシュを信用しない）。
   *
   * 照合が成功したときだけ読み直しを飛ばす形にしていたが、それだと
   * **古い合言葉で成功したときに、古い署名鍵でトークンを発行してしまう**。
   * 発行した本人は解除できたつもりでも、そのトークンは他のコンテナで 401 になり、
   * 次の操作でいきなり解除が切れる（セルフレビューで発見）。
   *
   * 解除は利用者が1日に数回行うだけの操作なので、毎回2本読んでも負荷にならない。
   * **頻度の高いトークン検証（requireToken.ts）とは扱いを変える** — あちらは
   * 全リクエストで通るため、キャッシュを外せない。
   *
   * 成功・失敗のどちらでも同じ経路を通るので、応答時間から
   * 「氏名と合言葉のどちらが誤りか」が読めない性質も保たれる。
   *
   * マスタの Scan を同じ `Promise.all` に入れるのは、互いに依存しないため。
   * **順序を変えても下のタイミング差対策は保たれる** — 対策の中身は
   * 「両方を評価してから判定する」ことであって、評価の順番ではない。
   */
  const [secrets, masters] = await Promise.all([refreshUnlockSecrets(), loadMasters()]);

  /**
   * **2つの判定をどちらも評価してから結果を出す。**
   *
   * 氏名が存在しない時点で早く返すと、応答時間の差から
   * 「この氏名は実在する／しない」が読み取れてしまう。
   * 同じ 401・同じ本文を返しても、速さで区別が付いては意味がない。
   * どちらかが false でも打ち切らず、最後の1回だけで判定する。
   */
  const passphraseOk = passphraseMatches(request.passphrase, secrets.passphrase);
  const ownerExists = isActiveOwner(masters, request.userName);

  if (!ownerExists || !passphraseOk) {
    /**
     * 読み直したうえで拒否した、と伝える（本数を1つ使う）。
     * **成功した解除では呼ばない** — 正しい合言葉は攻撃者には出せないので、
     * 連打対策の本数を消費させる理由がない（auth/secrets.ts）。
     */
    noteRefreshDidNotHelp();

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
    secrets.signingKey,
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
