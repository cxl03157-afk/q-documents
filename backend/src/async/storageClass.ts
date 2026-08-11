/**
 * ストレージクラスの変更（CLAUDE.md §6）。
 *
 * **この Lambda が扱うのは旧版の Glacier IR 行きだけ。**
 * 最新版エクセルの Standard-IA は署名条件（`x-amz-storage-class`）でアップロード時に
 * 決まるので、あとから移し替える必要がない。最新版PDF は Standard のままでよい。
 *
 * ---
 *
 * **同一キーへの `CopyObject` でクラスだけを変える。台帳のS3キー属性は書き換えない。**
 *
 * 自分自身へのコピーは、メタデータもクラスも変えない場合だけ S3 が拒否する。
 * クラスを変えているので合法。
 */

import {
  CopyObjectCommand,
  HeadObjectCommand,
  S3Client,
  type StorageClass,
} from '@aws-sdk/client-s3';
import { asyncConfig } from './config';
import { needsStorageClassChange } from './transition';

/** モジュールスコープに1つ。ハンドラの中で作ると毎回認証情報の解決をやり直す */
const s3Client = new S3Client({});

/**
 * `CopySource` を組み立てる。
 *
 * **SDK は `CopySource` をエンコードしてくれない。** 工程名には日本語が入るので
 * （`P-0001_K001_工程1_01.pdf`）、素のまま渡すと `NoSuchKey` で全部落ちる。
 *
 * 区切りの `/` は残したまま、セグメントごとに包む。`encodeURIComponent` を
 * キー全体にかけると `/` まで `%2F` になり、今度は「そういう名前の1階層のキー」を
 * 探しに行ってしまう。
 */
function copySource(key: string): string {
  const encoded = key.split('/').map(encodeURIComponent).join('/');
  return `${asyncConfig.filesBucket}/${encoded}`;
}

/**
 * 目的のクラスになっていなければ変える。変えたら true、すでにそうなら false。
 *
 * **先に `HeadObject` で現在のクラスを確かめるのが要点。** 理由は2つある。
 *
 *   1. **同じキーへの Glacier IR コピーを繰り返さないため。** Glacier IR は
 *      90日の最低保管期間があり、置き換えるたびに残り日数ぶんの early deletion 料金が
 *      発生する。段3 は「レコードが最新であること」を根拠に何度でも走る設計なので、
 *      ここを素通しにすると回数ぶん課金が積み上がる。
 *
 *   2. **再帰を1ホップで止めるため。** `CopyObject` は同じバケットへの書き込みなので
 *      またS3イベントを生む。通知フィルタ（`s3:ObjectCreated:Post` のみ）が
 *      一次防御だが、それが破れても「もう目的のクラスなので何も書かない」で止まる。
 *
 * ---
 *
 * **`HeadObject` の失敗は握りつぶさない。**
 *
 * 当初は「実体が消えている」（`NotFound`）だけを捕まえて先へ進める作りにしていたが、
 * **その分岐には到達しない**。S3 は「オブジェクトが無い」ことを 404 で答えるかどうかを
 * 呼び出し側が `s3:ListBucket` を持つかで変え、持たない相手には **403** を返す
 * （404 と 403 の差だけでバケットの中身を推測されないため）。
 * 非同期ロールには `s3:ListBucket` を与えていない（列挙する仕事が無い・最小権限）。
 *
 * つまりコードからは「実体が消えている」と「権限が足りない」を区別できない。
 * 区別できないものを前者と決めつけて先へ進むと、**本当に権限が壊れているときに
 * 黙って通過する**。どちらも人が見るべき失敗なので、呼び出し側へ投げる。
 * 呼び出し側（async/index.ts）がキーごとに記録して、最後にまとめて投げる。
 */
export async function ensureStorageClass(key: string, target: StorageClass): Promise<boolean> {
  const head = await s3Client.send(
    new HeadObjectCommand({ Bucket: asyncConfig.filesBucket, Key: key }),
  );

  if (!needsStorageClassChange(head.StorageClass, target)) return false;

  await s3Client.send(
    new CopyObjectCommand({
      Bucket: asyncConfig.filesBucket,
      Key: key,
      CopySource: copySource(key),
      StorageClass: target,

      // 既定値だが明示する。Content-Type を引き継ぎたいのであって、
      // 差し替えたいわけではないことをコードに残しておく
      MetadataDirective: 'COPY',
    }),
  );

  console.log(
    JSON.stringify({
      message: 'storage class changed',
      key,
      from: head.StorageClass ?? 'STANDARD',
      to: target,
    }),
  );
  return true;
}
