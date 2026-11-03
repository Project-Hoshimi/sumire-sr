import { eq } from 'drizzle-orm';
import { register } from './handlers.ts';
import { db } from '../db/client.ts';
import { withPlayerTx, type Executor } from '../db/tx.ts';
import { players } from '../db/schema.ts';
import { getEventStory, getExtraStory, getStory, master } from '../master/index.ts';
import { applyRewardRefs } from '../master/reward.ts';
import { isSandbox } from '../profile.ts';
import {
  sandboxEventStoryInfos,
  sandboxExtraStoryPartInfos,
} from '../profiles/sandbox/story.ts';
import { listElements, putElements } from './playerState.ts';
import { getCard as getUserCard } from './inventory.ts';
import { cardStoryIdsForLevel } from './cardStories.ts';
import type { Decoded } from '@sumire-sr/protocol/runtime/proto.ts';

/**
 * Server-authoritative story reading.
 *
 * Only `Story:Read` was captured; the remaining endpoints are built from the
 * generated schema and validated with `dbtest.ts` (no byte-exact verification).
 * Reading a story grants its `RewardId` exactly once and records the story as
 * read (`StatusType = 2`) in the player's `Stories` collection.
 *
 * Scope note: `CardStory` / `CharacterCompanyEnjoyStory` master tables are not
 * present in this build, so their read handlers are permissive no-ops for now.
 */

const COMMON_RESPONSE_MSG = 'Solis.Common.Proto.Api.CommonResponse';
const UPDATED_DATA_MSG = 'Solis.Common.Proto.Api.UpdatedData';
const DELETED_DATA_MSG = 'Solis.Common.Proto.Api.DeletedData';
const USER_STORY_MSG = 'Solis.Common.Proto.Transaction.UserStory';

const STORY_STATUS_READ = 2;

/**
 * A card story's id embeds its owning card id (`st-card-ai-05-arab-00-01` →
 * `card-ai-05-arab-00`). Returns the card id or null when the story is not a
 * card story.
 */
function cardIdOfStory(storyId: string): string | null {
  if (!storyId.startsWith('st-card-')) return null;
  const stripped = storyId.slice('st-card-'.length);
  return `card-${stripped.slice(0, -3)}`;
}

function accountOf(ctx: { auth: { ok: boolean; claims?: { sub?: string } } }): string {
  const accountId = ctx.auth.ok ? ctx.auth.claims?.sub : undefined;
  if (!accountId) throw new Error('unauthenticated');
  return accountId;
}

async function playerForAccount(accountId: string, rpc: string, exec: Executor = db) {
  const [pl] = await exec.select().from(players).where(eq(players.accountId, accountId)).limit(1);
  if (!pl) throw new Error(`${rpc}: no player for account`);
  return pl;
}

function commonResponse(updated: Decoded | null, deleted: Decoded | null = null): Decoded {
  return {
    __msg: COMMON_RESPONSE_MSG,
    UpdatedData: (updated ?? { __msg: UPDATED_DATA_MSG }) as Decoded,
    DeletedData: (deleted ?? { __msg: DELETED_DATA_MSG }) as Decoded,
  } as Decoded;
}

function updatedData(...entries: Array<[string, unknown]>): Decoded {
  const out: Decoded = { __msg: UPDATED_DATA_MSG } as Decoded;
  for (const [k, v] of entries) {
    if (v !== undefined && v !== null) out[k] = v as Decoded;
  }
  return out;
}

type ReadResult = { updated: Decoded; deleted: Decoded | null; rewards: Decoded[] };

/**
 * Grant a story's reward (once) and mark it read. Idempotent: a story already
 * at `StatusType = Read` returns its current entry without re-granting.
 */
async function performRead(accountId: string, rpc: string, storyId: string): Promise<ReadResult> {
  const story = await getStory(storyId);
  if (!story) throw new Error(`${rpc}: unknown Story ${storyId}`);

  const pl = await playerForAccount(accountId, rpc);
  const owningCardId = cardIdOfStory(storyId);

  return withPlayerTx(pl.id, async (tx) => {
    const stories = await listElements(pl.id, 'Stories', tx);
    const existing = stories.find((s) => String(s.StoryId ?? '') === storyId);
    if (existing && Number(existing.StatusType ?? 0) === STORY_STATUS_READ) {
      return { updated: updatedData(['Stories', [existing]]), deleted: null, rewards: [] };
    }

    // Card stories are gated by the owning card's level (PLANS §1.7): require
    // the card to be owned and its current level to unlock this episode.
    if (owningCardId) {
      const card = await getUserCard(pl.id, owningCardId, tx);
      if (!card) throw new Error(`${rpc}: owning card not owned ${owningCardId}`);
      const unlocked = await cardStoryIdsForLevel(owningCardId, Number(card.Level ?? 1));
      if (!unlocked.includes(storyId)) {
        throw new Error(`${rpc}: episode ${storyId} not unlocked at card level ${card.Level}`);
      }
    }

    const rewardId = story.RewardId == null ? '' : String(story.RewardId);
    const applied = rewardId ? await applyRewardRefs(pl.id, [rewardId], tx) : null;
    const userStory = { __msg: USER_STORY_MSG, StoryId: storyId, StatusType: STORY_STATUS_READ } as Decoded;
    await putElements(pl.id, 'Stories', [userStory], tx);

    const updated = applied?.updated ?? ({ __msg: UPDATED_DATA_MSG } as Decoded);
    updated.Stories = [userStory];
    return { updated, deleted: null, rewards: applied?.results ?? [] };
  });
}

function readEnvelope(res: ReadResult): Decoded {
  return {
    __msg: '',
    Rewards: res.rewards,
    CommonResponse: commonResponse(res.updated, res.deleted),
  } as Decoded;
}

function emptyReadEnvelope(updated: Decoded | null = null): Decoded {
  return { __msg: '', Rewards: [], CommonResponse: commonResponse(updated) } as Decoded;
}

function commonOnly(): Decoded {
  return { __msg: '', CommonResponse: commonResponse(null) } as Decoded;
}

/** `Story:Read` — read a main/shelf/group story: grant reward once, mark read. */
register(
  'Story:Read',
  async (ctx) => {
    const accountId = accountOf(ctx);
    const storyId = ctx.request?.StoryId == null ? '' : String(ctx.request.StoryId);
    if (!storyId) throw new Error('Story:Read: missing StoryId');
    const res = await performRead(accountId, 'Story:Read', storyId);
    ctx.fastifyReq.log.info({ accountId, storyId, rewarded: res.rewards.length > 0 }, 'story read');
    return readEnvelope(res);
  },
  { ownsState: true },
);

/** `Story:ReleaseEpisode` — permissive no-op (unlock gating deferred). */
register(
  'Story:ReleaseEpisode',
  async (ctx) => {
    accountOf(ctx);
    ctx.fastifyReq.log.info(
      { storyPartId: ctx.request?.StoryPartId, episode: ctx.request?.Episode },
      'story release episode',
    );
    return commonOnly();
  },
  { ownsState: true },
);

/** `Story:ListEvent` — event story list (sandbox: every event story unlocked). */
register(
  'Story:ListEvent',
  async () => {
    const infos = isSandbox()
      ? sandboxEventStoryInfos(await db.select().from(master.masterEventStory))
      : [];
    return { __msg: '', Infos: infos, CommonResponse: commonResponse(null) } as Decoded;
  },
  { ownsState: true },
);

/** `Story:ReadEvent` — read an event story episode by its `EventStoryId`. */
register(
  'Story:ReadEvent',
  async (ctx) => {
    const accountId = accountOf(ctx);
    const eventStoryId = ctx.request?.EventStoryId == null ? '' : String(ctx.request.EventStoryId);
    const episode = Number(ctx.request?.Episode ?? 0);
    if (!eventStoryId) throw new Error('Story:ReadEvent: missing EventStoryId');
    const event = await getEventStory(eventStoryId);
    if (!event) throw new Error(`Story:ReadEvent: unknown EventStory ${eventStoryId}`);
    const episodes = (event.Episodes as Decoded[] | null) ?? [];
    const ep = episodes.find((e) => Number(e.Episode ?? 0) === episode);
    const storyId = ep?.StoryId == null ? '' : String(ep.StoryId);
    if (!storyId) throw new Error(`Story:ReadEvent: unknown Episode ${eventStoryId}/${episode}`);
    const res = await performRead(accountId, 'Story:ReadEvent', storyId);
    return readEnvelope(res);
  },
  { ownsState: true },
);

/** `Story:ListExtra` — extra story list (sandbox: every extra story unlocked). */
register(
  'Story:ListExtra',
  async () => {
    const infos = isSandbox()
      ? sandboxExtraStoryPartInfos(
          await db.select().from(master.masterExtraStoryPart),
          await db.select().from(master.masterExtraStory),
        )
      : [];
    return { __msg: '', Infos: infos, CommonResponse: commonResponse(null) } as Decoded;
  },
  { ownsState: true },
);

/** `Story:ReadExtra` — read an extra story episode by its `ExtraStoryId`. */
register(
  'Story:ReadExtra',
  async (ctx) => {
    const accountId = accountOf(ctx);
    const extraStoryId = ctx.request?.ExtraStoryId == null ? '' : String(ctx.request.ExtraStoryId);
    const episode = Number(ctx.request?.Episode ?? 0);
    if (!extraStoryId) throw new Error('Story:ReadExtra: missing ExtraStoryId');
    const extra = await getExtraStory(extraStoryId);
    if (!extra) throw new Error(`Story:ReadExtra: unknown ExtraStory ${extraStoryId}`);
    const episodes = (extra.Episodes as Decoded[] | null) ?? [];
    const ep = episodes.find((e) => Number(e.Episode ?? 0) === episode);
    const storyId = ep?.StoryId == null ? '' : String(ep.StoryId);
    if (!storyId) throw new Error(`Story:ReadExtra: unknown Episode ${extraStoryId}/${episode}`);
    const res = await performRead(accountId, 'Story:ReadExtra', storyId);
    return readEnvelope(res);
  },
  { ownsState: true },
);

/** `Story:ReadAnniversaryStory` — permissive no-op (no master in this build). */
register(
  'Story:ReadAnniversaryStory',
  async (ctx) => {
    accountOf(ctx);
    return emptyReadEnvelope();
  },
  { ownsState: true },
);

/** `Story:ReadCharacterCompanyEnjoyStory` — stub (master table absent, deferred). */
register(
  'Story:ReadCharacterCompanyEnjoyStory',
  async (ctx) => {
    accountOf(ctx);
    return emptyReadEnvelope();
  },
  { ownsState: true },
);
