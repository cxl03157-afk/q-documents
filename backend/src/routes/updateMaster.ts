/**
 * PATCH /masters/{id} — 選択肢マスタの修正・無効化/有効化（F-10 / docs/API.md）。
 *
 * `id` は `${category}#${code}` の URL エンコード（shared/masterId.ts）。
 * マスタのキーは category + code の複合キーだが、パスは1セグメントしか持てないため。
 *
 * `[無効化]`/`[有効化]`（screens.md S-6）もこのエンドポイントを使う。
 * `DELETE /masters` は無い — 物理削除はしない（過去の文書が参照しているため）。
 */

import type { APIGatewayProxyResult } from 'aws-lambda';
import { buildMasterId, parseMasterId } from '../../../shared/masterId';
import { hasAnotherProcessScopedDocumentType, isLastActiveOwner } from '../../../shared/masters';
import type { MasterPatch, MasterStatus, NumberingRule } from '../../../shared/types';
import { errorResponse, jsonResponse } from '../http';
import { loadMasters, updateMasterRecord } from '../masters';
import { optionalString, parseJsonObject } from '../validate';
import type { AuthedContext } from './context';

const MASTER_STATUSES: readonly MasterStatus[] = ['有効', '無効'];
const NUMBERING_RULES: readonly NumberingRule[] = ['製品単位', '工程単位'];

/** POST 側（createMaster.ts）と同じ規律（CLAUDE.md §4） */
const FORBIDDEN_CHARS = ['#', '/'];

export async function patchMaster(context: AuthedContext): Promise<APIGatewayProxyResult> {
  const parsedId = parseMasterId(context.params.id ?? '');
  if (parsedId === null) {
    return errorResponse(context.origin, 404, 'このマスタ項目は見つかりません');
  }
  const { category, code } = parsedId;

  const source = parseJsonObject(context.body);
  if (source === null) {
    return errorResponse(context.origin, 400, 'リクエストの形式が正しくありません');
  }

  const name = optionalString(source, 'name');
  if (name === null) {
    return errorResponse(context.origin, 400, '名称の形式が正しくありません');
  }
  if (name !== undefined) {
    const forbidden = FORBIDDEN_CHARS.find((char) => name.includes(char));
    if (forbidden !== undefined) {
      return errorResponse(
        context.origin,
        400,
        `「${forbidden}」は使えません（文書番号のキーとS3のパスが壊れるため）`,
      );
    }
  }

  const statusRaw = optionalString(source, 'status');
  if (statusRaw === null) {
    return errorResponse(context.origin, 400, '状態の形式が正しくありません');
  }
  if (statusRaw !== undefined && !MASTER_STATUSES.includes(statusRaw as MasterStatus)) {
    return errorResponse(context.origin, 400, '状態の値が不正です');
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

  const patch: MasterPatch = {
    ...(name !== undefined ? { name } : {}),
    ...(statusRaw !== undefined ? { status: statusRaw as MasterStatus } : {}),
    ...(numberingRule !== undefined ? { numberingRule: numberingRule as NumberingRule } : {}),
    ...(isCommonRaw !== undefined ? { isCommon: isCommonRaw as boolean } : {}),
  };

  if (Object.keys(patch).length === 0) {
    return errorResponse(context.origin, 400, '更新する項目がありません');
  }

  /**
   * 工程単位の文書種類は1件まで（shared/masters.ts）。自分自身は除いて数える —
   * 既に工程単位の1件をそのまま「工程単位」に更新し直すケース（他の項目だけ直す）を
   * 誤って弾かないため。
   */
  if (category === '文書種類' && patch.numberingRule === '工程単位') {
    const masters = await loadMasters();
    if (hasAnotherProcessScopedDocumentType(masters, code)) {
      return errorResponse(
        context.origin,
        409,
        '工程単位の文書種類は既に登録されています（作業指示書のみが対象の想定）',
      );
    }
  }

  /**
   * 最後の有効な担当者は無効化させない（shared/masters.ts の `isLastActiveOwner`）。
   *
   * 通すと**画面から復旧できない締め出し**ができる。有効な担当者が0人になると
   * S-2 の氏名プルダウンが空になり、`POST /auth/unlock` も 401 を返す。
   * ここ（マスタの編集）はトークンが要るので、有効化して戻すこともできない。
   *
   * **読み直すのは無効化のときだけ。** 上の分岐の `loadMasters()` は
   * 「文書種類 かつ 工程単位」でしか走らないので、担当者では別に1回要る。
   * 条件を絞ってあるので `[修正]`・`[有効化]`・他カテゴリの読み取りは増えない。
   *
   * 同時実行のレースは「工程単位は1つまで」と同じ扱い（docs/context.md 8/10 の決定）。
   * アイテム横断の制約は条件付き書き込み1本では保証できず、マスタの編集は
   * 低頻度の管理操作なので事前の読み取りだけで足りると判断している。
   */
  if (category === '担当者' && patch.status === '無効') {
    const masters = await loadMasters();
    if (isLastActiveOwner(masters, code)) {
      return errorResponse(
        context.origin,
        409,
        '最後の有効な担当者は無効化できません（誰も解除できなくなるため）。先に別の担当者を追加してください',
      );
    }
  }

  const updated = await updateMasterRecord(category, code, patch);
  if (updated === null) {
    return errorResponse(context.origin, 404, 'このマスタ項目は見つかりません');
  }

  console.log(
    JSON.stringify({
      message: 'master updated',
      id: buildMasterId(category, code),
      operator: context.identity.userName,
    }),
  );

  return jsonResponse(context.origin, 200, { master: updated });
}
