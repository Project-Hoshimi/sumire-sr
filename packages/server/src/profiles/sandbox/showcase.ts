/**
 * Sandbox Showcase policy.
 *
 * The official game always exposes at least five display cases (master
 * Condition `cd-showcase-005-view`), while a fresh sandbox account has no rows
 * in `Showcases`. These helpers pad the `Showcase:Top` response with default
 * cases and grant a full stack of every showcase toy, without persisting the
 * padded cases (the first `Showcase:Save` writes the real row).
 */
import type { Decoded } from '@sumire-sr/protocol/runtime/proto.ts';

/** Copies of every showcase toy (goods item) a sandbox player owns. */
export const SANDBOX_SHOWCASE_TOY_AMOUNT = 99;

/** Display cases `Showcase:Top` always lists in the sandbox. */
export const SANDBOX_SHOWCASE_CASE_COUNT = 5;

/**
 * Fill the gaps in 1..count with default showcases. Saved rows are kept
 * unchanged (including rows numbered above `count`), and the result is sorted
 * by `Number` ascending.
 */
export function withSandboxShowcaseSlots(
  saved: Decoded[],
  count: number,
  makeDefault: (number: number) => Decoded,
): Decoded[] {
  const present = new Set(saved.map((s) => Number(s.Number ?? 0)));
  const slots = [...saved];
  for (let n = 1; n <= count; n++) {
    if (!present.has(n)) slots.push(makeDefault(n));
  }
  return slots.sort((a, b) => Number(a.Number ?? 0) - Number(b.Number ?? 0));
}

/**
 * Placeholder goods shops for `Showcase:Top`. The client's goods-shop screen
 * reads the first `Shops` entry before it calls the server, so an empty list
 * crashes it, and its fixed shop button looks up the entry whose `Type`
 * matches the button (`Enumerable.First`), so each default shop type needs an
 * entry too. Opening any of them calls `Shop:ListItem`, which
 * `SANDBOX_BLOCKED_RPCS` refuses: the player sees the "Not implemented"
 * dialog instead of a frozen screen. Sandbox players already own every toy.
 */
export const SANDBOX_SHOWCASE_SHOP_TYPES = [
  5, // ShopType.ShowcaseToyShop
  1003, // ShopType.DefaultShowcaseToyShop
  2001, // ShopType.OnlyShowcaseShop
] as const;

export function sandboxShowcaseShops(): Decoded[] {
  return SANDBOX_SHOWCASE_SHOP_TYPES.map((type, i) => ({
    __msg: 'Solis.Common.Proto.Api.ShopInfo',
    Id: `sandbox-showcase-toy-shop-${type}`,
    Name: 'Goods Shop',
    Type: type,
    Order: i + 1,
  } as Decoded));
}

/** `GachaType.ShowcaseToy`: the goods shop's "開封" (opening) packs. */
const SHOWCASE_TOY_GACHA_TYPE = 6;

/**
 * Whether `Gacha:Draw` must refuse this gacha in the sandbox. The goods-shop
 * screen itself cannot be blocked (it reuses `Showcase:Top`, the showcase
 * home's own call), but its toy packs reference assets the client does not
 * have, and sandbox players already own every toy.
 */
export function isSandboxBlockedGacha(gacha: { GachaType?: unknown } | null | undefined): boolean {
  return Number(gacha?.GachaType ?? 0) === SHOWCASE_TOY_GACHA_TYPE;
}
