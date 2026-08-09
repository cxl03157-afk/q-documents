/**
 * Lambda へ送るバンドルを作る。
 *
 * esbuild のオプションが一行に収まらなくなったのでスクリプトに分けた。
 * 分けた本当の理由は banner で、**なぜこれが要るのかはコード自体からは読めない**ため。
 */

import { build } from 'esbuild';

await build({
  entryPoints: ['src/index.ts'],
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  outfile: 'dist/index.mjs',

  /**
   * **AWS SDK をバンドルに同梱する**（external にしない）。
   *
   * SDK v3 は nodejs22.x のランタイムに入っているので外部化すればバンドルは
   * 数KBで済む。それでも同梱するのは、ランタイム側の SDK バージョンが AWS の都合で
   * 更新されるため。外部化すると、こちらが何も変更していないのに動作が変わりうる。
   * 同梱すれば package-lock.json で固定したバージョンがそのまま動く。
   * これは AWS 自身が推奨している方針でもある。
   *
   * 代償はサイズ（1.7MB / zip 282KB）だが、Lambda の上限は zip 50MB なので問題にならない。
   */

  /**
   * **この banner が無いと実行時に落ちる。**
   *
   * AWS SDK v3 の CJS ビルドは `require("node:https")` のような動的 require を含む。
   * esbuild が ESM 形式で出力すると、その require を解決できず
   * `Dynamic require of "node:https" is not supported` で初期化に失敗する。
   * ESM には require が無いので、createRequire で作って渡す。
   *
   * external にしていた間は SDK がバンドルに入らないため表面化しなかった。
   * 同梱に切り替えたときにローカルのスモークテストで再現した問題で、
   * **入れ忘れると Lambda の初期化エラー（画面には 500）になる。**
   */
  banner: {
    js: [
      "import { createRequire as __createRequire } from 'node:module';",
      'const require = __createRequire(import.meta.url);',
    ].join('\n'),
  },
});
