// Public API of the TypeScript port of Solis internal/makino/live.
//
// Pure: no database, no HTTP, no filesystem. The caller supplies master rows,
// player card data and a seed; the result is a protobuf-shaped LiveResult.

export { RULESET_VERSION } from './input.ts';
export type { CardData, Input, StrengthModifier } from './input.ts';

export { simulate, Simulation, emptyCardData } from './engine.ts';
export {
  NPCBalance,
  NPCRoster,
  AllocateAudience,
  ResolveCharacterAdvantage,
  PhotoTargetIndexes,
  ExtraCharacterIDs,
} from './preparation.ts';
export type { NPCBonuses } from './preparation.ts';
export { beatScoreCoefficientPermil } from './beatCoefficient.ts';
export { statusCoefficient } from './status.ts';
export { newRand, PCG, Rand } from './pcg.ts';
export { npcBalance } from './data/npcBalance.ts';
export { npcRosters } from './data/npcRosters.ts';
export * from './enums.ts';
export type * from './types.ts';
