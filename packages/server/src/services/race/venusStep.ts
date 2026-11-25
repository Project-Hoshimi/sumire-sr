// Step onto the VENUS panel that sits right after the piece's current panel.
//
// The client's "Advance N tile" count never includes a VENUS panel: it only
// handles one when the piece already stands on it (`UserRaceInfo` current panel
// is type 3). A `Race:MovePanel` walk that stops for lack of race points on the
// panel right before a VENUS panel therefore leaves the client showing
// "Advance 0 tile" forever — it never sends `MovePanel` again, so earning more
// race points (e.g. through `Race:ReceiveActivityLesson`) cannot unstick the
// player. `Race:Top` runs `stepOntoAdjacentVenus` so the piece steps onto the
// VENUS panel as soon as the balance covers it, exactly as the walk would
// enter it.
import type { Executor } from '../../db/tx.ts';
import type { Decoded } from '@sumire-sr/protocol/runtime/proto.ts';
import { getItemAmount, spendItem } from '../inventory.ts';
import { getRacePanel } from './master.ts';
import type { RaceConfig } from './types.ts';
import type { RaceState } from './state.ts';

/** `RacePanel.Type`: 3 is the VENUS live panel. */
const PANEL_VENUS = 3;

/** Details of a step, for the caller's info log. */
export interface VenusStepLog {
  playerId: string;
  raceId: string;
  areaId: string;
  fromPanel: number;
  toPanel: number;
  cost: number;
}

/**
 * Arrival on a VENUS panel, shared with the `Race:MovePanel` walk: the piece
 * moves onto the panel, the board locks until its live is cleared and its stage
 * score starts empty. The VENUS panel itself is not counted as a cleared panel
 * (the walk only bumps `totalClearPanelCount` for non-VENUS panels), so neither
 * does this.
 */
export function enterVenusPanel(state: RaceState, panelNumber: number): void {
  state.panelNumber = panelNumber;
  state.pendingVenus = true;
  state.currentLivePanelScore = 0;
}

/**
 * When the piece stands on a real panel whose next panel in the same area is a
 * VENUS panel and the player's race pt balance now covers that panel's
 * `RequiredRacePointAmount`, spend the cost and move onto the VENUS panel
 * (`enterVenusPanel`). Returns true when the step happened; otherwise the state
 * and the inventory are untouched.
 *
 * The area does not change: a VENUS panel is never panel 1, so this never
 * handles the loop wrap.
 */
export async function stepOntoAdjacentVenus(
  config: RaceConfig,
  state: RaceState,
  playerId: string,
  tx: Executor,
  logInfo?: (entry: VenusStepLog) => void,
): Promise<boolean> {
  if (state.pendingVenus) return false;
  if (state.panelNumber <= 0) return false;
  const areaId = config.areaIds[state.areaIndex];
  if (areaId === undefined) return false;
  const toPanel = state.panelNumber + 1;
  const panel = (await getRacePanel(areaId, toPanel)) as unknown as Decoded | null;
  if (panel === null) return false;
  if (Number(panel.Type ?? 0) !== PANEL_VENUS) return false;
  const cost = Number(panel.RequiredRacePointAmount ?? 0);
  const have = await getItemAmount(playerId, config.racePointItemId, tx);
  if (!(have >= cost)) return false;

  const fromPanel = state.panelNumber;
  await spendItem(playerId, config.racePointItemId, cost, tx);
  enterVenusPanel(state, toPanel);
  logInfo?.({ playerId, raceId: config.raceId, areaId, fromPanel, toPanel, cost });
  return true;
}
