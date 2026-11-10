import '@sumire-sr/protocol/gen/registry.ts';
import type { FastifyInstance } from 'fastify';
import { authenticate } from '../auth/authenticate.ts';
import { db } from '../db/client.ts';
import type { Executor } from '../db/tx.ts';
import { getCharacter, getMessage, getTelephone, listMessageGroups } from '../master/index.ts';
import { findPlayerByAccountId, listElements } from './playerState.ts';

/**
 * Pending idol messages and calls for the HoshimiLocalify-sr mod.
 *
 * The official game delivered message/call alerts as FCM pushes, which a
 * private server cannot send. Instead the mod calls this plain JSON route with
 * the game's own `x-auth-token` JWT when the game goes to the background, and
 * schedules Android local notifications for each item's due time.
 */

const MESSAGE_SCHEDULED = 2;
const TELEPHONE_SCHEDULED = 2;

export type PendingNarrativeItem = {
  kind: 'message' | 'telephone';
  /** MessageId or TelephoneId. */
  id: string;
  /** Epoch ms when the client will receive it. */
  dueAt: number;
  characterId: string;
  /** Master `Character.Name` (Japanese); empty when the master row is missing. */
  characterName: string;
  /** Messages only: master `MessageGroup.Name`, omitted when empty. */
  title?: string;
};

/** Scheduled messages and calls whose due time is still after `now`, soonest first. */
export async function listPendingNarrative(
  playerId: string,
  now: number,
  exec: Executor = db,
): Promise<PendingNarrativeItem[]> {
  const [messages, schedules, telephones] = await Promise.all([
    listElements(playerId, 'Messages', exec),
    listElements(playerId, 'MessageSchedules', exec),
    listElements(playerId, 'Telephones', exec),
  ]);

  const characterNames = new Map<string, string>();
  const characterName = async (id: string): Promise<string> => {
    let name = characterNames.get(id);
    if (name === undefined) {
      name = (await getCharacter(id))?.Name ?? '';
      characterNames.set(id, name);
    }
    return name;
  };
  let groupNames: Map<string, string> | null = null;
  const groupName = async (id: string): Promise<string> => {
    groupNames ??= new Map((await listMessageGroups()).map((g) => [g.Id, g.Name ?? '']));
    return groupNames.get(id) ?? '';
  };

  const scheduledTimes = new Map<string, number>();
  for (const s of schedules) scheduledTimes.set(String(s.MessageId), Number(s.ScheduledTime ?? 0));

  const items: PendingNarrativeItem[] = [];
  for (const m of messages) {
    if (Number(m.MessageStatusType) !== MESSAGE_SCHEDULED) continue;
    const id = String(m.MessageId);
    const dueAt = scheduledTimes.get(id);
    if (dueAt === undefined || dueAt <= now) continue;
    const master = await getMessage(id);
    if (!master?.CharacterId) continue;
    const item: PendingNarrativeItem = {
      kind: 'message',
      id,
      dueAt,
      characterId: master.CharacterId,
      characterName: await characterName(master.CharacterId),
    };
    const title = master.MessageGroupId ? await groupName(master.MessageGroupId) : '';
    if (title) item.title = title;
    items.push(item);
  }
  for (const t of telephones) {
    if (Number(t.TelephoneStatusType) !== TELEPHONE_SCHEDULED) continue;
    const dueAt = Number(t.ScheduledTime ?? 0);
    if (dueAt <= now) continue;
    const id = String(t.TelephoneId);
    const master = await getTelephone(id);
    if (!master?.CharacterId) continue;
    items.push({
      kind: 'telephone',
      id,
      dueAt,
      characterId: master.CharacterId,
      characterName: await characterName(master.CharacterId),
    });
  }
  return items.sort((a, b) => a.dueAt - b.dueAt);
}

export function registerNarrativePendingRoute(app: FastifyInstance): void {
  app.get('/mod/narrative/pending', async (req, reply) => {
    const auth = authenticate(
      (req.headers['x-auth-token'] as string) ?? (req.headers.authorization as string),
    );
    if (!auth.ok || !auth.claims?.sub) return reply.code(401).send({ error: 'unauthenticated' });
    const player = await findPlayerByAccountId(auth.claims.sub);
    if (!player) return reply.code(404).send({ error: 'no player' });
    const now = Date.now();
    const items = await listPendingNarrative(player.id, now);
    return reply.header('cache-control', 'no-store').send({ serverTime: now, items });
  });
}
