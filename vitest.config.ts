import { defineConfig } from 'vitest/config';

// テストはリポジトリ全体でこの1本にまとめる。
// npm workspaces 化するまでは frontend/vite.config.ts の test セクションで動かしていたが、
// shared/ と backend/ のテストも同じ実行に含めたいため、ルートへ移した。
// frontend/vite.config.ts は dev サーバーとビルドの設定だけを持つ形に戻してある。
export default defineConfig({
  test: {
    include: [
      'shared/**/*.test.ts',
      'frontend/src/**/*.test.ts',
      'backend/src/**/*.test.ts',
    ],

    /**
     * backend/src/config.ts は**読み込み時に**環境変数を検証して、足りなければ落ちる。
     * 設定漏れを別の症状に化けさせないための設計なので、テストのために緩めない
     * （8/9 のレビューで ALLOWED_ORIGIN の欠落を検出できた仕組み）。
     *
     * 代わりにここでダミーを与える。値は使わない — ルート表のテストが
     * ハンドラを import した時点で config が読み込まれてしまうだけで、
     * DynamoDB も SSM もテストからは呼ばない。
     */
    env: {
      MASTERS_TABLE: 'test-masters',
      LEDGER_TABLE: 'test-ledger',
      ALLOWED_ORIGIN: 'https://example.invalid',
      PASSPHRASE_PARAM: '/test/passphrase',
      TOKEN_SECRET_PARAM: '/test/token-secret',
      TOKEN_TTL_SECONDS: '7200',
    },
  },
});
