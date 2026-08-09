/**
 * 入力とマスタから文書番号を導出する（F-02 / CLAUDE.md §3・§4）。
 *
 * **クライアントから文書番号を受け取らない。** 番号はここで組み立てる。
 * 受け取る方式にすると、送られてきた番号が命名ルールに合っているかを
 * 結局ここで検証し直すことになり、検証と生成で規則が二重管理になる。
 * `POST /documents/number-preview` と `POST /documents` が同じこの関数を通るので、
 * プレビューで見た番号と登録される番号がずれる余地もなくなる。
 *
 * 採番ルールと工程名は**マスタから引く**。クライアントの申告を使うと、
 * 画面を経由せずに API を叩くだけで `K001` ＋ `工程2` のような、
 * マスタに存在しない組み合わせの文書番号が作れてしまう（CLAUDE.md §7 の検証の二重化）。
 *
 * この関数は DynamoDB も環境変数も見ない。マスタの配列と入力を受け取るだけの
 * 純粋関数にしてあり、テストの主対象になる（CLAUDE.md「テストを書く範囲」1）。
 */

import {
  INITIAL_REVISION,
  buildDocumentNo,
  buildSortKey,
  parseDocumentNo,
} from '../../shared/documentNo';
import { findActiveMaster, isCommonProductCode } from '../../shared/masters';
import type { DocumentRecord, MasterRecord, NumberingRule } from '../../shared/types';

export type NumberingInput = {
  documentType: string;
  productCode: string;
  /** 採番ルールが「工程単位」のときのみ使う。空文字は未指定として扱う */
  processNo?: string;
};

export type DerivedNumber = {
  numberingRule: NumberingRule;
  documentType: string;
  productCode: string;
  processNo?: string;
  processName?: string;

  /** 文書番号から末尾の `_Rev` を除いた部分。SK の前半になる */
  documentId: string;

  /** 新規発行の文書番号（Rev 01） */
  documentNo: string;

  revision: string;

  /** DynamoDB の SK。`文書ID#リビジョン` */
  sortKey: string;
};

export type DeriveResult =
  | { ok: true; value: DerivedNumber }
  | { ok: false; message: string };

/**
 * 文書番号・SK・S3キーを壊す文字（CLAUDE.md §4）。
 *
 * マスタ登録時にも弾く（週2の S-6）が、ここでも見る。
 * マスタが先に壊れていた場合、その値がそのまま SK に入って
 * 「読めるが引けないレコード」ができ、原因が採番側から見えなくなるため。
 */
const FORBIDDEN = ['#', '/'];

function hasForbidden(value: string): boolean {
  return FORBIDDEN.some((char) => value.includes(char));
}

/** 未入力を `undefined` に寄せる。フォームは選択なしを空文字で送ってくる */
function blankToUndefined(value: string | undefined): string | undefined {
  return value === undefined || value === '' ? undefined : value;
}

/**
 * 新規発行を止めるべき既存リビジョンを返す。無ければ `undefined`。
 *
 * **論理削除したものは数えない**（CLAUDE.md §5）。数えると、詰まったレコードを
 * 削除しても同じ番号で発行し直せなくなり、復旧手段が消える。
 * 同じキーへの書き込みは上書きになるので、削除済みのレコードは置き換わる。
 *
 * 返すのは現行（最大）リビジョン。画面が「既に登録されています（現行 Rev xx）」と
 * 出して S-4 へ誘導するのに使う。
 *
 * 比較は数値で行う。文字列のままだと Rev 99 を超えて3桁になったときに
 * `'100' < '99'` となり、現行リビジョンを取り違える。
 */
export function findBlockingRevision(
  revisions: DocumentRecord[],
): DocumentRecord | undefined {
  return revisions
    .filter((record) => record.status !== '削除済み')
    .sort((a, b) => Number(b.revision) - Number(a.revision))[0];
}

export function deriveDocumentNumber(
  masters: MasterRecord[],
  input: NumberingInput,
): DeriveResult {
  const documentTypeMaster = findActiveMaster(masters, '文書種類', input.documentType);
  if (documentTypeMaster === undefined) {
    return { ok: false, message: '文書種類がマスタに登録されていません' };
  }

  const numberingRule = documentTypeMaster.numberingRule;
  if (numberingRule === undefined) {
    // マスタの登録漏れ。入力の誤りではないので文言を分ける
    return { ok: false, message: '文書種類に採番ルールが設定されていません' };
  }

  if (findActiveMaster(masters, '製品コード', input.productCode) === undefined) {
    return { ok: false, message: '製品コードがマスタに登録されていません' };
  }

  // 共通コード（製品によらない作業）に紐づくのは工程単位の文書だけ。
  // 画面では選択肢から外しているが、開発者ツールから回避できる（CLAUDE.md §7）
  if (isCommonProductCode(masters, input.productCode) && numberingRule !== '工程単位') {
    return {
      ok: false,
      message: '共通コードには工程単位の文書種類（作業指示書）だけを登録できます',
    };
  }

  const processNo = blankToUndefined(input.processNo);
  let processName: string | undefined;

  if (numberingRule === '工程単位') {
    if (processNo === undefined) {
      return { ok: false, message: '工程番号を選択してください' };
    }

    const processMaster = findActiveMaster(masters, '工程番号', processNo);
    if (processMaster === undefined) {
      return { ok: false, message: '工程番号がマスタに登録されていません' };
    }

    // 工程名はマスタが持つ1対1の対応から引く。クライアントの申告は見ない
    processName = processMaster.name;
  } else if (processNo !== undefined) {
    /**
     * 製品単位なのに工程番号が送られてきた場合は黙って捨てずに拒否する。
     * 捨てると、呼び出し側は工程を指定できたつもりのまま製品単位の番号を受け取り、
     * 番号を見るまで食い違いに気づけない。
     */
    return { ok: false, message: 'この文書種類では工程番号を指定できません' };
  }

  // 番号を構成する値はすべて SK と S3キーに入る。1つでも壊れていたら組み立てない
  for (const part of [input.documentType, input.productCode, processNo, processName]) {
    if (part !== undefined && hasForbidden(part)) {
      return { ok: false, message: `マスタの値に使用できない文字（# /）が含まれています` };
    }
  }

  const documentNo = buildDocumentNo({
    numberingRule,
    documentType: input.documentType,
    productCode: input.productCode,
    processNo,
    processName,
    revision: INITIAL_REVISION,
  });

  /**
   * 組み立てた番号を、読むときと同じ規則で分解し直して文書IDと SK を得る。
   * 文字列を切り貼りして別に作ると、パース側の規則
   * （末尾の `_数字2桁` を切る・CLAUDE.md §4）とずれる余地が残る。
   */
  const parsed = parseDocumentNo(documentNo);
  const sortKey = buildSortKey(documentNo);
  if (parsed === null || sortKey === null) {
    return { ok: false, message: '文書番号を組み立てられませんでした' };
  }

  return {
    ok: true,
    value: {
      numberingRule,
      documentType: input.documentType,
      productCode: input.productCode,
      processNo,
      processName,
      documentId: parsed.documentId,
      documentNo,
      revision: parsed.revision,
      sortKey,
    },
  };
}
