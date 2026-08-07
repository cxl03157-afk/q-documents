/**
 * SSM Parameter Store からの読み出し（SecureString）。
 *
 * 合言葉と署名鍵はここからしか取らない。コード・Terraform state・環境変数には
 * 平文で置かない（CLAUDE.md §8-1）。
 */

import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';

const client = new SSMClient({});

/**
 * 読み出した値のキャッシュ。
 *
 * Lambda の実行環境は再利用されるので、モジュールスコープに置けばコンテナが
 * 生きている間は SSM を呼ばずに済む。SSM の GetParameter には秒あたりの上限があり、
 * リクエストのたびに呼ぶとそこが先に詰まる。
 *
 * **ただし期限を付ける。** 無期限だと、合言葉を差し替えても暖まったコンテナが
 * 古い値を持ち続け、「変えたのに古い合言葉で入れる」状態が最大で数時間続く。
 * 5分にしておけば、差し替えの反映を待つ時間が読める。
 */
const CACHE_TTL_MS = 5 * 60 * 1000;

type CacheEntry = { value: string; fetchedAt: number };
const cache = new Map<string, CacheEntry>();

export async function getSecureParameter(name: string): Promise<string> {
  const cached = cache.get(name);
  if (cached !== undefined && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.value;
  }

  const response = await client.send(
    new GetParameterCommand({ Name: name, WithDecryption: true })
  );

  const value = response.Parameter?.Value;
  if (value === undefined || value === '') {
    throw new Error(`SSM パラメータ ${name} の値が空です`);
  }

  cache.set(name, { value, fetchedAt: Date.now() });
  return value;
}
