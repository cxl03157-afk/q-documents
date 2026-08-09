/**
 * ルートに渡す文脈と、ルート表の型。
 *
 * **`auth` を省略できない3値にしてある。** これがこのファイルの主目的で、
 * トークン検証の書き忘れを型で止めるための仕掛け（docs/context.md 8/10 の決定）。
 *
 * 各ハンドラの中で検証する方式は採らない。1本でも書き忘れると、その瞬間に
 * 台帳が誰でも触れる状態になる。しかも壊れ方が「余計に通ってしまう」なので、
 * 正常系のテストでは絶対に気づけない（失敗して初めて分かる類の誤りではない）。
 *
 * さらに `auth` の値ごとにハンドラの引数を変えてある。判別可能ユニオンなので、
 * 表に書いた `auth` と、ハンドラが受け取れるものが必ず対応する。
 *
 *   public      — `identity` という項目が存在しない。読もうとすると型エラー
 *   required    — `identity` が必ず入る。`null` の分岐を書く必要がない
 *   conditional — `identity` が `null` になりうる。分岐の省略が型エラーになる
 *
 * 「required なのに null チェックを書いてしまう」「public なのに身元を見る」が
 * どちらもコンパイルで止まる。
 */

import type { APIGatewayProxyResult } from 'aws-lambda';
import type { Identity } from '../auth/requireToken';

type BaseContext = {
  /** リクエストの Origin。CORS ヘッダーの組み立てに要る */
  origin: string;

  body: string | null;

  /** パスから取り出した値。例: `/documents/{docNo}/revisions` の `docNo` */
  params: Record<string, string>;
};

/** 合言葉を見ないルート。身元を受け取る手段が無い */
export type PublicContext = BaseContext;

/** 合言葉が要るルート。検証済みの身元が必ず入る */
export type AuthedContext = BaseContext & { identity: Identity };

/** トークンの有無で応答が変わるルート。無ければ `null` */
export type MaybeAuthedContext = BaseContext & { identity: Identity | null };

type Handler<C> = (context: C) => Promise<APIGatewayProxyResult>;

/**
 * ルート1本。`docs/API.md` の1行に対応する。
 *
 * `pattern` は名前付きグループ付きの正規表現にする。`/documents/{docNo}/revisions` のような
 * パス変数を含むルートがあり、文字列の完全一致では表せないため。
 * `^` と `$` で全体を縛るのを忘れないこと（部分一致だと別のパスまで拾う）。
 */
export type Route =
  | { method: string; pattern: RegExp; auth: 'public'; handler: Handler<PublicContext> }
  | { method: string; pattern: RegExp; auth: 'required'; handler: Handler<AuthedContext> }
  | {
      method: string;
      pattern: RegExp;
      auth: 'conditional';
      handler: Handler<MaybeAuthedContext>;
    };
