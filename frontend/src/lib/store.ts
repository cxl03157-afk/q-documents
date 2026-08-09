/**
 * 台帳とマスタの保持（`mock/documents.ts` と `mock/masters.ts` の置き換え）。
 *
 * 画面はここから読む。`GET /documents` と `GET /masters` の応答をそのまま
 * 配列で持ち、絞り込み・関連導出・CSV は画面側が行う（docs/API.md）。
 *
 * ---
 *
 * **配列の実体をそのまま返している。** 本来は複製を返して外から書き換えられない
 * ようにしたいが、S-5（アップロード）・S-6（マスタ管理）・S-7（修正）の書き込みは
 * まだ対応するAPIが無く、モックとして**この配列を直接変更している**。
 * ここだけ包んでも一貫しないので、週3で S-5 が実APIになる時点まではこの形にする。
 *
 * 状態遷移の代役（`mock/asyncLambda.ts`）も同じ配列を触る。
 * 状態を書き換えてよいのは非同期Lambdaだけ、という規律（CLAUDE.md §5）を
 * モックの側でも守るために1か所に閉じてある。
 *
 * ---
 *
 * **既知の制約: モックの書き込みは `loadDocuments()` で消える。**
 *
 * S-5（アップロード反映）・S-6（マスタ編集）・S-7（修正・論理削除）は対応する API が
 * まだ無く、この配列を直接変えているだけ。取り直すとサーバーの内容で置き換わるので、
 * **解除／ロックを切り替えると、それらの変更が元に戻る**。
 *
 * 手前で辻褄を合わせる（サーバーの結果にモックの変更を重ねる）ことはしない。
 * 消えるのは「まだ保存されていないもの」だけで、重ねると保存されたように見えてしまう。
 * 8/11 の `POST /masters`・8/12 以降の `PATCH`/`DELETE /documents` で順に解消する。
 */

import type { DocumentRecord, MasterRecord } from '../../../shared/types';
import { apiGet } from './api';
import { isDocumentsResponse, isMastersResponse } from './guards';

let documents: DocumentRecord[] = [];
let masters: MasterRecord[] = [];

export function allDocuments(): DocumentRecord[] {
  return documents;
}

export function allMasters(): MasterRecord[] {
  return masters;
}

export function findDocument(documentNo: string): DocumentRecord | undefined {
  return documents.find((doc) => doc.documentNo === documentNo);
}

/**
 * 台帳を取り直す。
 *
 * **解除／ロックの切り替えでも呼ぶ必要がある。** `GET /documents` は
 * トークンがあるときだけ削除済みを含めて返すため（docs/API.md）、
 * 起動時に1回読むだけだと「解除しても削除済みが出てこない」
 * 「ロックしても消えない」という食い違いが残る。
 */
export async function loadDocuments(): Promise<string | null> {
  let result = await apiGet('/documents', isDocumentsResponse);

  /**
   * **401 なら、トークンを外してもう一度だけ試す。**
   *
   * 401 を受けた時点で api.ts が解除状態を破棄しているので、2回目はトークンなしで飛ぶ。
   * 台帳の読み取り自体は合言葉が要らない（docs/API.md）ため、削除済みが含まれないだけで
   * 一覧は問題なく出せる。
   *
   * 再試行しないと、sessionStorage に古いトークンが1つ残っているだけで
   * **起動時に一覧が一切読めなくなる**（署名鍵を差し替えた直後などに起きる）。
   * 「通信に失敗しました」と出て、原因が解除状態にあることは画面から分からない。
   */
  if (!result.ok && result.status === 401) {
    result = await apiGet('/documents', isDocumentsResponse);
  }

  if (!result.ok) return result.message;

  documents = result.data.documents;
  return null;
}

/**
 * マスタを取り直す。
 *
 * 解除の状態で結果は変わらない（`GET /masters` は無効なものも含めて全件返し、
 * 絞り込みは画面側の責務）ので、起動時とマスタを変更したときだけ呼ぶ。
 */
export async function loadMasters(): Promise<string | null> {
  const result = await apiGet('/masters', isMastersResponse);
  if (!result.ok) return result.message;

  masters = result.data.masters;
  return null;
}

/**
 * 台帳に1件反映する。**同じキー（製品コード＋SK）があれば置き換える。**
 *
 * DynamoDB は同じ PK/SK への書き込みが上書きなので、こちらもその挙動に揃える。
 * 揃えないと、論理削除したものを発行し直したときに同じ文書番号の行が2つでき、
 * 検索が先に見つけた「削除済み」を返してアップロードできなくなる。
 *
 * 書き込み API の応答（作られたレコード）をそのまま渡す想定。
 * 取り直さないのは、1件のために全件を読み直す必要がないため。
 */
export function upsertDocument(record: DocumentRecord): void {
  const index = documents.findIndex(
    (doc) => doc.productCode === record.productCode && doc.sortKey === record.sortKey,
  );

  if (index === -1) {
    documents.push(record);
    return;
  }
  documents[index] = record;
}

/** マスタに1件反映する。S-6 がモックのうちだけ使う（週2の `POST /masters` で置き換わる） */
export function upsertMaster(record: MasterRecord): void {
  const index = masters.findIndex(
    (m) => m.category === record.category && m.code === record.code,
  );

  if (index === -1) {
    masters.push(record);
    return;
  }
  masters[index] = record;
}
