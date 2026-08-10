/**
 * 環境変数の読み出し。Terraform（infra/lambda.tf）から渡される。
 *
 * **モジュールの読み込み時に検証して、足りなければその場で落とす。**
 * リクエストのたびに `?? ''` で握りつぶすと、設定漏れが「合言葉がいつも一致しない」
 * といった別の症状に化けて原因が見えなくなる。初期化で落ちればログに理由がそのまま出る。
 *
 * 値そのもの（合言葉・署名鍵）は環境変数では渡さない。Lambda の環境変数はコンソールから
 * 平文で見え、Terraform state にも残る（CLAUDE.md §8-1）。ここで渡すのは
 * **SSM パラメータの名前**だけで、値は実行時に SSM から読む。
 */

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`環境変数 ${name} が設定されていません`);
  }
  return value;
}

function requiredPositiveInt(name: string): number {
  const raw = required(name);
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`環境変数 ${name} は正の整数である必要があります: ${raw}`);
  }
  return value;
}

export const config = {
  mastersTable: required('MASTERS_TABLE'),

  /** 文書台帳。PK = 製品コード / SK = 文書ID#リビジョン（docs/DynamoDBテーブル設計.md） */
  ledgerTable: required('LEDGER_TABLE'),

  /**
   * PDF・エクセルの実体を置く S3 バケット。署名付きURLの発行に要る。
   *
   * バケット名を直書きしないのは、名前にランダムな接尾辞が入っている
   * （`q-documents-files-0662035f`）ため。作り直すと変わる。
   */
  filesBucket: required('FILES_BUCKET'),

  /**
   * CORS で許可する画面のオリジン1つ。ワイルドカードは使わない（docs/API.md）。
   *
   * **ここに寄せているのは、欠けたときの症状が最も分かりにくいため。**
   * 空のまま動くと Lambda は正常に起動して 200 を返すのに、応答に
   * `access-control-allow-origin` が付かず、ブラウザ側だけが全滅する。
   * 書き込み系はプリフライトの段階で止まるので本リクエストのログすら残らない。
   * 初期化で落としてしまえば、CloudWatch Logs の1行目に理由が出る。
   */
  allowedOrigin: required('ALLOWED_ORIGIN'),

  /** 合言葉を置いた SSM パラメータ名（SecureString） */
  passphraseParam: required('PASSPHRASE_PARAM'),

  /**
   * トークンの署名鍵を置いた SSM パラメータ名（SecureString）。
   *
   * **合言葉とは別の値にする。** 合言葉を署名鍵に流用すると、合言葉を変えた瞬間に
   * 解除中のセッションが全部無効になり、作業の途中で突然ロックされる。
   * 鍵を分けておけば、合言葉の変更とセッションの継続が独立する。
   */
  tokenSecretParam: required('TOKEN_SECRET_PARAM'),

  /**
   * トークンの有効期間（秒）。
   *
   * 画面側の「30分の無操作で自動ロック」とは目的が違うので、同じ値にしない。
   *   画面側 — 席を立った隙に使われないための離席対策
   *   ここ   — 盗まれたトークンが使われ続けないための上限
   * 同じ30分にすると、30分続けて操作している最中に切れてしまう。
   */
  tokenTtlSeconds: requiredPositiveInt('TOKEN_TTL_SECONDS'),
};
