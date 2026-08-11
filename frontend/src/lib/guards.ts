/**
 * API 応答の型ガード。
 *
 * **`as` で型を主張しない。** `as DocumentRecord[]` と書いても実行時には何も
 * 確かめておらず、想定外の応答が型の付いた顔をして画面に流れ込む。
 * 8/9 のレビューで、`expiresAt` が欠けた応答が `Date.parse` で NaN になり
 * 30分の自動ロックまで恒久的に無効化されることが判明したのが同じ構図。
 *
 * **全項目を検証しようとはしない。** 画面が実際に読む項目に絞る。
 * 欠けたら壊れるものだけを見る、という基準にしておかないと、
 * サーバー側に項目を1つ足すたびにここが落ちるようになり、
 * やがてガードごと外される（外された時点で無検証に戻る）。
 */

import type {
  DocumentRecord,
  DocumentStatus,
  MasterCategory,
  MasterRecord,
  MasterStatus,
  NumberingRule,
} from '../../../shared/types';

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** 空文字も弾く。空の文書番号や空の状態は、あっても画面が扱えない */
function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value !== '';
}

function isOneOf<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value);
}

const STATUSES: readonly DocumentStatus[] = [
  'ファイル未登録',
  '一部登録',
  '最新',
  '旧版',
  '削除済み',
];

const CATEGORIES: readonly MasterCategory[] = ['文書種類', '製品コード', '工程番号', '担当者'];
const MASTER_STATUSES: readonly MasterStatus[] = ['有効', '無効'];
const NUMBERING_RULES: readonly NumberingRule[] = ['製品単位', '工程単位'];

/**
 * 台帳のレコード。
 *
 * `status` を5値のどれかまで確認するのは、これが画面の分岐の中心だから。
 * 知らない値が混ざると、絞り込みにも出ず操作列も出ない行が黙って生まれる。
 */
export function isDocumentRecord(value: unknown): value is DocumentRecord {
  if (!isObject(value)) return false;

  return (
    isNonEmptyString(value.productCode) &&
    isNonEmptyString(value.sortKey) &&
    isNonEmptyString(value.documentNo) &&
    isNonEmptyString(value.documentType) &&
    isNonEmptyString(value.revision) &&
    isNonEmptyString(value.owner) &&
    isNonEmptyString(value.issuedAt) &&
    isOneOf(value.status, STATUSES) &&
    // 工程情報とS3キーは無いことに意味がある（採番ルール・状態5値との対応）ので、
    // 「無い、あるいは文字列」までを確認する
    isOptionalString(value.processNo) &&
    isOptionalString(value.processName) &&
    isOptionalString(value.s3KeyPdf) &&
    isOptionalString(value.s3KeyExcel)
  );
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === 'string';
}

export function isMasterRecord(value: unknown): value is MasterRecord {
  if (!isObject(value)) return false;

  return (
    isOneOf(value.category, CATEGORIES) &&
    isNonEmptyString(value.code) &&
    isNonEmptyString(value.name) &&
    isOneOf(value.status, MASTER_STATUSES) &&
    (value.numberingRule === undefined || isOneOf(value.numberingRule, NUMBERING_RULES)) &&
    (value.isCommon === undefined || typeof value.isCommon === 'boolean')
  );
}

// ---------------------------------------------------------------------------
// 応答そのものの形
// ---------------------------------------------------------------------------

export type DocumentsResponse = { documents: DocumentRecord[] };
export type MastersResponse = { masters: MasterRecord[] };
export type DocumentResponse = { document: DocumentRecord };
export type MasterResponse = { master: MasterRecord };

export function isDocumentsResponse(value: unknown): value is DocumentsResponse {
  return isObject(value) && Array.isArray(value.documents) && value.documents.every(isDocumentRecord);
}

export function isMastersResponse(value: unknown): value is MastersResponse {
  return isObject(value) && Array.isArray(value.masters) && value.masters.every(isMasterRecord);
}

export function isDocumentResponse(value: unknown): value is DocumentResponse {
  return isObject(value) && isDocumentRecord(value.document);
}

export function isMasterResponse(value: unknown): value is MasterResponse {
  return isObject(value) && isMasterRecord(value.master);
}

/**
 * `POST /documents/number-preview` の応答。
 *
 * `processName` は製品単位の文書には存在しない。
 */
export type NumberPreviewResponse = {
  documentNo: string;
  documentId: string;
  revision: string;
  processName?: string;
};

export function isNumberPreviewResponse(value: unknown): value is NumberPreviewResponse {
  return (
    isObject(value) &&
    isNonEmptyString(value.documentNo) &&
    isNonEmptyString(value.documentId) &&
    isNonEmptyString(value.revision) &&
    isOptionalString(value.processName)
  );
}

/**
 * 409（既に登録済み）に添えられる現行リビジョン。
 *
 * S-3 が「リビジョンアップへ」の導線を出すのに使う。
 * **これが取れなければ導線を出さない** — 誤った文書番号のリンクを出すより、
 * 一覧から探してもらうほうがよい。
 */
export type ExistingDocument = { documentNo: string; revision: string; status: DocumentStatus };

/**
 * `POST /documents/{docNo}/upload-url` の応答（`backend/src/s3.ts` の `PresignedUpload`）。
 *
 * `fields` はブラウザが `FormData` にそのまま詰めて S3 へ送る値で、キー名は署名の都合で
 * 決まる（`key` / `Content-Type` / `policy` / `x-amz-*` など）。中身を検証しても壊れ方を
 * 防げないので、「文字列のマップであること」までしか見ない。
 */
export type PresignedUpload = { url: string; fields: Record<string, string> };

export type UploadUrlResponse = {
  pdf?: PresignedUpload;
  excel?: PresignedUpload;
  expiresInSeconds: number;
};

function isPresignedUpload(value: unknown): value is PresignedUpload {
  if (!isObject(value) || !isNonEmptyString(value.url) || !isObject(value.fields)) return false;
  return Object.values(value.fields).every((v) => typeof v === 'string');
}

export function isUploadUrlResponse(value: unknown): value is UploadUrlResponse {
  return (
    isObject(value) &&
    (value.pdf === undefined || isPresignedUpload(value.pdf)) &&
    (value.excel === undefined || isPresignedUpload(value.excel)) &&
    typeof value.expiresInSeconds === 'number'
  );
}

export function readExisting(value: unknown): ExistingDocument | null {
  if (!isObject(value) || !isObject(value.existing)) return null;

  const existing = value.existing;
  if (
    !isNonEmptyString(existing.documentNo) ||
    !isNonEmptyString(existing.revision) ||
    !isOneOf(existing.status, STATUSES)
  ) {
    return null;
  }

  return {
    documentNo: existing.documentNo,
    revision: existing.revision,
    status: existing.status,
  };
}
