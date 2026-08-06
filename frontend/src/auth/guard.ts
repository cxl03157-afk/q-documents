/**
 * ロック中は S-3〜S-7 を開かせない（screens.md §2「URLを直接叩いた場合も S-2 へリダイレクトする」）。
 *
 * router.ts 側には入れない。ルーティングに解除状態の知識を持たせないことで、
 * 責務分担（CLAUDE.md §7）と揃えている。
 */

import type { RouteHandler } from '../router';
import { isUnlocked } from './session';

export function requireUnlock(handler: RouteHandler): RouteHandler {
  return (params) => {
    if (!isUnlocked()) {
      location.hash = '#/unlock';
      return;
    }
    handler(params);
  };
}
