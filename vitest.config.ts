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
  },
});
