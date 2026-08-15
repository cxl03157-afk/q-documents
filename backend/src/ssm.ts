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
