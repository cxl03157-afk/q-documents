/**
 * アップロードファイル名検証の純粋関数テスト（CLAUDE.md「テストを書く範囲」1）。
 *
 * S3の `.xlsx` キーにPDFの実体が入ったまま「最新」と判定される事故（screens.md S-5・API.md）を
 * 防ぐ検証なので、拡張子の対応・文書番号の突き合わせ・命名ルール違反を重点的に確認する。
 */
import { describe, expect, it } from 'vitest';
import { validateUploadFileNames } from './uploadFiles';

describe('validateUploadFileNames', () => {
  it('正常系: 対象文書のPDF・エクセルが揃っていればエラーなし', () => {
    const errors = validateUploadFileNames('Q001_P-0001_01', {
      pdfName: 'Q001_P-0001_01.pdf',
      excelName: 'Q001_P-0001_01.xlsx',
    });
    expect(errors).toEqual([]);
  });

  it('拡張子が逆: PDF欄にxlsx、エクセル欄にpdfを入れると両方のエラーが出る', () => {
    const errors = validateUploadFileNames('Q001_P-0001_01', {
      pdfName: 'Q001_P-0001_01.xlsx',
      excelName: 'Q001_P-0001_01.pdf',
    });
    expect(errors).toEqual([
      'PDF欄にはPDFファイルを選択してください',
      'エクセル欄にはエクセルファイルを選択してください',
    ]);
  });

  it('拡張子は大文字小文字を区別しない', () => {
    const errors = validateUploadFileNames('Q001_P-0001_01', {
      pdfName: 'Q001_P-0001_01.PDF',
      excelName: 'Q001_P-0001_01.XLSX',
    });
    expect(errors).toEqual([]);
  });

  it('2つのファイルの文書番号が食い違うとエラーになる', () => {
    const errors = validateUploadFileNames('Q001_P-0001_01', {
      pdfName: 'Q001_P-0001_01.pdf',
      excelName: 'Q001_P-0002_01.xlsx',
    });
    // excel側は対象文書とも一致しないため「対象の文書と異なる」も同時に出る（実装どおり）
    expect(errors).toContain('2つのファイルの文書番号が一致しません');
  });

  it('2つのファイルが一致していても対象の文書と異なればエラーになる', () => {
    const errors = validateUploadFileNames('Q001_P-0001_01', {
      pdfName: 'Q999_P-9999_01.pdf',
      excelName: 'Q999_P-9999_01.xlsx',
    });
    // pdfNo === excelNo なので「2つのファイルの文書番号が一致しません」は出ない
    expect(errors).toEqual(['ファイル名の文書番号が対象の文書と異なります']);
  });

  it('工程名に `_` を含む文書番号でも正しく検証を通過する', () => {
    // documentNo.ts の末尾切り出しパースと組み合わせた統合的なケース。
    const documentNo = 'P-0001_K001_組立_仮_02';
    const errors = validateUploadFileNames(documentNo, {
      pdfName: `${documentNo}.pdf`,
      excelName: `${documentNo}.xlsx`,
    });
    expect(errors).toEqual([]);
  });

  it('ファイル名に `/` を含むとエラーになる（パストラバーサル対策）', () => {
    const errors = validateUploadFileNames('Q001_P-0001_01', {
      pdfName: 'sub/Q001_P-0001_01.pdf',
      excelName: 'sub/Q001_P-0001_01.xlsx',
    });
    expect(errors).toContain('ファイル名が命名ルールに従っていません');
  });

  it('ファイル名に `#` を含むとエラーになる（SKの区切り文字と衝突するため）', () => {
    const errors = validateUploadFileNames('Q001_P-0001_01', {
      pdfName: 'Q001_P-0001_01#hack.pdf',
      excelName: 'Q001_P-0001_01#hack.xlsx',
    });
    expect(errors).toContain('ファイル名が命名ルールに従っていません');
  });

  /**
   * 片方だけのアップロード（要件定義書 F-01）。
   * 登録済みの種別は再登録できないが、未登録の種別だけを後から追加できる。
   */
  describe('片方だけ送られてきた場合', () => {
    it('PDFだけでもエラーなし', () => {
      const errors = validateUploadFileNames('Q001_P-0001_01', {
        pdfName: 'Q001_P-0001_01.pdf',
      });
      expect(errors).toEqual([]);
    });

    it('エクセルだけでもエラーなし', () => {
      const errors = validateUploadFileNames('Q001_P-0001_01', {
        excelName: 'Q001_P-0001_01.xlsx',
      });
      expect(errors).toEqual([]);
    });

    it('片方だけのときは「2つのファイルの文書番号が一致しません」を出さない', () => {
      const errors = validateUploadFileNames('Q001_P-0001_01', {
        excelName: 'Q999_P-9999_01.xlsx',
      });
      expect(errors).toEqual(['ファイル名の文書番号が対象の文書と異なります']);
    });

    it('エクセルだけでも拡張子を検証する', () => {
      const errors = validateUploadFileNames('Q001_P-0001_01', {
        excelName: 'Q001_P-0001_01.pdf',
      });
      expect(errors).toContain('エクセル欄にはエクセルファイルを選択してください');
    });

    it('エクセルだけでも命名ルールを検証する（PDF側だけ見ていると素通りする経路）', () => {
      const errors = validateUploadFileNames('../secret', {
        excelName: '../secret.xlsx',
      });
      expect(errors).toContain('ファイル名が命名ルールに従っていません');
    });

    it('どちらも選ばれていなければその旨だけを返す', () => {
      expect(validateUploadFileNames('Q001_P-0001_01', {})).toEqual([
        'アップロードするファイルを選択してください',
      ]);
    });
  });

  it('複数の不備があれば最初の1件で打ち切らずすべて返す', () => {
    const errors = validateUploadFileNames('Q001_P-0001_01', {
      pdfName: 'foo.xlsx', // 拡張子違反・文書番号不一致・命名ルール違反
      excelName: 'bar.pdf', // 拡張子違反・文書番号不一致
    });
    expect(errors).toEqual([
      'PDF欄にはPDFファイルを選択してください',
      'エクセル欄にはエクセルファイルを選択してください',
      '2つのファイルの文書番号が一致しません',
      'ファイル名の文書番号が対象の文書と異なります',
      'ファイル名が命名ルールに従っていません',
    ]);
  });
});
