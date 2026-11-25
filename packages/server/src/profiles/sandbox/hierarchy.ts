/**
 * Sandbox VENUS (Hierarchy) standing.
 *
 * In the `sandbox` profile every player is shown at BIG4 rank 1 and the
 * multiplayer leaderboard is disabled, because PvP and the server-wide
 * competition the real VENUS system grades on are not available there. VENUS
 * points are still granted and stored exactly as in the official profile, and
 * `UserHierarchy.BestTotalPoint` / `BestDetailGradeId` keep the player's real
 * high-water grade; only the grade and rank reported by the server change.
 *
 * The `official` profile keeps the real VENUS grade/rank system unchanged.
 */
import type { HierarchyStanding } from '../../services/hierarchy.ts';

/** BIG4 detail grade (`HierarchyDetailGrade.Id`). */
export const SANDBOX_HIERARCHY_DETAIL_GRADE_ID = 'hie-001-001';

/** BIG4 grade (`HierarchyDetailGrade.HierarchyGradeId`). */
export const SANDBOX_HIERARCHY_GRADE_ID = 'hie-001';

/** BIG4 is the leaderboard's first place. */
export const SANDBOX_HIERARCHY_RANK = 1;

/** The BIG4 standing shown to every sandbox player. */
export function sandboxHierarchyStanding(): HierarchyStanding {
  return {
    detailGradeId: SANDBOX_HIERARCHY_DETAIL_GRADE_ID,
    gradeId: SANDBOX_HIERARCHY_GRADE_ID,
    rank: SANDBOX_HIERARCHY_RANK,
  };
}
