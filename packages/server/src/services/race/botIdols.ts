// Master idol list that names the synthetic race bots when the race author
// leaves the bot names empty, and the character filter shared by the board
// rival list. Kept in its own module so `ranking.ts` can reach it without
// importing `rivals.ts`, which itself imports `ranking.ts`.
import { listCharacters } from '../../master/index.ts';

/** Master `Character` row fields this module reads. */
export interface RivalCharacter {
  Id: string;
  Name: string | null;
  /** Master `Character.Type` (bigint column: number or numeric string). */
  Type?: number | string | null;
}

/**
 * Master `Character.Type` values that are real playable idols: 1 = main idols,
 * 3 = Memories, 4 = collaboration idols. Type 2 is story NPCs and one-off
 * guests (e.g. `char-haruhi`, `char-cinnamo`): they own no cards and ship no
 * `img_chr_icon_*` asset, so a rival drawn from them renders an empty icon
 * (Octo `name_not_found`). Mirrors `SANDBOX_IDOL_TYPES` in
 * `profiles/sandbox/seed.ts`.
 */
export const RACE_RIVAL_CHARACTER_TYPES: ReadonlySet<number> = new Set([1, 3, 4]);

/** Whether `character` is a real idol that can stand in as a rival. */
export function isRivalCharacter(character: RivalCharacter): boolean {
  return RACE_RIVAL_CHARACTER_TYPES.has(Number(character.Type ?? 0));
}

/**
 * The idols race bots are named after and dressed as: the master characters
 * that are real playable idols, with a non-empty name, sorted by id so the
 * rotation is stable.
 */
export async function raceBotIdols(): Promise<{ id: string; name: string }[]> {
  const characters = (await listCharacters()) as unknown as RivalCharacter[];
  return characters
    .filter(isRivalCharacter)
    .map((character) => ({ id: String(character.Id ?? ''), name: String(character.Name ?? '') }))
    .filter((idol) => idol.id !== '' && idol.name !== '')
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
