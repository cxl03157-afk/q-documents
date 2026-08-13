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

import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { createPresignedPost } from '@aws-sdk/s3-presigned-post';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { config } from './config';
import { CONTENT_TYPE, fileNameFor, type FileType } from './s3Key';

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
 * 種別ごとのストレージクラス（CLAUDE.md §6）。
 *
 * **エクセルは最新版でも Standard-IA に置く。** 400GB のうち大半がエクセルで、
 * 全て Standard に置くとコスト要件（月1,000円以内）を超える。
 * 一方 PDF は現場が日常的に開く配布物なので Standard のまま。
 *
 * ---
 *
 * **Standard に置いてから `CopyObject` で移し替える方式は採らない。**
 *
 * 置き先は文書種別だけで決まっていて、**アップロードの時点で分からない情報は何もない**。
 * 後から判断しているのではなく、判断できたことを後回しにしているだけだった。
 * 署名条件に入れてしまえば、10〜50MB のエクセルを1往復コピーする手間が丸ごと消える。
 *
 * 消えるのは手間だけではない。非同期Lambdaが自分の出した `CopyObject` の
 * イベントで自分を呼び戻す**再帰の経路が1本なくなる**（残るのは旧版の Glacier 行きだけで、
 * そちらは段1の `#status <> '旧版'` が止める）。
 *
 * PDF は既定が Standard なので指定しない。指定しなくても利用者が
 * `x-amz-storage-class` を勝手に差し込むことはできない
 * — **POST ポリシーは、送られたフィールドがすべて条件に含まれることを要求する**ため。
 */
const STORAGE_CLASS: Partial<Record<FileType, string>> = {
  excel: 'STANDARD_IA',
};

/**
 * 1つのキーに対するアップロード用URLを発行する。
 *
 * **署名条件に4つを埋め込む。** どれも「URLを手に入れた人が何をできるか」を狭める。
 *
 *   key                  — このキー以外には書けない。**画面はキーを決められない**
 *   Content-Type         — この種別以外の Content-Type では作れない（CLAUDE.md §8-4）
 *   content-length-range — 上限を超えるものは S3 が受け取らない（同上）
 *   x-amz-storage-class  — エクセルのみ。Standard-IA 以外には置けない（CLAUDE.md §6）
 *
 * `Fields` に入れた値は SDK が**そのまま完全一致の条件としてポリシーに加える**
 * （`@aws-sdk/s3-presigned-post` の実装で確認した）。`key` も同様に条件へ入る。
 * そのため `Conditions` に重ねて書く必要があるのは `content-length-range` だけ。
 *
 * **フィールドが増えても画面側の実装は変わらない。** 返した `fields` を全部
 * `FormData` に入れて最後に `file` を足す、という手順のままでよい。
 * 逆に落とすと S3 が 403 で拒否するので、**黙って Standard に落ちることはない。**
 */
export async function createUploadTarget(
  key: string,
  fileType: FileType,
): Promise<PresignedUpload> {
  const storageClass = STORAGE_CLASS[fileType];

  const { url, fields } = await createPresignedPost(s3Client, {
    Bucket: config.filesBucket,
    Key: key,
    Expires: UPLOAD_URL_TTL_SECONDS,
    Fields: {
      'Content-Type': CONTENT_TYPE[fileType],
      ...(storageClass === undefined ? {} : { 'x-amz-storage-class': storageClass }),
    },
    Conditions: [['content-length-range', 1, MAX_UPLOAD_BYTES]],
  });

  return { url, fields };
}

/**
 * 閲覧・ダウンロード用の署名付きURLの有効期限（秒）。**15分以内**（CLAUDE.md §8-3）。
 * アップロード用と同じ上限だが、意味が違う値なので定数は分けておく。
 */
export const DOWNLOAD_URL_TTL_SECONDS = 900;

/**
 * `inline` — ブラウザの既定動作に任せる（PDFは新しいタブでビューア表示）。「閲覧」用
 * `attachment` — 必ずダウンロードとして保存させる。「ダウンロード」用・まとめてダウンロード用
 *
 * PDFだけこの2つを画面が選べるようにする（S-1 の `[PDF閲覧]` / `[PDFダウンロード]`）。
 * エクセルは常に `attachment`（ブラウザに表示手段が無いのでどちらでも実質ダウンロードになるが、
 * 画面側は `attachment` しか要求しない。8/12 の利用者の指摘）。
 */
export type DownloadDisposition = 'inline' | 'attachment';

/**
 * 1つのキーに対する閲覧・ダウンロード用URLを発行する（presigned GET）。
 *
 * **`Content-Disposition` を署名条件（`ResponseContentDisposition`）で固定する。**
 * S3のGetObjectはクエリでの応答ヘッダー上書きを許しており、`s3:GetObject` の権限だけで足りる
 * （追加のIAM権限は不要。7/31時点で同期APIロールに付与済み）。
 *
 * ファイル名には文書番号（日本語を含む）を使うため、`filename*=UTF-8''...`（RFC 6266）で指定する。
 * 対応しない古いブラウザ向けに、ASCIIのみの `filename=` も添えておく（実際に使われるのは
 * `filename*` を解釈できない場合だけなので、内容の分かりやすさより安全な固定文字列でよい）。
 */
export async function createDownloadUrl(
  key: string,
  documentNo: string,
  fileType: FileType,
  disposition: DownloadDisposition,
): Promise<string> {
  const fileName = fileNameFor(documentNo, fileType);
  const fallbackName = fileType === 'pdf' ? 'document.pdf' : 'document.xlsx';

  return getSignedUrl(
    s3Client,
    new GetObjectCommand({
      Bucket: config.filesBucket,
      Key: key,
      ResponseContentDisposition:
        `${disposition}; filename="${fallbackName}"; filename*=UTF-8''${encodeURIComponent(fileName)}`,
    }),
    { expiresIn: DOWNLOAD_URL_TTL_SECONDS },
  );
}
