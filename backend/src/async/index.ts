/**
 * 非同期Lambda（S3イベント）のエントリポイント。
 *
 * 実体が S3 に置かれたあと、**台帳の状態を進めるのはここだけ**（CLAUDE.md §5・§7）。
 * 画面も同期APIも状態を書き換えない。クライアントから直接呼ばれる口も持たない。
 *
 * ---
 *
 * **3段構成**（Issue #19）。前提は2つある。
 *
 *   1. S3イベントは at-least-once。同じPOSTに対して同じイベントが2回届くことがある
 *   2. PDF とエクセルはほぼ同時にPOSTされ、2並列で起動して同じPK+SKを同時に触る
 *
 *   段1  S3キーの記録        — 書く値が決定的なので自然に冪等
 *   段2  状態遷移            — 条件付き書き込みで先勝ち
 *   段3  旧版の処理          — 台帳を全部書いてから S3 を触る
 *
 * **段3に入る条件は「段2に勝ったこと」ではなく「レコードが最新であること」。**
 * 勝者に限定すると切符が一度しか発行されず、勝者が段3の途中で落ちたときに
 * Lambda が自動で再実行しても段2の条件が不成立で二度と段3に入れない。
 * 結果、前リビジョンが「最新」のまま残り、一覧に「最新」が2行並ぶ。
 * 品質文書の台帳としてこれは許容できないので、**あらゆるイベントが段3をやり直せる**
 * 形にし、段3の各操作を「すでに済んでいれば何もしない」に揃えた。
 *
 * **段3は台帳フェーズ → ストレージフェーズの順で並べる。** 台帳の書き込みを
 * 先に済ませておけば、後ろで落ちても壊れるのはストレージクラスだけで済む。
 * 台帳のズレは品質管理上まずいが、ストレージクラスのズレはコストの話に収まる。
 */

import type { S3Event, S3EventRecord } from 'aws-lambda';
import { buildSortKey, parseDocumentNo } from '../../../shared/documentNo';
import type { DocumentRecord } from '../../../shared/types';
import { decodeS3EventKey, parseS3Key } from '../s3Key';
import {
  archiveRevision,
  markPartiallyRegistered,
  promoteToLatest,
  queryRevisions,
  recordS3Key,
} from './ledger';
import { ensureStorageClass } from './storageClass';
import { nextStatus, revisionsAlreadyArchived, revisionsToArchive } from './transition';

/**
 * 受け付けるイベント種別。
 *
 * **通知フィルタ（infra/lambda.tf）と同じ制限をコード側にも置く。**
 * アップロードは presigned POST なので実際に届くのは `ObjectCreated:Post` だけで、
 * 段3-D の `CopyObject` は `ObjectCreated:Copy` になる。
 * ここで撥ねておくと、あとで通知フィルタを広げてしまっても
 * **非同期Lambdaが自分の出したコピーで自分を呼び戻すことがない**。
 *
 * アップロード方式を POST 以外に変える場合は、ここも一緒に変える必要がある。
 */
const ACCEPTED_EVENT = 'ObjectCreated:Post';

export const handler = async (event: S3Event): Promise<void> => {
  for (const record of event.Records) {
    await processRecord(record);
  }
};

async function processRecord(event: S3EventRecord): Promise<void> {
  const rawKey = event.s3.object.key;

  if (event.eventName !== ACCEPTED_EVENT) {
    console.log(JSON.stringify({ message: 'ignored event', eventName: event.eventName, rawKey }));
    return;
  }

  /**
   * イベントのキーは URL エンコードされて届く（空白は `+`）。
   * 工程名に日本語が入るので、戻し忘れると台帳を引けず全件が黙って捨てられる。
   */
  const key = decodeS3EventKey(rawKey);
  if (key === null) {
    console.error(JSON.stringify({ message: 'undecodable key', rawKey }));
    return;
  }

  /**
   * 想定外のキーは推測せずに捨てる。このバケットに書けるのは同期APIが発行した
   * 署名付きURL（キーを署名条件で固定してある）と、この Lambda 自身の `CopyObject` だけ。
   */
  const parsed = parseS3Key(key);
  if (parsed === null) {
    console.error(JSON.stringify({ message: 'unexpected key', key }));
    return;
  }

  const { productCode, documentNo, fileType } = parsed;

  /**
   * SK と 文書ID を両方取る。どちらも同じ正規表現で末尾の `_Rev` を切るので、
   * 片方が null ならもう片方も null になる（CLAUDE.md §4）。
   * `#` の結合を自分で書き直さないために `buildSortKey` を通す。
   */
  const sortKey = buildSortKey(documentNo);
  const parsedNo = parseDocumentNo(documentNo);
  if (sortKey === null || parsedNo === null) {
    console.error(JSON.stringify({ message: 'unparsable document number', key, documentNo }));
    return;
  }

  // --- 段1 ---------------------------------------------------------------
  const record = await recordS3Key(productCode, sortKey, fileType, key);
  if (record === null) {
    // 台帳に無い / 旧版 / 削除済み。**再帰の1ホップ目もここで止まる**
    console.log(
      JSON.stringify({ message: 'skipped: ledger rejected', documentNo, fileType, key }),
    );
    return;
  }

  console.log(JSON.stringify({ message: 's3 key recorded', documentNo, fileType, key }));

  // --- 段2 ---------------------------------------------------------------
  const target = nextStatus(record);
  let promoted = false;

  if (target === '最新') {
    promoted = await promoteToLatest(productCode, sortKey);
  } else if (target === '一部登録') {
    await markPartiallyRegistered(productCode, sortKey);
  }

  console.log(
    JSON.stringify({
      message: 'status evaluated',
      documentNo,
      before: record.status,
      target,
      promoted,
    }),
  );

  /**
   * 段3のゲート。
   *
   *   promoted            — 自分が「最新」にした（通常の経路）
   *   record.status === '最新' — 既に「最新」だった。**再実行がここから段3をやり直す**
   *
   * 段2で条件不成立になっただけ（他の実行が先に「最新」にした直後）では入らない。
   * その実行が段3を持っており、落ちたらその実行の再実行が拾う。
   */
  if (!promoted && record.status !== '最新') return;

  await archivePreviousRevisions(record, parsedNo.documentId);
}

/**
 * 段3 — 前リビジョンを旧版にして Glacier IR へ送る（F-04）。
 *
 * **台帳を全部書いてから S3 を触る。** 順序を逆にすると、S3 の失敗で
 * 台帳の更新まで巻き添えになる。
 */
async function archivePreviousRevisions(
  record: DocumentRecord,
  documentId: string,
): Promise<void> {
  const revisions = await queryRevisions(record.productCode, documentId);
  const toArchive = revisionsToArchive(revisions, record.revision);

  // --- 台帳フェーズ（段3-B）-----------------------------------------------
  for (const previous of toArchive) {
    const archived = await archiveRevision(previous.productCode, previous.sortKey);
    console.log(
      JSON.stringify({
        message: archived ? 'revision archived' : 'revision already archived by another run',
        documentNo: previous.documentNo,
      }),
    );
  }

  /**
   * --- ストレージフェーズ（段3-D）-----------------------------------------
   *
   * **対象を「自分が落としたもの」に限定しない。** 上の書き込みは先勝ちなので、
   * 条件不成立になった相手も旧版にはなっている。その実行が Glacier まで
   * 進めていなければ誰も送らないことになるため、台帳の状態から決め直す。
   * 重複コピーは `ensureStorageClass` の事前確認が防ぐ。
   */
  const archived = [...toArchive, ...revisionsAlreadyArchived(revisions, record.revision)];
  const keys = archived.flatMap((previous) =>
    [previous.s3KeyPdf, previous.s3KeyExcel].filter((key): key is string => key !== undefined),
  );

  const failures: string[] = [];
  let changed = 0;
  for (const key of keys) {
    try {
      if (await ensureStorageClass(key, 'GLACIER_IR')) changed += 1;
    } catch (error) {
      console.error(
        JSON.stringify({
          message: 'storage class change failed',
          key,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
      failures.push(key);
    }
  }

  /**
   * 1つでも失敗したら投げる。**Lambda の自動再実行に拾わせるため。**
   * 台帳は既に書き終えているので、再実行は段3をやり直して残りを片付ける
   * （すでに Glacier のものは事前確認で素通りする）。
   * 3回とも失敗した場合はこのログが唯一の手掛かりになる。
   */
  if (failures.length > 0) {
    throw new Error(`ストレージクラスの変更に失敗しました: ${failures.join(', ')}`);
  }

  /**
   * **段3に入ったこと自体を必ず1行残す。**
   *
   * 個々の操作は「変えたときだけ」ログを書くので、やり直しで何もしなかった場合に
   * 出力が空になる。すると**段3を走らせたのか、ゲートで弾かれたのかが区別できない**。
   * 段3のゲートを「段2の勝者」から「レコードが最新であること」に変えたのは、
   * 再実行が段3をやり直せるようにするためなので、そこが確認できないと
   * 設計の要が実測できていないことになる（本番の通し確認で気づいた）。
   *
   * 件数を添えるのは、旧版化がどこまで進んだかを後から追えるようにするため。
   * 台帳は現在の姿しか持たないので、経緯が残るのはこのログだけ（CLAUDE.md §8-7）。
   */
  console.log(
    JSON.stringify({
      message: 'stage3 completed',
      documentNo: record.documentNo,
      archived: toArchive.length,
      alreadyArchived: archived.length - toArchive.length,
      storageClassChanged: changed,
    }),
  );
}
