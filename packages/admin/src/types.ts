/**
 * Client-side mirrors of the admin API response shapes.
 *
 * They are the JSON forms: every server `Date` arrives as an ISO-8601 string.
 * Keep them in sync with `fastify-api/src/routes/admin*.ts` and the services
 * those routes serialise.
 */

export const ADMIN_ROLES = ['viewer', 'editor', 'publisher', 'owner'] as const;
export type AdminRole = (typeof ADMIN_ROLES)[number];

/** The user attached to a session (`GET /session`). */
export interface AdminSessionUser {
  id: string;
  username: string;
  role: string;
}

/** A full user row (`publicUser` in `routes/admin.ts`). */
export interface AdminUser {
  id: string;
  username: string;
  role: string;
  disabled: boolean;
  createdAt: string;
  lastLoginAt: string | null;
}

export interface LoginResponse {
  user: AdminUser;
  csrfToken: string;
}

export interface SessionResponse {
  user: AdminSessionUser;
  csrfToken: string;
}

/** `services/events/plugin.ts` */
export interface ValidationIssue {
  path: string;
  message: string;
  severity: 'error' | 'warning';
}

export interface StateImpact {
  code: string;
  severity: 'block' | 'warn';
  message: string;
  boxId?: string;
  itemKey?: string;
  questId?: string;
  newStock?: number;
  requiresPlayerCheck: boolean;
}

export type PreviewImpact = StateImpact & { affectedPlayers?: number };

export interface PublishPreview {
  eventId: string;
  fromVersion: number;
  /** SHA-256 hex of the canonical JSON of the draft the preview used. */
  draftHash: string;
  changedKeys: string[];
  impacts: PreviewImpact[];
  blocking: boolean;
}

/** `POST /sumire/admin/events/:id/publish`. */
export interface PublishResult {
  version: number;
  warnings: ValidationIssue[];
}

export interface EditorField {
  path: string;
  type: 'string' | 'number' | 'boolean' | 'object' | 'array';
  label?: string;
  readOnly?: boolean;
}

export interface EditorSchema {
  fields: EditorField[];
}

export interface EventScheduleRow {
  id: number;
  eventId: string;
  startsAt: string;
  endsAt: string;
  exchangeEndsAt: string;
  enabled: boolean;
}

/**
 * When an event is live: scheduled kinds own schedule rows, permanent kinds
 * (e.g. `moshikoi` love events) are live as soon as they are published.
 * Older servers omit the field; treat absent as `scheduled`.
 */
export type EventLifecycle = 'scheduled' | 'permanent';

export interface EventSummary {
  id: string;
  kind: string;
  /** Absent on older servers; treated as `scheduled`. */
  lifecycle?: EventLifecycle;
  title: string;
  /** English title when a translation is available; null otherwise. */
  titleEn: string | null;
  publishedVersion: number;
  updatedBy: string | null;
  /** Username for an admin-user id; null for system values such as `system-upgrade`. */
  updatedByName: string | null;
  updatedAt: string;
  draftDiffersFromPublished: boolean;
  schedule: EventScheduleRow[];
}

export interface EventHistoryEntry {
  version: number;
  publishedBy: string | null;
  /** Username for an admin-user publisher id; null for system values. */
  publishedByName: string | null;
  publishedAt: string;
}

/** `GET /sumire/admin/events/:id/history/:version` */
export interface EventHistoryVersion {
  version: number;
  published: unknown;
  publishedBy: string | null;
  publishedByName: string | null;
  publishedAt: string;
}

/** `GET /sumire/admin/events/:id` */
export interface EventDetail {
  id: string;
  kind: string;
  /** Absent on older servers; treated as `scheduled`. */
  lifecycle?: EventLifecycle;
  title: string;
  /** English title when a translation is available; null otherwise. */
  titleEn: string | null;
  draft: unknown;
  published: unknown | null;
  publishedVersion: number;
  updatedBy: string | null;
  updatedByName: string | null;
  updatedAt: string;
  schedule: EventScheduleRow[];
  /** The plugin's editor schema; null only when the kind is no longer registered. */
  schema: EditorSchema | null;
  history: EventHistoryEntry[];
}

/** `POST /sumire/admin/events/:id/validate` and the draft-save response. */
export interface DraftValidation {
  ok: boolean;
  errors: ValidationIssue[];
}

export interface SaveDraftResponse {
  saved: boolean;
  validation: DraftValidation;
}

export interface NpcRosterCard {
  CardId: string;
  Position: number;
  Level: number;
  Rarity: number;
  LightFanAmount: number;
  MiddleFanAmount: number;
  HeavyFanAmount: number;
  EvolutionLevel: number;
}

export interface NpcRoster {
  Name: string;
  ManagerLevel: number;
  Cards: NpcRosterCard[];
}

export interface RosterUsageEvent {
  eventId: string;
  questId: string;
}

export interface RosterUsage {
  quests: string[];
  events: RosterUsageEvent[];
}

/** One row of `GET /sumire/admin/rosters`. */
export interface RosterSummary {
  id: string;
  name: string;
  /** English name when a translation is available; null otherwise. */
  nameEn: string | null;
  managerLevel: number;
  updatedBy: string | null;
  updatedAt: string;
  usageCount: number;
}

/** `GET /sumire/admin/rosters/:id` (`publicRoster` + usage). */
export interface RosterDetail {
  id: string;
  name: string;
  /** English name when a translation is available; null otherwise. */
  nameEn: string | null;
  managerLevel: number;
  cards: NpcRosterCard[];
  updatedBy: string | null;
  updatedAt: string;
  usage: RosterUsage;
}

export interface LookupCard {
  id: string;
  name: string | null;
  /** English card name when a translation is available; null otherwise. */
  nameEn: string | null;
  rarity: number | null;
  characterId: string | null;
  /** English character name when a translation is available; null otherwise. */
  characterNameEn: string | null;
}

export interface LookupItem {
  id: string;
  name: string | null;
  /** English item name when a translation is available; null otherwise. */
  nameEn: string | null;
}

export interface LookupQuest {
  id: string;
  name: string | null;
  /** English quest name when a translation is available; null otherwise. */
  nameEn: string | null;
  order: number | null;
}

/** Variant of a marathon id, derived from its id prefix. */
export type LookupMarathonVariant =
  | 'marathon'
  | 'marathon-raid'
  | 'mini-marathon'
  | 'mini-marathon-raid'
  | 'other';

/** One master marathon id (`GET /sumire/admin/lookup/marathons`). */
export interface LookupMarathon {
  id: string;
  variant: LookupMarathonVariant;
  /** Rows in `master_MarathonQuest` for this id. */
  questCount: number;
  /** Rows in `master_MarathonBoxGachaSetting` for this id. */
  boxGachaCount: number;
  /** An event definition with exactly this id already exists. */
  eventDefined: boolean;
}

/** One resolved grant of a reward (`GET /sumire/admin/lookup/rewards`). */
export interface LookupRewardResource {
  resourceType: number;
  typeLabel: string;
  resourceId: string;
  amount: number;
  /** Japanese name from the matching master table; null when it has none. */
  name: string | null;
  /** English name when a translation is available; null otherwise. */
  nameEn: string | null;
}

export interface LookupReward {
  id: string;
  resources: LookupRewardResource[];
  /** False for an unknown id; the route still returns 200. */
  found: boolean;
}

/** A skill behind a live bonus level, resolved through the ability's SkillId. */
export interface LookupLiveBonusSkill {
  skillId: string;
  /** Japanese skill name from `master_Skill`; null when unresolved. */
  name: string | null;
  /** English skill name when a translation is available; null otherwise. */
  nameEn: string | null;
  level: number | null;
  /** Japanese level description from `master_Skill.Levels`; null when absent. */
  description: string | null;
  /** English level description when a translation is available; null otherwise. */
  descriptionEn: string | null;
}

/** One live bonus of a group, with the level's ability description. */
export interface LookupLiveBonus {
  liveBonusId: string;
  liveAbilityId: string;
  level: number | null;
  /** Japanese description for the bonus level; null when unresolved. */
  description: string | null;
  /** English description when a translation is available; null otherwise. */
  descriptionEn: string | null;
  /** Skills linked by the live ability level; empty when it has none. */
  skills: LookupLiveBonusSkill[];
}

/** One live-bonus group as returned by the lookup route. */
export interface LookupLiveBonusGroup {
  groupId: string;
  bonuses: LookupLiveBonus[];
  /** False for an unknown id; the route still returns 200. */
  found: boolean;
}

/** One resource type that appears in a reward (`GET /lookup/resource-types`). */
export interface LookupRewardType {
  resourceType: number;
  typeLabel: string;
  /** Snake-case name used by inline `rd_auto;...` references. */
  snakeName: string | null;
  /** Number of reward rows containing at least one grant of this type. */
  count: number;
  /** True when the server's `applyGrants` can deliver this type. */
  grantable: boolean;
  /**
   * True when the type is grantable but has no name-table rows, so there is no
   * resource id to pick and the composed reference uses an empty id.
   */
  idless: boolean;
}

/** One browsable name-table row (`GET /lookup/resources`). */
export interface LookupResource {
  resourceType: number;
  typeLabel: string;
  resourceId: string;
  name: string | null;
  nameEn: string | null;
}

/** Paged response shared by the browse lookup routes. */
export interface LookupBrowsePage<T> {
  items: T[];
  total: number;
}

/** VENUS (type 3) panel details (`GET /lookup/race-board`). */
export interface RaceBoardVenus {
  questId: string;
  questName: string | null;
  /** Difficulty tier shown for the panel (from the draft). */
  difficultyNumber: number;
  difficultyLevel: number | null;
  clearScore: number | null;
  /** False when the race quest has no row for `difficultyNumber`. */
  difficultyFound: boolean;
}

/** One race board panel, in `Number` order. */
export interface RaceBoardPanel {
  number: number;
  /** `master_RacePanel.Type`: 1 empty, 2 reward, 3 VENUS, 4 story. */
  type: number;
  typeLabel: string;
  requiredRacePointAmount: number;
  /** Raw `RacePanelReward.RewardId` of a reward panel. */
  rewardId: string | null;
  /** Resolved reward contents of a reward panel. */
  reward: LookupReward | null;
  /** `EventStoryEpisode` of a story panel. */
  storyEpisode: number | null;
  /** Event story id of a story panel. */
  storyId: string | null;
  venus: RaceBoardVenus | null;
}

/** One area of the board, with panels and point total. */
export interface RaceBoardArea {
  /** Position in the draft's `areaIds` (0-based). */
  index: number;
  areaId: string;
  panelCount: number;
  totalRacePointCost: number;
  panels: RaceBoardPanel[];
}

/** Read-only board preview of one race draft. */
export interface RaceBoardPreview {
  raceId: string;
  eventStoryId: string | null;
  areas: RaceBoardArea[];
}
