// このファイルだけ Node の型（`node:url` など）を使うため、この1ファイルに限定して型を読み込む。
// tsconfig.json の types に "node" を足すと src/ や shared/ にも波及し、
// ブラウザでは存在しない process 等をコンパイラが見逃すようになるため避ける。
/// <reference types="node" />

// vitest の `test` オプションの型を得るため、'vite' ではなく 'vitest/config' から import する
// （vitest/config は vite の defineConfig に test の型定義をマージして再エクスポートしている）
import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

// shared/ が frontend/ の外（リポジトリルート直下）にあるため、
// 既定の fs.allow（frontend/ 配下のみ）だと 403 になる。リポジトリルートを明示的に許可する。
const repoRoot = fileURLToPath(new URL('..', import.meta.url));

export default defineConfig({
  server: {
    fs: {
      allow: [repoRoot],
    },
  },
  test: {
    // shared/ はリポジトリルート直下（frontend/ の外）にあるため、src/ だけでなく明示的に含める。
    include: ['src/**/*.test.ts', '../shared/**/*.test.ts'],
  },
});
