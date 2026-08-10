/**
 * 署名付きURLの発行。
 *
 * 実ファイルは API Gateway を通さず、ブラウザから S3 へ直接送る（docs/API.md）。
 * Lambda の応答上限（6MB）にも API Gateway の上限（10MB）にも収まらないため。
 *
 * ---
 *
 * **presigned POST を使う。presigned PUT ではない。**
 *
 * CLAUDE.md §8-4 が「`content-length-range` でサイズ上限を強制する」ことを求めているが、
 * これは **POST のポリシーでしか表現できない**。PUT の署名にサイズを織り込む手段は無く、
 * PUT にすると「上限は画面が守る」ことになる。それは開発者ツールから回避できるので、
 * サイズ上限が実質存在しない状態と変わらない。
 *
 * 代償は、ブラウザ側が単純な `fetch(url, { method: 'PUT', body: file })` ではなく
 * `FormData` に返却されたフィールドを詰めて送る形になること。
 */

import { S3Client } from '@aws-sdk/client-s3';
import { createPresignedPost } from '@aws-sdk/s3-presigned-post';
import { config } from './config';
import { CONTENT_TYPE, type FileType } from './s3Key';

/**
 * クライアントはモジュールスコープに1つ。
 * ハンドラの中で作ると、実行環境が再利用されても毎回認証情報の解決をやり直す。
 */
const s3Client = new S3Client({});

/**
 * 署名付きURLの有効期限（秒）。**15分以内**（CLAUDE.md §8-3）。
 *
 * 「リクエストを開始できる期限」であって転送の制限時間ではないので、
 * 大きなエクセルの送信中に切れることはない。
 */
export const UPLOAD_URL_TTL_SECONDS = 900;

/**
 * アップロードできるファイルサイズの上限（バイト）。
 *
 * `docs/tech-stack.md` の前提が「作業指示書のエクセルで10〜50MB、PDFはその数分の一」なので、
 * 倍の余裕を取って100MB。下限を1にしているのは0バイトのファイルを弾くため
 * （選択を誤って空のファイルを送ると、台帳上は「最新」になるのに中身が無い）。
 */
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

/**
 * ブラウザが S3 へ POST するのに必要な一式。
 *
 * `fields` をすべて `FormData` に入れ、**最後に `file` を追加**して送る
 * （S3 はファイル本体より前にポリシーとフィールドが並んでいることを要求する）。
 */
export type PresignedUpload = {
  url: string;
  fields: Record<string, string>;
};

/**
 * 1つのキーに対するアップロード用URLを発行する。
 *
 * **署名条件に3つを埋め込む。** どれも「URLを手に入れた人が何をできるか」を狭める。
 *
 *   key             — このキー以外には書けない。**画面はキーを決められない**
 *   Content-Type    — この種別以外の Content-Type では作れない（CLAUDE.md §8-4）
 *   content-length-range — 上限を超えるものは S3 が受け取らない（同上）
 *
 * `Fields` に入れた値は SDK が**そのまま完全一致の条件としてポリシーに加える**
 * （`@aws-sdk/s3-presigned-post` の実装で確認した）。`key` も同様に条件へ入る。
 * そのため `Conditions` に重ねて書く必要があるのは `content-length-range` だけ。
 */
export async function createUploadTarget(
  key: string,
  fileType: FileType,
): Promise<PresignedUpload> {
  const { url, fields } = await createPresignedPost(s3Client, {
    Bucket: config.filesBucket,
    Key: key,
    Expires: UPLOAD_URL_TTL_SECONDS,
    Fields: {
      'Content-Type': CONTENT_TYPE[fileType],
    },
    Conditions: [['content-length-range', 1, MAX_UPLOAD_BYTES]],
  });

  return { url, fields };
}
