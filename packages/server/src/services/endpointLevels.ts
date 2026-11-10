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
  'Anniversary:OutputTransitionLog': 'stub',
  'Auth:Login': 'sandbox-ok',
  'Deck:BuddyList': 'stub',
  'Dokan:List': 'stub',
  'Health:Check': 'stub',
  'Home:Enter': 'sandbox-ok',
  'Home:Login': 'sandbox-ok',
  'Home:SetReview': 'stub',
  'Master:Get': 'sandbox-ok',
  'Mission:Event': 'stub',
  'Mission:List': 'stub',
  'Profile:ClearTwitterMission': 'stub',
  'System:Check': 'sandbox-ok',
  'User:Get': 'sandbox-ok',
  'Warning:SetDisplayed': 'stub',
};
