// Converted from Solis internal/makino/live/npc_balance.yaml.
// sumire-sr has no YAML dependency, so the embedded table is a typed literal.

export interface NpcCurve {
  /** baseAddition */
  Base: number;
  /** growthAtAnchor */
  Growth: number;
  /** minimumThresholdPermil */
  Minimum: number;
}

export interface NpcBalanceConfig {
  Version: string;
  Start: number;
  Anchor: number;
  Tail: string;
  Primary: NpcCurve;
  Stamina: NpcCurve;
  Mental: NpcCurve;
  Technique: NpcCurve;
}

export const npcBalance: NpcBalanceConfig = {
  Version: 'npc-balance-v1',
  Start: 33,
  Anchor: 320,
  Tail: 'linear-tangent',
  Primary: { Base: 350, Growth: 310000, Minimum: 0 },
  Stamina: { Base: 0, Growth: 10000, Minimum: 0 },
  Mental: { Base: 30, Growth: 7700, Minimum: 900 },
  Technique: { Base: 30, Growth: 8700, Minimum: 0 },
};
