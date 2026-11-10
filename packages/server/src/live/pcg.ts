// PCG source and Rand helpers, ported from Go's math/rand/v2 `rand.NewPCG`.
//
// The simulator must reproduce Go's random stream for a given seed, so the
// 128-bit state arithmetic is done with BigInt and every operation is masked to
// its Go width. `Rand` mirrors the two methods the simulator uses: Float64 and
// IntN.

const mask64 = (1n << 64n) - 1n;
const mask128 = (1n << 128n) - 1n;

const mulHi = 2549297995355413924n;
const mulLo = 4865540595714422341n;
const incHi = 6364136223846793005n;
const incLo = 1442695040888963407n;
const mul = (mulHi << 64n) | mulLo;
const inc = (incHi << 64n) | incLo;

const cheapMul = 0xda942042e4dd58b5n;
const mask53 = (1n << 53n) - 1n;
const twoPow53 = 2 ** 53;

/** PCG (XSL-RR 128/64) generator, matching rand.NewPCG(seed1, seed2). */
export class PCG {
  private hi: bigint;
  private lo: bigint;

  constructor(seed1: bigint, seed2: bigint) {
    this.hi = seed1 & mask64;
    this.lo = seed2 & mask64;
  }

  /** Advance the 128-bit state and return it. */
  next(): { hi: bigint; lo: bigint } {
    const state = (((this.hi << 64n) | this.lo) * mul + inc) & mask128;
    this.hi = state >> 64n;
    this.lo = state & mask64;
    return { hi: this.hi, lo: this.lo };
  }

  /** XSL-RR output function. */
  uint64(): bigint {
    const { hi: hiIn, lo } = this.next();
    let hi = hiIn;
    hi ^= hi >> 32n;
    hi = (hi * cheapMul) & mask64;
    hi ^= hi >> 48n;
    hi = (hi * (lo | 1n)) & mask64;
    return hi;
  }
}

/**
 * The subset of math/rand/v2 Rand the simulator uses.
 *
 * Float64 keeps the low 53 bits, matching Go's `float64(r.Uint64()<<11>>11) / (1<<53)`.
 */
export class Rand {
  private readonly source: PCG;

  constructor(source: PCG) {
    this.source = source;
  }

  /** math/rand/v2 Rand.Uint64. */
  uint64(): bigint {
    return this.source.uint64();
  }

  /** math/rand/v2 Rand.Float64: uniform in [0,1). */
  float64(): number {
    return Number(this.source.uint64() & mask53) / twoPow53;
  }

  /** math/rand/v2 Rand.IntN for n > 0. */
  intN(nIn: number): number {
    if (!Number.isInteger(nIn) || nIn <= 0) throw new RangeError('invalid argument to IntN');
    const bound = BigInt(nIn);
    if (bound > mask64) throw new RangeError('invalid argument to IntN');
    // Power-of-two fast path: mask instead of rejecting.
    if ((bound & (bound - 1n)) === 0n) {
      return Number(this.source.uint64() & (bound - 1n));
    }
    const product = this.source.uint64() * bound;
    let hi = product >> 64n;
    let lo = product & mask64;
    if (lo < bound) {
      // thresh = (2^64 - n) % n, i.e. Go's `-n % n` on unsigned arithmetic.
      const thresh = ((1n << 64n) - bound) % bound;
      while (lo < thresh) {
        const retry = this.source.uint64() * bound;
        hi = retry >> 64n;
        lo = retry & mask64;
      }
    }
    return Number(hi);
  }
}

/** rand.New(rand.NewPCG(seed, seed ^ 0x9e3779b97f4a7c15)), as used by the engine. */
export function newRand(seed: bigint): Rand {
  const mixed = (seed & mask64) ^ 0x9e3779b97f4a7c15n;
  return new Rand(new PCG(seed & mask64, mixed));
}
