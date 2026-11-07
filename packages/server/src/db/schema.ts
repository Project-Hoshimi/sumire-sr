import {
  pgTable,
  text,
  integer,
  bigint,
  boolean,
  jsonb,
  timestamp,
  serial,
  uniqueIndex,
  index,
} from 'drizzle-orm/pg-core';

export const accounts = pgTable(
  'accounts',
  {
    id: text('id').primaryKey(),
    firebaseUid: text('firebase_uid'),
    seedId: text('seed_id'),
    displayName: text('display_name'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
    isBanned: boolean('is_banned').default(false).notNull(),
    // Soft delete: a deleted account keeps its rows (so the public id is never
    // reused) but no longer logs in or accepts a password migration.
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [uniqueIndex('accounts_firebase_uid_idx').on(t.firebaseUid)],
);

/**
 * Link password and pending one-time transfer token for an account. An account
 * without a row here has no link password (`Migration:List.Password` false).
 */
export const accountCredentials = pgTable('account_credentials', {
  accountId: text('account_id')
    .primaryKey()
    .references(() => accounts.id, { onDelete: 'cascade' }),
  passwordHash: text('password_hash').notNull(),
  onetimeTokenHash: text('onetime_token_hash'),
  onetimeExpiresAt: timestamp('onetime_expires_at', { withTimezone: true }),
  onetimeTargetUid: text('onetime_target_uid'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

/**
 * Invite links. Only the SHA-256 of the token is stored, so a database leak
 * does not hand out usable links; `uses` is incremented conditionally against
 * `max_uses` so a link can never create more accounts than allowed.
 */
export const invites = pgTable(
  'invites',
  {
    id: serial('id').primaryKey(),
    tokenHash: text('token_hash').notNull(),
    maxUses: integer('max_uses').default(1).notNull(),
    uses: integer('uses').default(0).notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    note: text('note'),
  },
  (t) => [uniqueIndex('invites_token_hash_idx').on(t.tokenHash)],
);

export const players = pgTable(
  'players',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id')
      .notNull()
      .references(() => accounts.id),
    name: text('name').notNull(),
    level: integer('level').default(1).notNull(),
    exp: bigint('exp', { mode: 'number' }).default(0).notNull(),
    gold: bigint('gold', { mode: 'number' }).default(0).notNull(),
    freeJewel: bigint('free_jewel', { mode: 'number' }).default(0).notNull(),
    paidJewel: bigint('paid_jewel', { mode: 'number' }).default(0).notNull(),
    stamina: integer('stamina').default(0).notNull(),
    staminaMax: integer('stamina_max').default(0).notNull(),
    lastStaminaAt: timestamp('last_stamina_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    data: jsonb('data').default({}).notNull(),
  },
  (t) => [uniqueIndex('players_account_id_idx').on(t.accountId)],
);

export const idolRoster = pgTable(
  'idol_roster',
  {
    id: text('id').primaryKey(),
    playerId: text('player_id')
      .notNull()
      .references(() => players.id),
    masterId: text('master_id').notNull(),
    level: integer('level').default(1).notNull(),
    affection: integer('affection').default(0).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex('idol_roster_player_master_idx').on(t.playerId, t.masterId)],
);

export const ownedCards = pgTable(
  'owned_cards',
  {
    id: text('id').primaryKey(),
    playerId: text('player_id')
      .notNull()
      .references(() => players.id),
    masterId: text('master_id').notNull(),
    level: integer('level').default(1).notNull(),
    exp: bigint('exp', { mode: 'number' }).default(0).notNull(),
    limitBreakPhase: integer('limit_break_phase').default(0).notNull(),
    skillLevel: integer('skill_level').default(1).notNull(),
    duplicatedCount: integer('duplicated_count').default(0).notNull(),
    attachment: integer('attachment').default(0).notNull(),
    gachaHistoryId: text('gacha_history_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index('owned_cards_player_idx').on(t.playerId)],
);

export const gachaHistory = pgTable(
  'gacha_history',
  {
    id: text('id').primaryKey(),
    playerId: text('player_id')
      .notNull()
      .references(() => players.id),
    gachaMasterId: text('gacha_master_id').notNull(),
    drawCount: integer('draw_count').notNull(),
    costType: text('cost_type').notNull(),
    costAmount: integer('cost_amount').notNull(),
    drawnAt: timestamp('drawn_at', { withTimezone: true }).defaultNow().notNull(),
    results: jsonb('results').default([]).notNull(),
  },
  (t) => [index('gacha_history_player_idx').on(t.playerId)],
);

export const deckConfigurations = pgTable(
  'deck_configurations',
  {
    id: text('id').primaryKey(),
    playerId: text('player_id')
      .notNull()
      .references(() => players.id),
    deckNumber: integer('deck_number').notNull(),
    leaderCardId: text('leader_card_id'),
    memberCardIds: jsonb('member_card_ids').default([]).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex('deck_player_number_idx').on(t.playerId, t.deckNumber)],
);

export const liveStageProgress = pgTable(
  'live_stage_progress',
  {
    id: text('id').primaryKey(),
    playerId: text('player_id')
      .notNull()
      .references(() => players.id),
    stageMasterId: text('stage_master_id').notNull(),
    highScore: bigint('high_score', { mode: 'number' }).default(0).notNull(),
    bestRank: integer('best_rank'),
    cleared: boolean('cleared').default(false).notNull(),
    fullCombo: boolean('full_combo').default(false).notNull(),
    clearCount: integer('clear_count').default(0).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('live_stage_player_master_idx').on(t.playerId, t.stageMasterId),
  ],
);

/**
 * Generic per-player entity store. Each row holds one encoded protobuf element
 * (base64) from a User:Get collection (items, cards, decks, deck positions).
 * Storing the element blobs verbatim keeps arbitrary nested/computed fields
 * (card stats, photo abilities, ...) intact without modelling every message,
 * while letting collections become DB-owned and mutable per account.
 */
export const playerEntities = pgTable(
  'player_entities',
  {
    id: text('id').primaryKey(),
    playerId: text('player_id')
      .notNull()
      .references(() => players.id),
    kind: text('kind').notNull(),
    entityKey: text('entity_key').notNull(),
    ordinal: integer('ordinal').notNull(),
    blob: text('blob').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('player_entities_player_kind_ordinal_idx').on(t.playerId, t.kind, t.ordinal),
    index('player_entities_player_kind_idx').on(t.playerId, t.kind),
  ],
);

/**
 * One server-side もし恋 save slot: the proto `LoveSaveDataInfo` fields plus the
 * captured route (solis `umodel.UserLoveSave.StoryEpisodeIDs` / `Selections`).
 */
/** Campaign effect carried by `LessonInfo.CampaignEffects`. */
export type ActivityCampaignEffect = {
  Type: number;
  Value: number;
  EndTime: number;
};

/**
 * Per-player activity lesson progress (the `LessonProgress` carried by
 * `Home:Enter`/`Activity:ReceiveLessonReward`) plus the cached campaign effects
 * from `LessonInfo`. One row per player, lazily seeded on first touch.
 */
export const playerLessonProgress = pgTable(
  'player_lesson_progress',
  {
    id: text('id').primaryKey(),
    playerId: text('player_id')
      .notNull()
      .references(() => players.id),
    stepRewardGold: integer('step_reward_gold').default(0).notNull(),
    stepRewardManagerExp: integer('step_reward_manager_exp').default(0).notNull(),
    stepRewardCardEnhanceItem: integer('step_reward_card_enhance_item').default(0).notNull(),
    rewardGold: integer('reward_gold').default(0).notNull(),
    rewardManagerExp: integer('reward_manager_exp').default(0).notNull(),
    rewardCardEnhanceItem: integer('reward_card_enhance_item').default(0).notNull(),
    lastReceiveTime: bigint('last_receive_time', { mode: 'number' }).default(0).notNull(),
    maxRewardTime: bigint('max_reward_time', { mode: 'number' }).default(0).notNull(),
    dailyPromoteCount: integer('daily_promote_count').default(0).notNull(),
    currentAreaId: text('current_area_id').default('area-main-001').notNull(),
    campaignEffects: jsonb('campaign_effects').$type<ActivityCampaignEffect[]>().default([]).notNull(),
    dailyStateDay: text('daily_state_day'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex('player_lesson_progress_player_idx').on(t.playerId)],
);

export type LoveSaveSlot = {
  slotNumber: number;
  saveTime: number;
  latestStoryEpisodeId: string;
  name: string;
  /** Route captured when the slot was written (solis `UserLoveSave.StoryEpisodeIDs`). */
  storyEpisodeIds: string[];
  /** Choices captured when the slot was written (solis `UserLoveSave.Selections`). */
  selections: LoveStorySelection[];
};

/** One saved route choice (solis `umodel.LoveStorySelection`). */
export type LoveStorySelection = {
  /** Episode the choice belongs to. */
  storyEpisodeId: string;
  /** 1-based choice group index from the route data. */
  groupIndex: number;
  /** 1-based choice index from the route data. */
  index: number;
};

/**
 * Per-player もし恋 (Love ADV) progress that is not carried by the
 * `User:Get` `Loves` collection: the chosen protagonist name and the separate
 * lesson exp accumulator (`LoveTopResponse.Exp`).
 */
export const playerLoveProgress = pgTable(
  'player_love_progress',
  {
    id: text('id').primaryKey(),
    playerId: text('player_id')
      .notNull()
      .references(() => players.id),
    loveId: text('love_id').notNull(),
    name: text('name'),
    exp: bigint('exp', { mode: 'number' }).default(0).notNull(),
    lastReceiveTime: bigint('last_receive_time', { mode: 'number' }).default(0).notNull(),
    readEpisodeIds: jsonb('read_episode_ids').$type<string[]>().default([]).notNull(),
    /** Episodes on the player's current route, in play order (solis StoryEpisodeIDs). */
    storyEpisodeIds: jsonb('story_episode_ids').$type<string[]>().default([]).notNull(),
    /** Choices made on the current route (solis Selections). */
    selections: jsonb('selections').$type<LoveStorySelection[]>().default([]).notNull(),
    /** Every choice ever made, kept for hints/history (solis PastSelections). */
    pastSelections: jsonb('past_selections').$type<LoveStorySelection[]>().default([]).notNull(),
    /** Episode currently being read; '' when not reading (solis ActiveStoryEpisodeID). */
    activeStoryEpisodeId: text('active_story_episode_id').default('').notNull(),
    saveSlots: jsonb('save_slots').$type<LoveSaveSlot[]>().default([]).notNull(),
    saveUnlocked: boolean('save_unlocked').default(false).notNull(),
    lastPlayTime: bigint('last_play_time', { mode: 'number' }).default(0).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex('player_love_progress_player_love_idx').on(t.playerId, t.loveId)],
);

/**
 * Per-player gacha progress not carried by the generic entity store: selected
 * (pick-one / select-card) cards, stamp-sheet progress, premium/continuous draw
 * counters and per-exchange counts.
 */
export const playerGachaState = pgTable(
  'player_gacha_state',
  {
    id: text('id').primaryKey(),
    playerId: text('player_id')
      .notNull()
      .references(() => players.id),
    gachaId: text('gacha_id').notNull(),
    selectedCardIds: jsonb('selected_card_ids').$type<string[]>().default([]).notNull(),
    stampSheetNumber: integer('stamp_sheet_number').default(0).notNull(),
    stampNumber: integer('stamp_number').default(0).notNull(),
    totalDrawCount: bigint('total_draw_count', { mode: 'number' }).default(0).notNull(),
    premiumDrawCount: bigint('premium_draw_count', { mode: 'number' }).default(0).notNull(),
    freeTicketClaimed: boolean('free_ticket_claimed').default(false).notNull(),
    exchangeCounts: jsonb('exchange_counts').$type<Record<string, number>>().default({}).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex('player_gacha_state_player_gacha_idx').on(t.playerId, t.gachaId)],
);

/** Per-player box-gacha draw/reset counters (marathon box gacha). */
export const playerBoxGacha = pgTable(
  'player_box_gacha',
  {
    id: text('id').primaryKey(),
    playerId: text('player_id')
      .notNull()
      .references(() => players.id),
    marathonId: text('marathon_id'),
    boxGachaId: text('box_gacha_id').notNull(),
    drawnCount: bigint('drawn_count', { mode: 'number' }).default(0).notNull(),
    resetCount: integer('reset_count').default(0).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex('player_box_gacha_player_box_idx').on(t.playerId, t.boxGachaId)],
);

/** Per-player marathon event points (drives box-gacha unlocks). */
export const playerMarathonPoint = pgTable(
  'player_marathon_point',
  {
    id: text('id').primaryKey(),
    playerId: text('player_id')
      .notNull()
      .references(() => players.id),
    marathonId: text('marathon_id').notNull(),
    point: bigint('point', { mode: 'number' }).default(0).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex('player_marathon_point_player_marathon_idx').on(t.playerId, t.marathonId)],
);

/** Small key/value table for server-global metadata (e.g. master manifest version). */
export const serverMeta = pgTable('server_meta', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

/**
 * Idempotency guard: one row per (player, source) reward that has been claimed.
 * Inserts rely on the unique index so a duplicate claim is a no-op.
 */
export const rewardClaims = pgTable(
  'reward_claims',
  {
    id: text('id').primaryKey(),
    playerId: text('player_id')
      .notNull()
      .references(() => players.id),
    sourceType: text('source_type').notNull(),
    sourceId: text('source_id').notNull(),
    claimedAt: timestamp('claimed_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex('reward_claims_player_source_idx').on(t.playerId, t.sourceType, t.sourceId)],
);

/** Append-only audit of currency/item deltas applied to a player. */
export const playerLedger = pgTable(
  'player_ledger',
  {
    id: text('id').primaryKey(),
    playerId: text('player_id')
      .notNull()
      .references(() => players.id),
    resourceType: text('resource_type').notNull(),
    resourceId: text('resource_id').notNull(),
    delta: integer('delta').notNull(),
    reason: text('reason').notNull(),
    refId: text('ref_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index('player_ledger_player_idx').on(t.playerId)],
);

/** Per-player purchase counters for shop items and market exchanges. */
export const playerPurchases = pgTable(
  'player_purchases',
  {
    id: text('id').primaryKey(),
    playerId: text('player_id')
      .notNull()
      .references(() => players.id),
    kind: text('kind').notNull(),
    itemKey: text('item_key').notNull(),
    count: integer('count').notNull().default(0),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex('player_purchases_key_idx').on(t.playerId, t.kind, t.itemKey)],
);

/**
 * Firebase Storage-compatible metadata for one uploaded photo image object
 * (Solis `umodel.UserPhotoImageMetadata`). `id` is the object name
 * `Photo/<publicUserId>/<filename>`. The upload_* / finalization_id columns are
 * internal session bookkeeping and never appear in the Firebase metadata JSON.
 * A nonempty `generation` describes the last published image, including while
 * a replacement upload is active.
 */
export const photoImageMetadata = pgTable(
  'photo_image_metadata',
  {
    id: text('id').primaryKey(),
    playerId: text('player_id')
      .notNull()
      .references(() => players.id),
    publicUserId: text('public_user_id').notNull(),
    uploadId: text('upload_id').notNull(),
    uploadState: text('upload_state').notNull(),
    finalizationId: text('finalization_id'),
    uploadStateUpdatedAt: timestamp('upload_state_updated_at', { withTimezone: true }).notNull(),
    uploadExpiresAt: timestamp('upload_expires_at', { withTimezone: true }),

    name: text('name').notNull(),
    bucket: text('bucket').notNull(),
    generation: text('generation').notNull().default(''),
    metageneration: text('metageneration').notNull().default(''),
    contentType: text('content_type').notNull(),
    timeCreated: text('time_created').notNull().default(''),
    updated: text('updated').notNull().default(''),
    storageClass: text('storage_class').notNull().default(''),
    size: text('size').notNull().default(''),
    md5Hash: text('md5_hash').notNull().default(''),
    contentEncoding: text('content_encoding').notNull().default(''),
    contentDisposition: text('content_disposition').notNull().default(''),
    crc32c: text('crc32c').notNull().default(''),
    etag: text('etag').notNull().default(''),
    downloadTokens: text('download_tokens').notNull().default(''),
  },
  (t) => [index('photo_image_metadata_player_idx').on(t.playerId)],
);

/**
 * Current excursion (おでかけ) offer/active state for one player. Offers are
 * refreshed by `Excursion:List`; `Start` moves one offered place into the
 * active slot and `Finish` clears it again.
 */
export const playerExcursionState = pgTable('player_excursion_state', {
  playerId: text('player_id')
    .primaryKey()
    .references(() => players.id),
  offeredCharacter: text('offered_character'),
  offeredPlaceIds: jsonb('offered_place_ids').$type<string[]>().default([]).notNull(),
  activeCharacter: text('active_character'),
  activePlaceId: text('active_place_id'),
  startedTime: bigint('started_time', { mode: 'number' }).default(0).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

/**
 * Per-player birthday event state for one JST event year: the three chosen
 * participants, which birthday adventures were watched/claimed, and the
 * reminder year the player already dismissed.
 */
export const playerBirthdayState = pgTable('player_birthday_state', {
  playerId: text('player_id')
    .primaryKey()
    .references(() => players.id),
  eventYear: integer('event_year').default(0).notNull(),
  birthdayIds: jsonb('birthday_ids').$type<string[]>().default([]).notNull(),
  watchedIds: jsonb('watched_ids').$type<string[]>().default([]).notNull(),
  claimedIds: jsonb('claimed_ids').$type<string[]>().default([]).notNull(),
  remindedYear: integer('reminded_year').default(0).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

export * from './masterSchema.ts';
