import { getCorpusResponse, getFreshCaptureByName, loadCorpus } from './corpus.ts';
import { register, listNames } from '../handlers.ts';
import { type RpcContext } from '../handlers.ts';
import { findPlayerByAccountId, isFreshPlayer } from '../playerState.ts';

// Replay-only RPCs whose fresh-account reply is safe to serve: they carry no
// dated master ids. Dokan:List, Story:ListEvent and Home:Enter in the fresh
// capture reference October content our September master lacks.
const FRESH_REPLAY = new Set(['Quest:Top', 'Quest:ListAsset', 'Message:ListGroup', 'Message:Timeline']);

/** Register a replay handler for every captured endpoint that lacks a real handler. */
export function registerReplayHandlers() {
  const corpus = loadCorpus();
  const existing = new Set(listNames());
  let count = 0;
  for (const name of corpus.keys()) {
    if (existing.has(name)) continue;
    register(name, async (ctx: RpcContext) => {
      // Fresh accounts get the official fresh-account reply for FRESH_REPLAY,
      // not the veteran's.
      const pl = FRESH_REPLAY.has(ctx.name)
        ? await findPlayerByAccountId(ctx.auth.ok ? ctx.auth.claims?.sub : undefined)
        : undefined;
      const fresh = pl && isFreshPlayer(pl) ? getFreshCaptureByName(ctx.name) : null;
      if (fresh) return fresh;
      const b = getCorpusResponse(ctx.name);
      if (!b) throw new Error(`corpus has no response for ${ctx.name}`);
      return b;
    });
    count++;
  }
  return count;
}
