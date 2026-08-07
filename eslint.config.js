// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

// 設定ファイルをリポジトリルートに置いている。
// ESLint 9 以降の flat config は、設定ファイルの置き場所より外側を lint 対象にできない
// （basePath）。frontend/ に置いていた頃は shared/ が対象外だったが、npm workspaces 化で
// node_modules がルートに1つになり、ルートから eslint を解決できるようになったため移した。
// これで frontend / backend / shared の3つが同じルールで lint される。
//
// 型情報を使う `recommended-type-checked` は採らない。tsconfig の `project` 参照が要り、
// プロジェクトが3つに分かれている構成では設定が重くなるため。構文レベルの `recommended` で
// 今は十分と判断している。

export default tseslint.config(
  // ignores だけを持つオブジェクトは「全体の除外」として扱われる。
  // rules などと同じオブジェクトに書くと、そのオブジェクトのルールが効かなくなるだけで
  // 他の config からは lint されてしまう。
  { ignores: ['**/dist/**', 'infra/**'] },

  js.configs.recommended,
  tseslint.configs.recommended,
  {
    rules: {
      // テンプレートリテラルの中身は日本語UI文字列（全角スペース等）を意図的に含むため対象外にする。
      // コード本体（テンプレートリテラルの外）のチェックは有効なまま。
      'no-irregular-whitespace': ['error', { skipTemplates: true }],
    },
  }
);
