import { defineConfig } from 'vite';
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
});
