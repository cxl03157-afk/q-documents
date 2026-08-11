/**
 * 環境変数を読み出す道具。**値の定義は置かない。**
 *
 * ---
 *
 * **なぜ config.ts から切り出したか。**
 *
 * この backend には Lambda が2つある（CLAUDE.md §7）。
 *
 *   同期API Lambda     — src/index.ts        必要な環境変数は7本
 *   非同期Lambda（S3イベント） — src/async/index.ts  必要な環境変数は2本
 *
 * config.ts は**読み込み時に7本すべてを検証して、足りなければその場で落とす**。
 * 非同期Lambdaが config.ts を import すると、使いもしない ALLOWED_ORIGIN や
 * PASSPHRASE_PARAM が無いという理由で**初期化に失敗する**。
 * かといって config.ts の検証を緩めると、8/9 のレビューで ALLOWED_ORIGIN の欠落を
 * 検出できた仕組みそのものが消える。
 *
 * そこで「読み方」だけをここに置き、「何が必要か」は各 Lambda が自分で宣言する。
 * 検証の強さは変えずに、必要な範囲だけを検証できる。
 */

/**
 * 必須の文字列。空文字も未設定と同じに扱う。
 *
 * リクエストのたびに `?? ''` で握りつぶすと、設定漏れが「合言葉がいつも一致しない」
 * といった別の症状に化けて原因が見えなくなる。初期化で落ちればログに理由がそのまま出る。
 */
export function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`環境変数 ${name} が設定されていません`);
  }
  return value;
}

/** 必須の正の整数。`Number.isInteger` は NaN と Infinity と小数をまとめて弾く */
export function requiredPositiveInt(name: string): number {
  const raw = required(name);
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`環境変数 ${name} は正の整数である必要があります: ${raw}`);
  }
  return value;
}
