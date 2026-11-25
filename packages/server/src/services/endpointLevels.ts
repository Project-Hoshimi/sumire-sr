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
  'Deck:Delete': 'sandbox-ok',
  'Dokan:List': 'stub',
  'Friend:Apply': 'sandbox-ok',
  'Friend:Approve': 'sandbox-ok',
  'Friend:Cancel': 'sandbox-ok',
  'Friend:Delete': 'sandbox-ok',
  'Friend:List': 'sandbox-ok',
  'Friend:ListApplied': 'sandbox-ok',
  'Friend:ListApplying': 'sandbox-ok',
  'Friend:Reject': 'sandbox-ok',
  'Health:Check': 'stub',
  'Home:Enter': 'sandbox-ok',
  'Home:Login': 'sandbox-ok',
  'Home:SetReview': 'stub',
  'Item:Sell': 'sandbox-ok',
  'Marathon:BuddyDeck': 'stub',
  'Marathon:CheckRaidProgress': 'stub',
  'Marathon:DrawBoxGacha': 'stub',
  'Marathon:FinishRaid': 'stub',
  'Marathon:GetRaidHistoryDetail': 'stub',
  'Marathon:JoinRaid': 'stub',
  'Marathon:ListDeck': 'stub',
  'Marathon:ListQuestAsset': 'stub',
  'Marathon:ListRaid': 'stub',
  'Marathon:ListRaidDeck': 'stub',
  'Marathon:ListRaidHistory': 'stub',
  'Marathon:ListRaidRanking': 'stub',
  'Marathon:ResetBoxGacha': 'stub',
  'Marathon:SaveDeck': 'stub',
  'Marathon:SaveRaidDeck': 'stub',
  'Marathon:StartQuest': 'stub',
  'Marathon:StartRaid': 'stub',
  'Marathon:Top': 'stub',
  'Marathon:UnlockQuest': 'stub',
  'Marathon:UseQuestStaminaRecoveryItem': 'stub',
  'Marathon:UseRaidStaminaRecoveryItem': 'stub',
  'Master:Get': 'sandbox-ok',
  'Mission:Event': 'stub',
  'Mission:List': 'stub',
  'Profile:ClearTwitterMission': 'stub',
  'Profile:FindUser': 'sandbox-ok',
  'Quest:OutputLiveResultDetailLog': 'stub',
  'Race:EnhanceLiveBonus': 'stub',
  'Race:ListDeck': 'stub',
  'Race:ListQuestAsset': 'stub',
  'Race:MovePanel': 'stub',
  'Race:Ranking': 'stub',
  'Race:ReceiveActivityLesson': 'stub',
  'Race:ResetCardCoolTime': 'stub',
  'Race:ResetLiveBonus': 'stub',
  'Race:SaveDeck': 'stub',
  'Race:StartLiveAreaQuest': 'stub',
  'Race:StartLivePanelQuest': 'stub',
  'Race:Top': 'stub',
  'Salary:GetPayslip': 'stub',
  'System:Check': 'sandbox-ok',
  'User:Get': 'sandbox-ok',
  'Warning:SetDisplayed': 'stub',
};
