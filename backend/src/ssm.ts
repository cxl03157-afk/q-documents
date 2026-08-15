/**
 * SSM Parameter Store への読み書き（SecureString）。
 *
 * 合言葉と署名鍵はここからしか取らない。コード・Terraform state・環境変数には
 * 平文で置かない（CLAUDE.md §8-1）。
 *
 * **キャッシュはここに置かない。** 合言葉と署名鍵は F-20 で必ず同時に更新されるため、
 * 名前ごとに別々の期限で持つと2つがずれる。期限の管理は「対で1つ」を保証できる
 * `auth/secrets.ts` に置き、ここは SSM との入出力だけを担当する。
 */

import { GetParameterCommand, PutParameterCommand, SSMClient } from '@aws-sdk/client-ssm';

const client = new SSMClient({});

/**
 * Terraform が入れ物を作るときに置く仮の値（infra/ssm.tf と対になっている）。
 *
 * **この値のまま動かさない。** 実値の投入は `aws ssm put-parameter` の手作業なので、
 * 環境を作り直したときに忘れうる。忘れたまま動くと
 *   合言葉   — リポジトリを読んだ誰でも解除できる（public リポジトリに載っている文字列）
 *   署名鍵   — 鍵が既知になり、トークンを手元で偽造できる
 * という状態になり、しかもアプリは正常に動いているように見えて警告が出ない。
 *
 * ここで弾けば、投入忘れが Lambda の初期化エラーとして即座に表面化する。
 * infra/ssm.tf の value を変えるときは、この定数も合わせること。
 */
const PLACEHOLDER_VALUE = 'PLACEHOLDER_SET_VIA_CLI';

/** SSM から読み出して検証する。キャッシュの判断は呼び出し側（auth/secrets.ts）が行う */
export async function getSecureParameter(name: string): Promise<string> {
  const response = await client.send(
    new GetParameterCommand({ Name: name, WithDecryption: true })
  );

  const value = response.Parameter?.Value;
  if (value === undefined || value === '') {
    throw new Error(`SSM パラメータ ${name} の値が空です`);
  }
  if (value === PLACEHOLDER_VALUE) {
    throw new Error(
      `SSM パラメータ ${name} が Terraform の仮の値のままです。` +
        `aws ssm put-parameter --name ${name} --type SecureString --value '<値>' --overwrite で投入してください`
    );
  }

  return value;
}

/**
 * SecureString を書き込む（F-20）。
 *
 * `Type` を毎回指定するのは、`Overwrite: true` でも省略すると型が引き継がれず
 * エラーになる場合があるため。SecureString 以外をここから書くことはない。
 *
 * ---
 *
 * **`Description` は渡さない（渡さなくても消えないことを本番で実測済み）。**
 *
 * 「上書きすると Terraform（infra/ssm.tf）が設定した説明が消え、以後 plan に
 * 差分が出続ける」という指摘を複数回受けたが、**再現しない**。
 * 2026/8/15 に画面から合言葉を変更（両パラメータとも Version 2 → 3）したあと、
 *
 *   aws ssm describe-parameters   → 2本とも Description は元のまま
 *   terraform plan                → SSM パラメータの差分なし（0 to add, 1 to change・
 *                                    その1件は Lambda の関数コード）
 *
 * を確認した。説明をここへ持ち込むと、SSM の入出力だけを担うこのファイルが
 * パラメータごとの文言を知ることになる。**実測で否定できている以上、その結合は作らない。**
 * 将来 AWS の挙動が変わって plan に差分が出たら、そのときに渡せばよい。
 */
export async function putSecureParameter(name: string, value: string): Promise<void> {
  await client.send(
    new PutParameterCommand({
      Name: name,
      Value: value,
      Type: 'SecureString',
      Overwrite: true,
    })
  );
}
