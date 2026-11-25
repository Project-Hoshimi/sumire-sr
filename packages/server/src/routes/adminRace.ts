/**
 * Admin console API for race live-ops, under `/sumire/admin/races`.
 *
 * Read routes list the players that own a `RaceState:<raceId>` row (with the
 * same competition rank `Race:Ranking` serves), expose one player's normalized
 * state plus its race-point/medal item balances, and return the ranking list.
 * Write routes edit one player's board state in a player transaction and can
 * reset the state to the shape a fresh player gets. Race points and medals are
 * the race config's item ids (`racePointItemId` / `raceMedalItemId`), exactly
 * as `Race:Board` and the quest rewards spend and grant them.
 */
import { and, eq, inArray } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { db } from '../db/client.ts';
import { playerEntities, players } from '../db/schema.ts';
import { withPlayerTx, type Executor } from '../db/tx.ts';
import { publicUserIdOf } from '../services/friendLinks.ts';
import { getItemAmount, grantItem, spendItem } from '../services/inventory.ts';
import { decodeJsonSingletonBlob, getSingleton } from '../services/playerState.ts';
import { pluginLifecycle } from '../services/events/plugin.ts';
import { listEventSummaries } from '../services/events/registry.ts';
import { raceConfigFor } from '../services/race/catalog.ts';
import { isRaceBotId } from '../services/race/bots.ts';
import { raceDifficultyNumber } from '../services/race/difficulty.ts';
import { countRacePanels } from '../services/race/master.ts';
import { raceRanking } from '../services/race/ranking.ts';
import {
  emptyRaceState,
  markRaceInitialLogin,
  normalizeRaceState,
  raceStateField,
  saveRaceState,
} from '../services/race/state.ts';
import type { RaceConfig } from '../services/race/types.ts';
import { nextTallyAt } from '../services/race/tally.ts';
import {
  lessonTiersOf,
  loadRaceClearedTiers,
  loadRaceEffectiveClearedTiers,
} from '../services/race/userRaceInfo.ts';
import { readJsonBody, requireAdmin, type AdminRouteDeps } from './admin.ts';

/** List page size defaults/max, matching the lookup browser caps. */
const PLAYERS_DEFAULT_LIMIT = 50;
const PLAYERS_MAX_LIMIT = 100;
/** `Race:Ranking` displays at most this many entries; the admin list can ask for the same. */
const RANKING_MAX_LIMIT = 1000;

export interface AdminRaceRouteDeps {
  admin: AdminRouteDeps;
  /** Race config source; production resolves the published race event. */
  configFor?: (raceId: string) => RaceConfig | undefined;
  /** Published race event list for the page selector. */
  listRaces?: () => Promise<RaceSummary[]>;
  /** Panel counts per area; production reads the master `RacePanel` rows. */
  panelCountFor?: (areaIds: readonly string[]) => Promise<Map<string, number>>;
}

export interface RaceSummary {
  id: string;
  title: string;
  publishedVersion: number;
  lifecycle: string;
  schedule: { startsAt: Date; endsAt: Date; enabled: boolean }[];
}

export interface RaceAreaInfo {
  index: number;
  areaId: string;
  panelCount: number;
}

interface RaceStateRow {
  playerId: string;
  blob: string;
  createdAt: Date;
  name: string;
  level: number;
  data: unknown;
}

function raceConfig(deps: AdminRaceRouteDeps, raceId: string): RaceConfig | undefined {
  return (deps.configFor ?? raceConfigFor)(raceId);
}

function publishedRaces(): Promise<RaceSummary[]> {
  return listEventSummaries().then((rows) =>
    rows
      .filter((row) => row.kind === 'race' && row.publishedVersion > 0)
      .map((row) => ({
        id: row.id,
        title: row.title,
        publishedVersion: row.publishedVersion,
        lifecycle: pluginLifecycle(row.kind),
        schedule: row.schedule.map((slot) => ({
          startsAt: slot.startsAt,
          endsAt: slot.endsAt,
          enabled: slot.enabled,
        })),
      })),
  );
}

/** Every stored race state row of the race, joined with the player's identity. */
async function stateRows(raceId: string, exec: Executor = db): Promise<RaceStateRow[]> {
  return exec
    .select({
      playerId: playerEntities.playerId,
      blob: playerEntities.blob,
      createdAt: playerEntities.createdAt,
      name: players.name,
      level: players.level,
      data: players.data,
    })
    .from(playerEntities)
    .innerJoin(players, eq(players.id, playerEntities.playerId))
    .where(
      and(eq(playerEntities.kind, raceStateField(raceId)), eq(playerEntities.entityKey, '')),
    )
    .orderBy(playerEntities.id);
}

function publicUserIdOfRow(row: { data: unknown; playerId: string }): string {
  const publicId = (row.data as { publicUserId?: string } | null)?.publicUserId;
  return String(publicId ?? '') || row.playerId;
}

/** `lastActivityReceiveMs` when the race clock started, else the row's creation time. */
function lastUpdatedIso(createdAt: Date, lastActivityReceiveMs: number): string {
  return new Date(lastActivityReceiveMs > 0 ? lastActivityReceiveMs : createdAt.getTime()).toISOString();
}

function parseNonNegativeInt(value: unknown, field: string): number | string {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    return `${field} must be a non-negative integer`;
  }
  return value;
}

function parseQueryInt(raw: unknown, fallback: number, min: number, max: number): number {
  if (typeof raw !== 'string' || raw.trim() === '') return fallback;
  if (!/^\d+$/.test(raw.trim())) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min) return fallback;
  return Math.min(value, max);
}

interface PlayerListRow {
  playerId: string;
  userId: string;
  name: string;
  level: number;
  areaIndex: number;
  areaId: string;
  panelNumber: number;
  /** Completed laps of the looping last area; 0 on the first pass. */
  loopCount: number;
  totalClearPanelCount: number;
  rank: number;
  racePoints: number;
  medals: number;
  pendingVenus: boolean;
  /** VENUS difficulty frozen into the state at the first open; null before it. */
  difficultyNumber: number | null;
  /** Difficulty the VENUS live actually runs at (frozen value or fallback). */
  effectiveDifficultyNumber: number;
  lastUpdated: string;
}

async function buildAreaInfos(
  config: RaceConfig,
  panelCountFor: (areaIds: readonly string[]) => Promise<Map<string, number>>,
): Promise<RaceAreaInfo[]> {
  const counts = await panelCountFor(config.areaIds);
  return config.areaIds.map((areaId, index) => ({
    index,
    areaId,
    panelCount: counts.get(areaId) ?? 0,
  }));
}

async function itemBalance(
  playerId: string,
  itemId: string,
  exec: Executor = db,
): Promise<number> {
  return itemId === '' ? 0 : getItemAmount(playerId, itemId, exec);
}

/** Set an item balance to an absolute amount (grant the delta up, spend it down). */
async function setItemAmount(
  playerId: string,
  itemId: string,
  target: number,
  exec: Executor,
): Promise<void> {
  const current = await getItemAmount(playerId, itemId, exec);
  if (target > current) await grantItem(playerId, itemId, target - current, exec);
  else if (target < current) await spendItem(playerId, itemId, current - target, exec);
}

function coolTimeRows(state: { cardCoolTimes: Record<string, number> }) {
  return Object.entries(state.cardCoolTimes)
    .map(([cardId, endsAt]) => ({ cardId, endsAt }))
    .sort((a, b) => a.endsAt - b.endsAt || a.cardId.localeCompare(b.cardId));
}

/** Authored race start (ms), or null for a config without a schedule. */
function raceStartMs(config: RaceConfig): number | null {
  const startsAt = config.schedule?.startsAt;
  const ms = startsAt ? Date.parse(startsAt) : Number.NaN;
  return Number.isFinite(ms) ? ms : null;
}

async function playerDetail(
  raceId: string,
  playerId: string,
  config: RaceConfig,
  exec: Executor = db,
) {
  const [row] = await stateRows(raceId, exec).then((rows) =>
    rows.filter((candidate) => candidate.playerId === playerId),
  );
  if (!row) return null;
  const state = normalizeRaceState(decodeJsonSingletonBlob(row.blob));
  const startMs = raceStartMs(config);
  const now = Date.now();
  // The activity-lesson rate the player is actually earning at, i.e. clears
  // already applied by the 2-day tally (a config without a schedule has no
  // tally, so its clears count immediately). A config without area quests has
  // no tier rows to count, so the tiers are unknown.
  const hasQuests = (config.areaQuestIds?.pt ?? '') !== '' && (config.areaQuestIds?.medal ?? '') !== '';
  const clearedTiers = !hasQuests
    ? null
    : startMs === null
      ? await loadRaceClearedTiers(config, state)
      : await loadRaceEffectiveClearedTiers(config, state, startMs, now);
  return {
    raceId,
    player: {
      playerId: row.playerId,
      userId: publicUserIdOfRow(row),
      name: row.name,
      level: row.level,
    },
    state,
    lessonTiers: clearedTiers === null ? null : lessonTiersOf(clearedTiers),
    nextTallyAt: startMs === null ? null : nextTallyAt(startMs, now),
    racePoints: await itemBalance(playerId, config.racePointItemId, exec),
    medals: await itemBalance(playerId, config.raceMedalItemId, exec),
    cardCoolTimes: coolTimeRows(state),
    difficultyNumber: state.difficultyNumber,
    effectiveDifficultyNumber: raceDifficultyNumber(state, config),
    lastUpdated: lastUpdatedIso(row.createdAt, state.lastActivityReceiveMs),
  };
}

export const adminRaceRoutes: FastifyPluginAsync<AdminRaceRouteDeps> = async (app, opts) => {
  const viewer = requireAdmin('viewer', opts.admin);
  const editor = requireAdmin('editor', opts.admin);
  const panelCountFor = opts.panelCountFor ?? countRacePanels;

  app.get('/sumire/admin/races', { preHandler: viewer }, async () => {
    const races = await (opts.listRaces ?? publishedRaces)();
    return { races };
  });

  app.get('/sumire/admin/races/:raceId/players', { preHandler: viewer }, async (req, reply) => {
    const { raceId } = req.params as { raceId: string };
    const config = raceConfig(opts, raceId);
    if (config === undefined) return reply.code(404).send({ error: 'unknown race' });
    const query = req.query as Record<string, unknown>;
    const search = typeof query.q === 'string' ? query.q.trim().toLowerCase() : '';
    const limit = parseQueryInt(query.limit, PLAYERS_DEFAULT_LIMIT, 1, PLAYERS_MAX_LIMIT);
    const offset = parseQueryInt(query.offset, 0, 0, Number.MAX_SAFE_INTEGER);

    const rows = await stateRows(raceId);
    const rankByPlayer = new Map(
      (await raceRanking(raceId)).map((entry) => [entry.playerId, entry.rank] as const),
    );

    const entries: Omit<PlayerListRow, 'racePoints' | 'medals'>[] = [];
    for (const row of rows) {
      const userId = publicUserIdOfRow(row);
      if (search !== '') {
        const haystack = `${userId}\u0000${row.name}`.toLowerCase();
        if (!haystack.includes(search)) continue;
      }
      const state = normalizeRaceState(decodeJsonSingletonBlob(row.blob));
      entries.push({
        playerId: row.playerId,
        userId,
        name: row.name,
        level: row.level,
        areaIndex: state.areaIndex,
        areaId: config.areaIds[state.areaIndex] ?? '',
        panelNumber: state.panelNumber,
        loopCount: state.loopCount,
        totalClearPanelCount: state.totalClearPanelCount,
        rank: rankByPlayer.get(row.playerId) ?? 0,
        pendingVenus: state.pendingVenus,
        difficultyNumber: state.difficultyNumber,
        effectiveDifficultyNumber: raceDifficultyNumber(state, config),
        lastUpdated: lastUpdatedIso(row.createdAt, state.lastActivityReceiveMs),
      });
    }
    // Ranking order first (unranked states last), ties by panel count then id.
    entries.sort((a, b) => {
      const aRank = a.rank === 0 ? Number.MAX_SAFE_INTEGER : a.rank;
      const bRank = b.rank === 0 ? Number.MAX_SAFE_INTEGER : b.rank;
      return (
        aRank - bRank ||
        b.totalClearPanelCount - a.totalClearPanelCount ||
        a.playerId.localeCompare(b.playerId)
      );
    });

    const page = entries.slice(offset, offset + limit);
    const result: PlayerListRow[] = [];
    for (const entry of page) {
      result.push({
        ...entry,
        racePoints: await itemBalance(entry.playerId, config.racePointItemId),
        medals: await itemBalance(entry.playerId, config.raceMedalItemId),
      });
    }
    return { total: entries.length, offset, limit, players: result };
  });

  app.get(
    '/sumire/admin/races/:raceId/players/:playerId',
    { preHandler: viewer },
    async (req, reply) => {
      const { raceId, playerId } = req.params as { raceId: string; playerId: string };
      const config = raceConfig(opts, raceId);
      if (config === undefined) return reply.code(404).send({ error: 'unknown race' });
      const detail = await playerDetail(raceId, playerId, config);
      if (detail === null) return reply.code(404).send({ error: 'player has no race state' });
      return { ...detail, areas: await buildAreaInfos(config, panelCountFor) };
    },
  );

  app.patch(
    '/sumire/admin/races/:raceId/players/:playerId',
    { preHandler: editor },
    async (req, reply) => {
      const { raceId, playerId } = req.params as { raceId: string; playerId: string };
      const config = raceConfig(opts, raceId);
      if (config === undefined) return reply.code(404).send({ error: 'unknown race' });
      const body = readJsonBody(req.body);
      if (body === null) return reply.code(400).send({ error: 'body must be an object' });

      const patch: {
        areaIndex?: number;
        panelNumber?: number;
        loopCount?: number;
        totalClearPanelCount?: number;
        pendingVenus?: boolean;
        currentLivePanelScore?: number;
        racePointAmount?: number;
        medalAmount?: number;
        clearCardCoolTimes?: boolean;
        /** `null` clears the frozen value so the next `Race:Top` re-derives it. */
        difficultyNumber?: number | null;
      } = {};
      const errors: string[] = [];
      const intField = (field: string): void => {
        if (body[field] === undefined) return;
        const parsed = parseNonNegativeInt(body[field], field);
        if (typeof parsed === 'string') errors.push(parsed);
        else (patch as Record<string, unknown>)[field] = parsed;
      };
      for (const field of [
        'areaIndex',
        'panelNumber',
        'loopCount',
        'totalClearPanelCount',
        'currentLivePanelScore',
        'racePointAmount',
        'medalAmount',
      ]) {
        intField(field);
      }
      for (const field of ['pendingVenus', 'clearCardCoolTimes'] as const) {
        if (body[field] === undefined) continue;
        if (typeof body[field] !== 'boolean') errors.push(`${field} must be a boolean`);
        else patch[field] = body[field] as boolean;
      }
      // `null` unfreezes the difficulty so the next `Race:Top` re-derives it
      // from the VENUS grade; a number pins it for this player.
      if (body.difficultyNumber !== undefined) {
        const value = body.difficultyNumber;
        if (value === null) {
          patch.difficultyNumber = null;
        } else if (
          typeof value === 'number' &&
          Number.isInteger(value) &&
          value >= 1 &&
          value <= 7
        ) {
          patch.difficultyNumber = value;
        } else {
          errors.push('difficultyNumber must be an integer between 1 and 7, or null');
        }
      }
      if (errors.length > 0) return reply.code(400).send({ error: errors[0], errors });
      if (Object.keys(patch).length === 0) {
        return reply.code(400).send({ error: 'no editable field in the body' });
      }

      const areaInfos = await buildAreaInfos(config, panelCountFor);
      if (patch.areaIndex !== undefined && patch.areaIndex >= areaInfos.length) {
        return reply.code(400).send({
          error: `areaIndex must be between 0 and ${Math.max(areaInfos.length - 1, 0)}`,
          areas: areaInfos,
        });
      }

      try {
        await withPlayerTx(playerId, async (tx) => {
          const [row] = await stateRows(raceId, tx).then((rows) =>
            rows.filter((candidate) => candidate.playerId === playerId),
          );
          if (!row) throw new PlayerRaceStateMissingError();
          const state = normalizeRaceState(decodeJsonSingletonBlob(row.blob));
          const areaIndex = patch.areaIndex ?? state.areaIndex;
          const area = areaInfos[areaIndex];
          if (area === undefined) throw new RaceInputError(`areaIndex ${areaIndex} is out of range`);
          if (patch.panelNumber !== undefined && patch.panelNumber > area.panelCount) {
            throw new RaceInputError(
              `panelNumber must be between 0 and ${area.panelCount} for ${area.areaId}`,
            );
          }
          // Moving area without an explicit panel keeps the old panel only when
          // it exists in the new area.
          if (
            patch.areaIndex !== undefined &&
            patch.panelNumber === undefined &&
            state.panelNumber > area.panelCount
          ) {
            throw new RaceInputError(
              `panelNumber ${state.panelNumber} does not exist in ${area.areaId}; send panelNumber`,
            );
          }
          if (patch.areaIndex !== undefined) state.areaIndex = patch.areaIndex;
          if (patch.panelNumber !== undefined) state.panelNumber = patch.panelNumber;
          if (patch.loopCount !== undefined) state.loopCount = patch.loopCount;
          if (patch.totalClearPanelCount !== undefined) {
            state.totalClearPanelCount = patch.totalClearPanelCount;
          }
          if (patch.pendingVenus !== undefined) state.pendingVenus = patch.pendingVenus;
          if (patch.currentLivePanelScore !== undefined) {
            state.currentLivePanelScore = patch.currentLivePanelScore;
          }
          if (patch.clearCardCoolTimes === true) state.cardCoolTimes = {};
          if (patch.difficultyNumber !== undefined) {
            state.difficultyNumber = patch.difficultyNumber;
          }
          if (patch.racePointAmount !== undefined) {
            if (config.racePointItemId === '') {
              throw new RaceInputError('race has no race point item');
            }
            await setItemAmount(playerId, config.racePointItemId, patch.racePointAmount, tx);
          }
          if (patch.medalAmount !== undefined) {
            if (config.raceMedalItemId === '') {
              throw new RaceInputError('race has no medal item');
            }
            await setItemAmount(playerId, config.raceMedalItemId, patch.medalAmount, tx);
          }
          await saveRaceState(playerId, raceId, state, tx);
        });
      } catch (error) {
        if (error instanceof PlayerRaceStateMissingError) {
          return reply.code(404).send({ error: 'player has no race state' });
        }
        if (error instanceof RaceInputError) {
          return reply.code(400).send({ error: error.message });
        }
        throw error;
      }

      return { ...(await playerDetail(raceId, playerId, config)), areas: areaInfos };
    },
  );

  app.post(
    '/sumire/admin/races/:raceId/players/:playerId/reset',
    { preHandler: editor },
    async (req, reply) => {
      const { raceId, playerId } = req.params as { raceId: string; playerId: string };
      const config = raceConfig(opts, raceId);
      if (config === undefined) return reply.code(404).send({ error: 'unknown race' });

      const [row] = await stateRows(raceId).then((rows) =>
        rows.filter((candidate) => candidate.playerId === playerId),
      );
      if (!row) return reply.code(404).send({ error: 'player has no race state' });

      // A fresh state as the next `Home:Enter`/`Race:Top` would leave it. The
      // initial race-point grant is not repeated here: points are an item
      // balance, and re-granting them on every reset would silently create
      // currency. Use PATCH racePointAmount to set the balance explicitly.
      await withPlayerTx(playerId, async (tx) => {
        const state = emptyRaceState();
        markRaceInitialLogin(state);
        await saveRaceState(playerId, raceId, state, tx);
      });

      return {
        ...(await playerDetail(raceId, playerId, config)),
        areas: await buildAreaInfos(config, panelCountFor),
      };
    },
  );

  app.get('/sumire/admin/races/:raceId/ranking', { preHandler: viewer }, async (req, reply) => {
    const { raceId } = req.params as { raceId: string };
    if (raceConfig(opts, raceId) === undefined) {
      return reply.code(404).send({ error: 'unknown race' });
    }
    const query = req.query as Record<string, unknown>;
    const limit = parseQueryInt(query.limit, RANKING_MAX_LIMIT, 1, RANKING_MAX_LIMIT);

    const entries = (await raceRanking(raceId)).slice(0, limit);
    // One read of the player rows, keyed by id (same shape as Race:Ranking).
    // Bots are not players: they never own a row, so they are not looked up and
    // stay out of this live-ops list.
    const playerRows = new Map<string, typeof players.$inferSelect>();
    const realIds = entries
      .map((entry) => entry.playerId)
      .filter((playerId) => !isRaceBotId(playerId));
    if (realIds.length > 0) {
      const found = await db.select().from(players).where(inArray(players.id, realIds));
      for (const row of found) playerRows.set(row.id, row);
    }

    const ranking = [];
    for (const entry of entries) {
      const row = playerRows.get(entry.playerId);
      if (!row) continue;
      const user = await getSingleton(entry.playerId, 'User');
      ranking.push({
        playerId: entry.playerId,
        userId: publicUserIdOf(row),
        name: row.name,
        managerLevel: row.level,
        clearPanelCount: entry.state.totalClearPanelCount,
        rank: entry.rank,
        emblemId: String(user?.EmblemId ?? ''),
      });
    }
    return { ranking, displayNum: RANKING_MAX_LIMIT };
  });
};

class PlayerRaceStateMissingError extends Error {
  constructor() {
    super('player has no race state');
    this.name = 'PlayerRaceStateMissingError';
  }
}

class RaceInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RaceInputError';
  }
}
