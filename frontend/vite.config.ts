import { defineConfig, loadEnv } from 'vite';
import { fileURLToPath } from 'node:url';

// shared/ が frontend/ の外（リポジトリルート直下）にあるため、
// 既定の fs.allow（frontend/ 配下のみ）だと 403 になる。リポジトリルートを明示的に許可する。
const repoRoot = fileURLToPath(new URL('..', import.meta.url));

// テストの設定はここに持たない。リポジトリルートの vitest.config.ts が
// shared / frontend / backend のテストをまとめて実行する。
export default defineConfig(({ command, mode }) => {
  // process.cwd() に頼らない。ワークスペースのルートから `npm run dev -w frontend` を
  // 実行したときに .env.local を読み落とし、プロキシが黙って無効になる
  const env = loadEnv(mode, fileURLToPath(new URL('.', import.meta.url)), '');

  /**
   * ローカル開発の API 中継。
   *
   * Lambda の ALLOWED_ORIGIN は CloudFront のドメイン1つだけなので、
   * `npm run dev`（localhost:5173）からブラウザが直接叩くと CORS で必ず弾かれる。
   * かといって localhost を許可オリジンに足すと、**本番の Lambda が
   * localhost からの呼び出しを恒久的に受け付ける**ことになる
   * （この構成は terraform.tfvars が単一の正で、dev と prod の区別が無い）。
   *
   * 中継するのは dev サーバー（Node）なので、**ブラウザから見れば同一オリジン**になり
   * CORS が発生しない。サーバー間の通信に CORS は関係しないため、
   * ALLOWED_ORIGIN も Terraform も一切変更せずに済む（CLAUDE.md §8 に触れない）。
   *
   * 引き換えに、**本番でだけ起きる CORS の不具合を dev では検出できない**。
   * デプロイ後に実ブラウザで確認する運用でしか担保できない。
   *
   * VITE_API_PROXY_TARGET は .env.local にだけ置く（ビルドには埋め込まれない）。
   */
  const proxyTarget = env.VITE_API_PROXY_TARGET;

  /**
   * **設定漏れをここで落とす。**
   *
   * `VITE_API_BASE_URL=/api` なのに中継先が無いと、`/api/...` は dev サーバーの
   * SPA フォールバックに当たって **index.html が HTTP 200 で返る**。
   * 画面には「応答の形式が正しくありません」とだけ出て、原因が .env.local に
   * あることは分からない（型ガードは正しく働いているので、なおさら気づけない）。
   *
   * api.ts が `VITE_API_BASE_URL` の未設定で落とすのと同じ方針に揃える。
   * `serve` のときだけ見るのは、ビルド時は絶対URLが渡される（deploy-frontend.sh）ため。
   */
  if (command === 'serve' && env.VITE_API_BASE_URL?.startsWith('/') && !proxyTarget) {
    throw new Error(
      'VITE_API_BASE_URL が相対パスなのに VITE_API_PROXY_TARGET が未設定です。' +
        'frontend/.env.example を .env.local にコピーして中継先を設定してください',
    );
  }

  return {
    server: {
      fs: {
        allow: [repoRoot],
      },
      proxy: proxyTarget
        ? {
            '/api': {
              target: proxyTarget,
              changeOrigin: true,
              rewrite: (path) => path.replace(/^\/api/, ''),
            },
          }
        : undefined,
    },
  };
});
