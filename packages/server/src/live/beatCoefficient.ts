// Ported from Solis internal/makino/live/beat_coefficient.go.

import { MusicChartType } from './enums.ts';
import type { MusicChartPattern } from './types.ts';
import { beatScoreCoefficientPermilOverrides } from './data/scoring.ts';
import { n } from './util.ts';

let validated = false;

function overrides(): Readonly<Record<string, number>> {
  if (!validated) {
    for (const [id, coefficient] of Object.entries(beatScoreCoefficientPermilOverrides)) {
      if (id === '' || coefficient <= 0 || coefficient > 4000) {
        throw new Error(`invalid beat score coefficient for "${id}"`);
      }
    }
    validated = true;
  }
  return beatScoreCoefficientPermilOverrides;
}

function countBeats(chart: readonly MusicChartPattern[] | null | undefined): number {
  let beats = 0;
  for (const row of chart ?? []) {
    if (row === null || row === undefined) throw new Error('nil live chart row');
    if (n(row.Type) === MusicChartType.Beat) beats++;
  }
  return beats;
}

/**
 * Approximates the song's normalization using its reference (-001) chart,
 * regardless of which quest chart is being played. Captures support rounding
 * 8000/(reference beats+1) to an integer permil; neither the official reference
 * selection nor the +1 convention is proven.
 *
 * Missing/skill-only reference charts fall back to the actual chart, using the
 * same formula. A live with no ordinary beats needs no beat coefficient.
 */
export function beatScoreCoefficientPermil(
  musicID: string,
  referenceChart: readonly MusicChartPattern[] | null | undefined,
  actualChart: readonly MusicChartPattern[] | null | undefined,
): number {
  let beats = countBeats(referenceChart);
  if (beats === 0) beats = countBeats(actualChart);
  if (beats === 0) return 0;
  const override = overrides()[musicID];
  if (override !== undefined && override !== 0) return override;
  const divisor = beats + 1;
  return Math.trunc((8000 + Math.trunc(divisor / 2)) / divisor);
}
