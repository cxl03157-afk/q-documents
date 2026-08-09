/**
 * 採番の共通部分（F-02）。
 *
 * `POST /documents/number-preview` と `POST /documents` は、**同じ入力から同じ番号を出す**
 * 必要がある。プレビューで見せた番号と登録される番号が違えば、画面に出した番号を
 * 文書とファイル名に書き写した利用者の作業が無駄になる。
 * 導出と重複チェックをここ1本にまとめ、両方のハンドラがこれを呼ぶ。
 */

import type { MasterRecord } from '../../../shared/types';
import { type DerivedNumber, deriveDocumentNumber, findBlockingRevision } from '../documentNumber';
import { queryRevisions } from '../ledger';
import { optionalString, parseJsonObject, requiredString } from '../validate';

export type NumberingError = {
  status: number;
  message: string;
  extra?: Record<string, unknown>;
};

export type NumberingOutcome =
  | { ok: true; value: DerivedNumber }
  | { ok: false; error: NumberingError };

/**
 * 入力を検証し、文書番号を導出し、既に登録済みでないことを確かめる。
 *
 * 重複チェックは**同じ文書IDの全リビジョン**を見る。同じ文書IDで Rev 01 を
 * もう1つ作れてしまうと、1つの文書に系列が2本できて台帳が壊れるため
 * （docs/screens.md S-3）。削除済みは数えない（CLAUDE.md §5）。
 *
 * **ここを通っても書き込みの安全は保証されない。** 調べてから書くまでの間に
 * 別のリクエストが同じキーを埋める余地が残る。最終的な保証は
 * `putNewDocument` の条件付き書き込みが持つ（ledger.ts）。
 */
export async function resolveNewNumber(
  masters: MasterRecord[],
  body: string | null,
): Promise<NumberingOutcome> {
  const source = parseJsonObject(body);
  if (source === null) {
    return { ok: false, error: { status: 400, message: 'リクエストの形式が正しくありません' } };
  }

  const documentType = requiredString(source, 'documentType');
  const productCode = requiredString(source, 'productCode');
  const processNo = optionalString(source, 'processNo');

  if (documentType === null || productCode === null || processNo === null) {
    return { ok: false, error: { status: 400, message: 'リクエストの形式が正しくありません' } };
  }

  const derived = deriveDocumentNumber(masters, { documentType, productCode, processNo });
  if (!derived.ok) {
    return { ok: false, error: { status: 400, message: derived.message } };
  }

  const revisions = await queryRevisions(productCode, derived.value.documentId);
  const blocking = findBlockingRevision(revisions);

  if (blocking !== undefined) {
    return {
      ok: false,
      error: {
        status: 409,
        message: `この文書は既に登録されています（現行 Rev ${blocking.revision}）。リビジョンアップを使ってください`,
        // 画面が S-4 への導線を出すのに要る（docs/screens.md S-3）
        extra: {
          existing: {
            documentNo: blocking.documentNo,
            revision: blocking.revision,
            status: blocking.status,
          },
        },
      },
    };
  }

  return { ok: true, value: derived.value };
}
