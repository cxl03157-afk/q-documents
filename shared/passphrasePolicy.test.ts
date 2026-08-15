/**
 * 新しい合言葉の要件判定（F-20）の純粋関数テスト（CLAUDE.md「テストを書く範囲」）。
 *
 * 間違えやすいのは境界と、文字数の数え方。`length` で数えると絵文字が2文字になり、
 * 見た目20文字が通らないので、コードポイントで数えていることを確認する。
 */
import { describe, expect, it } from 'vitest';
import {
  MAX_PASSPHRASE_LENGTH,
  MIN_PASSPHRASE_LENGTH,
  passphraseRejectionReason,
} from './passphrasePolicy';

const CURRENT = 'old-passphrase';

describe('passphraseRejectionReason', () => {
  it('要件を満たしていれば null', () => {
    expect(passphraseRejectionReason('newpass1', CURRENT)).toBeNull();
  });

  it('下限ちょうど（8文字）は通る', () => {
    expect(passphraseRejectionReason('a'.repeat(MIN_PASSPHRASE_LENGTH), CURRENT)).toBeNull();
  });

  it('上限ちょうど（20文字）は通る', () => {
    expect(passphraseRejectionReason('a'.repeat(MAX_PASSPHRASE_LENGTH), CURRENT)).toBeNull();
  });

  it('7文字は弾く', () => {
    expect(passphraseRejectionReason('a'.repeat(7), CURRENT)).toBe(
      '新しい合言葉は8〜20文字にしてください',
    );
  });

  it('21文字は弾く', () => {
    expect(passphraseRejectionReason('a'.repeat(21), CURRENT)).toBe(
      '新しい合言葉は8〜20文字にしてください',
    );
  });

  it('空文字は弾く', () => {
    expect(passphraseRejectionReason('', CURRENT)).not.toBeNull();
  });

  /**
   * `length` で数えると 20 を超えて弾かれてしまう入力。
   * サロゲートペア（絵文字）1つが UTF-16 では2単位を占める。
   */
  it('絵文字を含む見た目20文字は通る（コードポイントで数えている）', () => {
    const value = `${'a'.repeat(19)}🙂`;
    expect(Array.from(value).length).toBe(20);
    expect(value.length).toBe(21);
    expect(passphraseRejectionReason(value, CURRENT)).toBeNull();
  });

  it('日本語20文字は通る', () => {
    expect(passphraseRejectionReason('あ'.repeat(20), CURRENT)).toBeNull();
  });

  it('前に半角空白があれば弾く', () => {
    expect(passphraseRejectionReason(' newpass1', CURRENT)).toBe(
      '新しい合言葉の前後に空白を入れないでください',
    );
  });

  it('後ろに半角空白があれば弾く', () => {
    expect(passphraseRejectionReason('newpass1 ', CURRENT)).not.toBeNull();
  });

  it('前後の全角スペースも弾く', () => {
    expect(passphraseRejectionReason('　newpass1', CURRENT)).not.toBeNull();
    expect(passphraseRejectionReason('newpass1　', CURRENT)).not.toBeNull();
  });

  it('後ろの改行・タブも弾く', () => {
    expect(passphraseRejectionReason('newpass1\n', CURRENT)).not.toBeNull();
    expect(passphraseRejectionReason('newpass1\t', CURRENT)).not.toBeNull();
  });

  it('途中の空白は許可する', () => {
    expect(passphraseRejectionReason('new pass 1', CURRENT)).toBeNull();
  });

  it('現在の合言葉と同じなら弾く', () => {
    expect(passphraseRejectionReason(CURRENT, CURRENT)).toBe(
      '新しい合言葉が現在の合言葉と同じです',
    );
  });

  /**
   * 長さの判定を先に行っていることの確認。
   * 現在の合言葉が要件を満たしていない場合（要件を後から足したので起こりうる）、
   * 同じ値を新しい合言葉に入れると「同じです」ではなく長さの理由が返る。
   * どちらの理由でも拒否されることに変わりはないので、順序は問題にならない。
   */
  it('現在の合言葉が短い場合、同じ値を入れると長さの理由が返る', () => {
    expect(passphraseRejectionReason('short', 'short')).toBe(
      '新しい合言葉は8〜20文字にしてください',
    );
  });
});
