/**
 * **非同期Lambda（S3イベント）** が使う環境変数。Terraform（infra/lambda.tf）から渡される。
 *
 * 同期API用の config.ts は import しない。あちらは7本すべてを読み込み時に検証するので、
 * 使いもしない ALLOWED_ORIGIN や PASSPHRASE_PARAM が無いという理由で初期化に失敗する。
 * 検証の強さは変えたくないので、読み方（env.ts）だけを共有して宣言を分けている。
 *
 * **この Lambda に必要なのは2本だけ。** 合言葉もトークンも扱わない
 * — クライアントから直接呼ばれるエンドポイントを持たないため（CLAUDE.md §7）。
 */

import { required } from '../env';

export const asyncConfig = {
  /** 文書台帳。PK = 製品コード / SK = 文書ID#リビジョン */
  ledgerTable: required('LEDGER_TABLE'),

  /** PDF・エクセルの実体を置くバケット。旧版のストレージクラス変更に要る */
  filesBucket: required('FILES_BUCKET'),
};
