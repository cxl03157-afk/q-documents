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
  normalizePassphrase,
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

/**
 * 表示されない文字とUnicode正規化。
 *
 * どちらも**画面上では気づけない**種類の誤り。確認用の欄にも同じ値を貼るので
 * 入力時には通り、以後は手で打っても一致しない状態になる。
 */
describe('表示されない文字', () => {
  const INVISIBLE: [string, string][] = [
    ['ゼロ幅スペース', '\u200B'],
    ['ゼロ幅非接合子', '\u200C'],
    ['ゼロ幅接合子', '\u200D'],
    ['単語結合子', '\u2060'],
    ['ソフトハイフン', '\u00AD'],
    ['BOM', '\uFEFF'],
    // 以下は当初の列挙から漏れていた（セルフレビューの指摘）。列挙をやめた理由そのもの
    ['左横書き記号', '\u200E'],
    ['右横書き記号', '\u200F'],
    ['埋め込み開始', '\u202B'],
    ['上書き開始', '\u202E'],
    ['分離開始', '\u2066'],
    ['分離終了', '\u2069'],
    ['アラビア文字記号', '\u061C'],
    ['改行', '\n'],
    ['タブ', '\t'],
  ];

  it.each(INVISIBLE)('%s が真ん中にあれば弾く', (_name, char) => {
    expect(passphraseRejectionReason(`newpa${char}ss1`, CURRENT)).toBe(
      '新しい合言葉に表示されない文字が含まれています。貼り付けずに手で入力してください',
    );
  });

  it.each(INVISIBLE)('%s が端にあっても弾く', (_name, char) => {
    expect(passphraseRejectionReason(`${char}newpass1`, CURRENT)).not.toBeNull();
  });

  /**
   * **弾きすぎていないことの確認。** 判定を Unicode のカテゴリ（Cc・Cf）に広げたので、
   * 普通に入力できる文字まで巻き込んでいないかを押さえる。
   * 異体字セレクタ（U+FE0F）は Mn で Cf ではないため、絵文字はそのまま通る。
   */
  it.each([
    ['日本語', 'ぱすわーど1234'],
    ['英数字', 'newpass1'],
    ['全角スペース入り', 'new　pass1'],
    ['絵文字', 'pass😀word'],
    ['異体字セレクタ付きの絵文字', 'pass❤️word'],
  ])('%s は通す', (_name, value) => {
    expect(passphraseRejectionReason(value, CURRENT)).toBeNull();
  });

  /**
   * 長さより先に判定していることの確認。
   * 20文字ちょうど＋ゼロ幅1文字を入れると、長さの理由が返っては原因が分からない。
   */
  it('長さの理由より先に返す', () => {
    const twentyChars = 'a'.repeat(MAX_PASSPHRASE_LENGTH);
    expect(passphraseRejectionReason(`${twentyChars}\u200B`, CURRENT)).toBe(
      '新しい合言葉に表示されない文字が含まれています。貼り付けずに手で入力してください',
    );
  });
});

describe('Unicode正規化（NFC）', () => {
  /** 「ぱすわーど12345」の半濁点を結合文字で表した形（NFD）。正規化して10文字 */
  const NFD = 'は\u309Aすわ\u30FCと12345';
  const NFC = NFD.normalize('NFC');

  it('NFD と NFC は正規化すると同じになる（前提の確認）', () => {
    expect(NFD).not.toBe(NFC);
    expect(normalizePassphrase(NFD)).toBe(normalizePassphrase(NFC));
  });

  it('現行が NFD・新しい値が NFC でも「同じです」と判定する', () => {
    expect(passphraseRejectionReason(NFC, NFD)).toBe('新しい合言葉が現在の合言葉と同じです');
  });

  it('文字数は正規化後で数える（NFD の結合文字を1文字と数えない）', () => {
    // 結合文字を含めて8コードポイント、正規化すると6文字なので短すぎる
    const shortWhenNormalized = 'か\u3099き\u3099くけこ';
    expect(normalizePassphrase(shortWhenNormalized).length).toBeLessThan(MIN_PASSPHRASE_LENGTH);
    expect(passphraseRejectionReason(shortWhenNormalized, CURRENT)).toBe(
      `新しい合言葉は${MIN_PASSPHRASE_LENGTH}〜${MAX_PASSPHRASE_LENGTH}文字にしてください`,
    );
  });
});
