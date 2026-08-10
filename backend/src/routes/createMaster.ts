/**
 * POST /masters — 選択肢マスタ項目の追加（F-10 / docs/API.md）。
 *
 * 合言葉が要る。マスタは全画面の選択肢の元になり、荒らされると採番や検索が成立しなくなる
 * （docs/API.md「書き込み系すべて」）。
 *
 * **禁止文字（`#`・`/`）とコード重複はサーバー側が正**（CLAUDE.md §7）。
 * 画面（S-6）にも同じ検証があるが、開発者ツールから回避できるためここを省略しない。
 */

import type { APIGatewayProxyResult } from 'aws-lambda';
import { hasAnotherProcessScopedDocumentType } from '../../../shared/masters';
import type { MasterCategory, MasterRecord, NumberingRule } from '../../../shared/types';
import { errorResponse, jsonResponse } from '../http';
import { loadMasters, putNewMaster } from '../masters';
import { optionalString, parseJsonObject, requiredString } from '../validate';
import type { AuthedContext } from './context';

const CATEGORIES: readonly MasterCategory[] = ['文書種類', '製品コード', '工程番号', '担当者'];
const NUMBERING_RULES: readonly NumberingRule[] = ['製品単位', '工程単位'];

/**
 * SK と S3キーを壊す文字は登録させない（CLAUDE.md §4・frontend/src/pages/masters.ts と同じ規律）。
 */
const FORBIDDEN_CHARS = ['#', '/'];

export async function postMaster(context: AuthedContext): Promise<APIGatewayProxyResult> {
  const source = parseJsonObject(context.body);
  if (source === null) {
    return errorResponse(context.origin, 400, 'リクエストの形式が正しくありません');
  }

  const category = requiredString(source, 'category');
  const code = requiredString(source, 'code');
  const name = requiredString(source, 'name');
  if (category === null || code === null || name === null) {
    return errorResponse(context.origin, 400, 'リクエストの形式が正しくありません');
  }
  if (!isMasterCategory(category)) {
    return errorResponse(context.origin, 400, '項目種別が不正です');
  }

  const forbidden = forbiddenCharIn(code, name);
  if (forbidden !== null) {
    return errorResponse(
      context.origin,
      400,
      `「${forbidden}」は使えません（文書番号のキーとS3のパスが壊れるため）`,
    );
  }

  const numberingRule = optionalString(source, 'numberingRule');
  if (numberingRule === null) {
    return errorResponse(context.origin, 400, '採番ルールの形式が正しくありません');
  }
  if (numberingRule !== undefined) {
    if (category !== '文書種類') {
      return errorResponse(context.origin, 400, '採番ルールは文書種類にのみ設定できます');
    }
    if (!NUMBERING_RULES.includes(numberingRule as NumberingRule)) {
      return errorResponse(context.origin, 400, '採番ルールの値が不正です');
    }
  }

  const isCommonRaw = source.isCommon;
  if (isCommonRaw !== undefined) {
    if (category !== '製品コード') {
      return errorResponse(context.origin, 400, '共通コードは製品コードにのみ設定できます');
    }
    if (typeof isCommonRaw !== 'boolean') {
      return errorResponse(context.origin, 400, '共通コードの形式が正しくありません');
    }
  }

  const masters = await loadMasters();

  if (masters.some((m) => m.category === category && m.code === code)) {
    return errorResponse(context.origin, 409, 'このコードは既に登録されています');
  }

  /**
   * 工程単位の文書種類は1件まで（shared/masters.ts）。
   * 工程単位の文書番号は文書種類コードを含まないため、2件あると文書IDが衝突しうる。
   */
  if (
    category === '文書種類' &&
    numberingRule === '工程単位' &&
    hasAnotherProcessScopedDocumentType(masters)
  ) {
    return errorResponse(
      context.origin,
      409,
      '工程単位の文書種類は既に登録されています（作業指示書のみが対象の想定）',
    );
  }

  const record: MasterRecord = {
    category,
    code,
    name,
    status: '有効',
    registeredAt: new Date().toISOString(),
    ...(numberingRule !== undefined ? { numberingRule: numberingRule as NumberingRule } : {}),
    ...(isCommonRaw !== undefined ? { isCommon: isCommonRaw as boolean } : {}),
  };

  const written = await putNewMaster(record);
  if (!written) {
    // 直前の重複チェックを通ったのにここで弾かれた＝ほぼ同時に同じコードが登録された
    return errorResponse(context.origin, 409, 'このコードは既に登録されています');
  }

  console.log(
    JSON.stringify({
      message: 'master created',
      category: record.category,
      code: record.code,
      operator: context.identity.userName,
    }),
  );

  return jsonResponse(context.origin, 201, { master: record });
}

function isMasterCategory(value: string): value is MasterCategory {
  return (CATEGORIES as readonly string[]).includes(value);
}

function forbiddenCharIn(...values: string[]): string | null {
  for (const char of FORBIDDEN_CHARS) {
    if (values.some((value) => value.includes(char))) return char;
  }
  return null;
}
