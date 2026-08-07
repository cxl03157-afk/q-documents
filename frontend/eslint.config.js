// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

// 型情報を使う `recommended-type-checked` は採らない。tsconfig の `project` 参照が要り、
// shared/ が frontend/ の外にあることに起因する解決問題（vite.config.ts 参照）を lint 側でも
// 踏むことになるため。構文レベルの `recommended` で今は十分と判断している。
export default tseslint.config(js.configs.recommended, tseslint.configs.recommended, {
  rules: {
    // テンプレートリテラルの中身は日本語UI文字列（全角スペース等）を意図的に含むため対象外にする。
    // コード本体（テンプレートリテラルの外）のチェックは有効なまま。
    'no-irregular-whitespace': ['error', { skipTemplates: true }],
  },
  ignores: ['dist/**'],
});
