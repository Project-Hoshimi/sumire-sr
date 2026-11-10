// Converted from Solis internal/makino/live/scoring.yaml.
// sumire-sr has no YAML dependency, so the embedded table is a typed literal.

/**
 * Capture-verified exceptions to round(8000 / (reference beat count + 1)).
 * Keys are music IDs, values are permil coefficients (1..4000).
 */
export const beatScoreCoefficientPermilOverrides: Readonly<Record<string, number>> = {
  'music-hsm-001': 57,
};
