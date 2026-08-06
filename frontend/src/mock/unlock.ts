/**
 * モックの合言葉照合。週2で `POST /auth/unlock` に差し替える。
 *
 * **ここにある値は本番の合言葉ではない。** 誰が見てもダミーと分かる文字列にしてある。
 * 本番の合言葉は SSM Parameter Store（SecureString）に置き、コード・Terraform state・
 * リポジトリに平文で置かない（CLAUDE.md §8-1）。
 *
 * 合言葉の検証はサーバー側が正（CLAUDE.md §8-6）。画面側のこの関数は、モック段階で
 * 解除フローの遷移を確かめるためだけのもので、本実装では残さない。
 * 照合を画面のコードに書かずこのファイルに隔離してあるのは、差し替え箇所を1つにするため。
 */

const MOCK_PASSPHRASE = 'mock-passphrase';

export type UnlockResult = { ok: true; token: string } | { ok: false };

export function mockUnlock(userName: string, passphrase: string): UnlockResult {
  if (userName === '' || passphrase !== MOCK_PASSPHRASE) {
    return { ok: false };
  }
  return { ok: true, token: `mock-token-${Date.now()}` };
}
