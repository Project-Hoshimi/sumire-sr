/**
 * Recorded status level per RPC endpoint. This is the single place to record
 * a level; `npm run docs:endpoints` reads this file to build docs/ENDPOINTS.md.
 *
 * Levels are defined in ROADMAP.md. An endpoint with a handler and no entry
 * here is listed as `unrated`. An endpoint with no handler and no entry is
 * `missing`. Add or raise an entry only with evidence (a live check for
 * `sandbox-ok`, capture-based tests for `parity`).
 *
 * Keep one entry per line, sorted by name: the generator parses this file as text.
 */
export type EndpointLevel = 'stub' | 'sandbox-ok' | 'parity';

export const ENDPOINT_LEVELS: Readonly<Record<string, EndpointLevel>> = {
  'Auth:Login': 'sandbox-ok',
  'Home:Enter': 'sandbox-ok',
  'Home:Login': 'sandbox-ok',
  'Master:Get': 'sandbox-ok',
  'System:Check': 'sandbox-ok',
  'User:Get': 'sandbox-ok',
};
