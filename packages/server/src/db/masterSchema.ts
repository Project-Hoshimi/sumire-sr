// Curated subset of the A2 master-data tables, generated in the same pg-core
// style as phaseA2/out/master_schema.ts but without primary-key constraints
// (master data is read-only and seeded wholesale from phaseA2/out/structured).
// Expand MASTER_TABLES in seedMaster.ts + add tables here as feature slices land.
import { pgTable, text, bigint, jsonb, boolean, uniqueIndex, doublePrecision } from 'drizzle-orm/pg-core';

export const masterItem = pgTable(
  'master_Item',
  {
    Id: text('Id').notNull(),
    Name: text('Name'),
    AssetId: text('AssetId'),
    Description: text('Description'),
    HowToGet: text('HowToGet'),
    Type: bigint('Type', { mode: 'number' }),
    Value: bigint('Value', { mode: 'number' }),
    Order: bigint('Order', { mode: 'number' }),
    SalePrice: bigint('SalePrice', { mode: 'number' }),
    IsPhotoShootingCharacterOnly: boolean('IsPhotoShootingCharacterOnly'),
  },
  (t) => [uniqueIndex('master_item_id_idx').on(t.Id)],
);

export const masterReward = pgTable(
  'master_Reward',
  {
    Id: text('Id').notNull(),
    Resources: jsonb('Resources'),
  },
  (t) => [uniqueIndex('master_reward_id_idx').on(t.Id)],
);

export const masterRewardSort = pgTable(
  'master_RewardSort',
  {
    RewardSortTargetType: bigint('RewardSortTargetType', { mode: 'number' }).notNull(),
    RewardSortResourceType: bigint('RewardSortResourceType', { mode: 'number' }).notNull(),
    Order: bigint('Order', { mode: 'number' }),
  },
  (t) => [
    uniqueIndex('master_reward_sort_key_idx').on(t.RewardSortTargetType, t.RewardSortResourceType),
  ],
);

export const masterMission = pgTable(
  'master_Mission',
  {
    Id: text('Id').notNull(),
    CategoryType: bigint('CategoryType', { mode: 'number' }),
    MissionType: bigint('MissionType', { mode: 'number' }),
    TargetIds: jsonb('TargetIds'),
    Name: text('Name'),
    ShortDescription: text('ShortDescription'),
    LongDescription: text('LongDescription'),
    Order: bigint('Order', { mode: 'number' }),
    ViewConditionId: text('ViewConditionId'),
    LinkType: bigint('LinkType', { mode: 'number' }),
    LinkDetail: text('LinkDetail'),
    Progresses: jsonb('Progresses'),
    EventMissionId: text('EventMissionId'),
    CompanyEnjoyCharacterId: text('CompanyEnjoyCharacterId'),
    CompanyEnjoyCharacterMissionCategoryType: bigint('CompanyEnjoyCharacterMissionCategoryType', { mode: 'number' }),
    CompanyTrustMissionCategoryType: bigint('CompanyTrustMissionCategoryType', { mode: 'number' }),
  },
  (t) => [uniqueIndex('master_mission_id_idx').on(t.Id)],
);

export const masterEventMission = pgTable(
  'master_EventMission',
  {
    Id: text('Id').notNull(),
    EventMissionType: bigint('EventMissionType', { mode: 'number' }),
    AssetId: text('AssetId'),
    Name: text('Name'),
    Order: bigint('Order', { mode: 'number' }),
    ViewConditionId: text('ViewConditionId'),
    UnlockConditionId: text('UnlockConditionId'),
    MissionIds: jsonb('MissionIds'),
  },
  (t) => [uniqueIndex('master_event_mission_id_idx').on(t.Id)],
);

export const masterLoginBonus = pgTable(
  'master_LoginBonus',
  {
    Id: text('Id').notNull(),
    Name: text('Name'),
    Description: text('Description'),
    Type: bigint('Type', { mode: 'number' }),
    AssetId: text('AssetId'),
    TopColorCode: text('TopColorCode'),
    BottomColorCode: text('BottomColorCode'),
    Priority: bigint('Priority', { mode: 'number' }),
    RewardIds: jsonb('RewardIds'),
    OpenConditionId: text('OpenConditionId'),
    ReceiveConditionId: text('ReceiveConditionId'),
  },
  (t) => [uniqueIndex('master_login_bonus_id_idx').on(t.Id)],
);

export const masterLoginBonusText = pgTable(
  'master_LoginBonusText',
  {
    Id: text('Id').notNull(),
    CostumeId: text('CostumeId'),
    Text: text('Text'),
  },
  (t) => [uniqueIndex('master_login_bonus_text_id_idx').on(t.Id)],
);

export const masterCard = pgTable(
  'master_Card',
  {
    Id: text('Id').notNull(),
    AssetId: text('AssetId'),
    Name: text('Name'),
    Description: text('Description'),
    Type: bigint('Type', { mode: 'number' }),
    CharacterId: text('CharacterId'),
    InitialRarity: bigint('InitialRarity', { mode: 'number' }),
    CardParameterId: text('CardParameterId'),
    VocalRatioPermil: bigint('VocalRatioPermil', { mode: 'number' }),
    DanceRatioPermil: bigint('DanceRatioPermil', { mode: 'number' }),
    VisualRatioPermil: bigint('VisualRatioPermil', { mode: 'number' }),
    StaminaRatioPermil: bigint('StaminaRatioPermil', { mode: 'number' }),
    CardLevelReleaseId: text('CardLevelReleaseId'),
    SkillId1: text('SkillId1'),
    SkillId2: text('SkillId2'),
    SkillId3: text('SkillId3'),
    LiveAbilityId: text('LiveAbilityId'),
    ActivityAbilityId: text('ActivityAbilityId'),
    Order: bigint('Order', { mode: 'number' }),
    ReleaseDate: bigint('ReleaseDate', { mode: 'number' }),
    RewardCostumeId: text('RewardCostumeId'),
    RewardHairIds: jsonb('RewardHairIds'),
    ObtainMessage: text('ObtainMessage'),
    RewardHairId: text('RewardHairId'),
    CardEvolutionLevelReleaseGroupId: text('CardEvolutionLevelReleaseGroupId'),
    CardEvolutionLevelGroupId: text('CardEvolutionLevelGroupId'),
    SkillId4: text('SkillId4'),
    Stories: jsonb('Stories'),
    Messages: jsonb('Messages'),
    HomeTalks: jsonb('HomeTalks'),
  },
  (t) => [uniqueIndex('master_card_id_idx').on(t.Id)],
);

export const masterCardLevel = pgTable(
  'master_CardLevel',
  {
    Level: bigint('Level', { mode: 'number' }).notNull(),
    RequiredExp: bigint('RequiredExp', { mode: 'number' }),
  },
  (t) => [uniqueIndex('master_card_level_key_idx').on(t.Level)],
);

export const masterCardLevelRelease = pgTable(
  'master_CardLevelRelease',
  {
    Id: text('Id').notNull(),
    Level: bigint('Level', { mode: 'number' }).notNull(),
    Targets: jsonb('Targets'),
  },
  (t) => [uniqueIndex('master_card_level_release_key_idx').on(t.Id, t.Level)],
);

export const masterCardParameter = pgTable(
  'master_CardParameter',
  {
    Id: text('Id').notNull(),
    Level: bigint('Level', { mode: 'number' }).notNull(),
    Value: bigint('Value', { mode: 'number' }),
    StaminaValue: bigint('StaminaValue', { mode: 'number' }),
  },
  (t) => [uniqueIndex('master_card_parameter_key_idx').on(t.Id, t.Level)],
);

export const masterGacha = pgTable(
  'master_Gacha',
  {
    Id: text('Id').notNull(),
    AssetId: text('AssetId'),
    BannerAssetId: text('BannerAssetId'),
    AppealAssetId: text('AppealAssetId'),
    MovieAssetId: text('MovieAssetId'),
    ScreenAssetId: text('ScreenAssetId'),
    Name: text('Name'),
    Description: text('Description'),
    Precaution: text('Precaution'),
    GachaType: bigint('GachaType', { mode: 'number' }),
    ViewConditionId: text('ViewConditionId'),
    UnlockConditionId: text('UnlockConditionId'),
    PickupCardIds: jsonb('PickupCardIds'),
    ExchangeResourceType: bigint('ExchangeResourceType', { mode: 'number' }),
    ExchangeResourceId: text('ExchangeResourceId'),
    ExchangeBoothId: text('ExchangeBoothId'),
    Order: bigint('Order', { mode: 'number' }),
    IsPeriodDisplay: boolean('IsPeriodDisplay'),
    AppealText: text('AppealText'),
    SelectPickupAmount: bigint('SelectPickupAmount', { mode: 'number' }),
    SelectCardIds: jsonb('SelectCardIds'),
    ShopId: text('ShopId'),
    BgmAssetId: text('BgmAssetId'),
    ButtonIds: jsonb('ButtonIds'),
    ExchangeIds: jsonb('ExchangeIds'),
    CardRewards: jsonb('CardRewards'),
  },
  (t) => [uniqueIndex('master_gacha_id_idx').on(t.Id)],
);

export const masterGachaButton = pgTable(
  'master_GachaButton',
  {
    Id: text('Id').notNull(),
    Name: text('Name'),
    Description: text('Description'),
    IsAnimation: boolean('IsAnimation'),
    ConsumptionId: text('ConsumptionId'),
    DiscountLimitType: bigint('DiscountLimitType', { mode: 'number' }),
    DiscountCount: bigint('DiscountCount', { mode: 'number' }),
    DiscountConsumptionId: text('DiscountConsumptionId'),
    DrawCount: bigint('DrawCount', { mode: 'number' }),
    LimitType: bigint('LimitType', { mode: 'number' }),
    LimitCount: bigint('LimitCount', { mode: 'number' }),
    BonusRewardId: text('BonusRewardId'),
    BonusCount: bigint('BonusCount', { mode: 'number' }),
    Order: bigint('Order', { mode: 'number' }),
    GachaId: text('GachaId'),
    GachaStampSheetGroupId: text('GachaStampSheetGroupId'),
  },
  (t) => [uniqueIndex('master_gacha_button_id_idx').on(t.Id)],
);

export const masterConsumption = pgTable(
  'master_Consumption',
  {
    Id: text('Id').notNull(),
    Resources: jsonb('Resources'),
  },
  (t) => [uniqueIndex('master_consumption_id_idx').on(t.Id)],
);

export const masterCardDuplicateReward = pgTable(
  'master_CardDuplicateReward',
  {
    InitialRarity: bigint('InitialRarity', { mode: 'number' }).notNull(),
    CurrentRarity: bigint('CurrentRarity', { mode: 'number' }).notNull(),
    RewardId: text('RewardId'),
  },
  (t) => [uniqueIndex('master_card_duplicate_reward_key_idx').on(t.InitialRarity, t.CurrentRarity)],
);

export const masterCardDuplicateExp = pgTable(
  'master_CardDuplicateExp',
  {
    InitialRarity: bigint('InitialRarity', { mode: 'number' }).notNull(),
    Exp: bigint('Exp', { mode: 'number' }),
  },
  (t) => [uniqueIndex('master_card_duplicate_exp_key_idx').on(t.InitialRarity)],
);
export const masterCostume = pgTable(
  'master_Costume',
  {
    Id: text('Id').notNull(),
    CharacterId: text('CharacterId'),
    DefaultHairId: text('DefaultHairId'),
    Name: text('Name'),
    Order: bigint('Order', { mode: 'number' }),
    CostumeTypeId: text('CostumeTypeId'),
  },
  (t) => [uniqueIndex('master_costume_id_idx').on(t.Id)],
);

export const masterHair = pgTable(
  'master_Hair',
  {
    Id: text('Id').notNull(),
    CharacterId: text('CharacterId'),
    FittingCostumeId: text('FittingCostumeId'),
    Name: text('Name'),
    WearableCostumeIds: jsonb('WearableCostumeIds'),
    NotWearableCostumeIds: jsonb('NotWearableCostumeIds'),
  },
  (t) => [uniqueIndex('master_hair_id_idx').on(t.Id)],
);

// Emblems (称号). The sandbox seed grants every row of this table so the
// account owns all titles, not only the ones a master reward references.
export const masterEmblem = pgTable(
  'master_Emblem',
  {
    Id: text('Id').notNull(),
    Name: text('Name'),
    AssetId: text('AssetId'),
    AutoProvideConditionId: text('AutoProvideConditionId'),
    IsViewableInInactive: boolean('IsViewableInInactive'),
    Order: bigint('Order', { mode: 'number' }),
    Description: text('Description'),
  },
  (t) => [uniqueIndex('master_emblem_id_idx').on(t.Id)],
);

// Activity promotion: the harvested master row only carries presentation data;
// the Solis activity catalog (`catalogdata/god_activity.yaml`) contributes the
// per-promotion timing/economy profile, stored in the extra columns below.
export const masterActivityPromotion = pgTable(
  'master_ActivityPromotion',
  {
    Id: text('Id').notNull(),
    Name: text('Name'),
    ViewConditionId: text('ViewConditionId'),
    UnlockConditionId: text('UnlockConditionId'),
    Order: bigint('Order', { mode: 'number' }),
    Levels: jsonb('Levels'),
    ActivityPerformanceId: text('ActivityPerformanceId'),
    PromotionLevel: bigint('PromotionLevel', { mode: 'number' }),
    RequiredStamina: bigint('RequiredStamina', { mode: 'number' }),
    StepConsumptionStamina: bigint('StepConsumptionStamina', { mode: 'number' }),
    StepRewardGold: bigint('StepRewardGold', { mode: 'number' }),
    StepRewardCardEnhanceItem: bigint('StepRewardCardEnhanceItem', { mode: 'number' }),
    MultiStepRewardId: text('MultiStepRewardId'),
    MaxFanAmount: bigint('MaxFanAmount', { mode: 'number' }),
    SubGenre: text('SubGenre'),
  },
  (t) => [uniqueIndex('master_activity_promotion_id_idx').on(t.Id)],
);

export const masterActivityPerformance = pgTable(
  'master_ActivityPerformance',
  {
    Id: text('Id').notNull(),
    CostumeTypeIds: jsonb('CostumeTypeIds'),
    ForceCostumeTypeId: text('ForceCostumeTypeId'),
    FieldId: text('FieldId'),
    ExistBackground: bigint('ExistBackground', { mode: 'number' }),
    ExistForeground: bigint('ExistForeground', { mode: 'number' }),
    BackgroundTopColorCode: text('BackgroundTopColorCode'),
    BackgroundBottomColorCode: text('BackgroundBottomColorCode'),
    FieldSpineNumber: bigint('FieldSpineNumber', { mode: 'number' }),
    ExistProp: bigint('ExistProp', { mode: 'number' }),
  },
  (t) => [uniqueIndex('master_activity_performance_id_idx').on(t.Id)],
);

export const masterCharacterActivityLevel = pgTable(
  'master_CharacterActivityLevel',
  {
    Level: bigint('Level', { mode: 'number' }).notNull(),
    RequiredExp: bigint('RequiredExp', { mode: 'number' }),
    MaxStamina: bigint('MaxStamina', { mode: 'number' }),
    BaseActivityPoint: bigint('BaseActivityPoint', { mode: 'number' }),
  },
  (t) => [uniqueIndex('master_character_activity_level_idx').on(t.Level)],
);

export const masterAccessory = pgTable(
  'master_Accessory',
  {
    Id: text('Id').notNull(),
    Classification: text('Classification'),
    Rarity: bigint('Rarity', { mode: 'number' }),
    Name: text('Name'),
    CategoryType: bigint('CategoryType', { mode: 'number' }),
    Param1Type: bigint('Param1Type', { mode: 'number' }),
    Param1Value: bigint('Param1Value', { mode: 'number' }),
    SalePrice: bigint('SalePrice', { mode: 'number' }),
  },
  (t) => [uniqueIndex('master_accessory_id_idx').on(t.Id)],
);

export const masterAccessoryEnhancement = pgTable(
  'master_AccessoryEnhancement',
  {
    Rarity: bigint('Rarity', { mode: 'number' }).notNull(),
    RequiredGold: bigint('RequiredGold', { mode: 'number' }),
  },
  (t) => [uniqueIndex('master_accessory_enhancement_key_idx').on(t.Rarity)],
);

export const masterCardRarity = pgTable(
  'master_CardRarity',
  {
    Rarity: bigint('Rarity', { mode: 'number' }).notNull(),
    LevelLimit: bigint('LevelLimit', { mode: 'number' }),
    ParameterBonusPermil: bigint('ParameterBonusPermil', { mode: 'number' }),
    RequiredExp: bigint('RequiredExp', { mode: 'number' }),
  },
  (t) => [uniqueIndex('master_card_rarity_key_idx').on(t.Rarity)],
);

export const masterCardRank = pgTable(
  'master_CardRank',
  {
    Rank: bigint('Rank', { mode: 'number' }).notNull(),
    IsDataExist: boolean('IsDataExist'),
    LevelLimitUpAmount: bigint('LevelLimitUpAmount', { mode: 'number' }),
    RequiredExp: bigint('RequiredExp', { mode: 'number' }),
  },
  (t) => [uniqueIndex('master_card_rank_key_idx').on(t.Rank)],
);

export const masterCardSupportRelease = pgTable(
  'master_CardSupportRelease',
  {
    Count: bigint('Count', { mode: 'number' }).notNull(),
    ItemId: text('ItemId'),
    ItemAmount: bigint('ItemAmount', { mode: 'number' }),
    StoneAmount: bigint('StoneAmount', { mode: 'number' }),
  },
  (t) => [uniqueIndex('master_card_support_release_key_idx').on(t.Count)],
);

export const masterPhotoRarityLevel = pgTable(
  'master_PhotoRarityLevel',
  {
    Rarity: bigint('Rarity', { mode: 'number' }).notNull(),
    Level: bigint('Level', { mode: 'number' }).notNull(),
    DeleteRewardItem: text('DeleteRewardItem'),
    RerollRequiredItem: bigint('RerollRequiredItem', { mode: 'number' }),
    EnhanceRequiredItem: bigint('EnhanceRequiredItem', { mode: 'number' }),
  },
  (t) => [uniqueIndex('master_photo_rarity_level_key_idx').on(t.Rarity, t.Level)],
);

export const masterPhotoRetouchEnhance = pgTable(
  'master_PhotoRetouchEnhance',
  {
    GroupId: text('GroupId').notNull(),
    PhotoLevel: bigint('PhotoLevel', { mode: 'number' }).notNull(),
    ConsumptionId: text('ConsumptionId'),
  },
  (t) => [uniqueIndex('master_photo_retouch_enhance_key_idx').on(t.GroupId, t.PhotoLevel)],
);

export const masterLiveAbility = pgTable(
  'master_LiveAbility',
  {
    Id: text('Id').notNull(),
    Name: text('Name'),
    Levels: jsonb('Levels'),
  },
  (t) => [uniqueIndex('master_live_ability_id_idx').on(t.Id)],
);

export const masterActivityAbility = pgTable(
  'master_ActivityAbility',
  {
    Id: text('Id').notNull(),
    Name: text('Name'),
    Levels: jsonb('Levels'),
  },
  (t) => [uniqueIndex('master_activity_ability_id_idx').on(t.Id)],
);

export const masterSkill = pgTable(
  'master_Skill',
  {
    Id: text('Id').notNull(),
    Name: text('Name'),
    CategoryType: bigint('CategoryType', { mode: 'number' }),
    Levels: jsonb('Levels'),
    AssetId: text('AssetId'),
  },
  (t) => [uniqueIndex('master_skill_id_idx').on(t.Id)],
);

export const masterPhotoAbility = pgTable(
  'master_PhotoAbility',
  {
    Id: text('Id').notNull(),
    Name: text('Name'),
    Description: text('Description'),
    AbilityType: bigint('AbilityType', { mode: 'number' }),
    PhotoAbilityLevels: jsonb('PhotoAbilityLevels'),
    PhotoAbilityGrades: jsonb('PhotoAbilityGrades'),
  },
  (t) => [uniqueIndex('master_photo_ability_id_idx').on(t.Id)],
);

export const masterPhotoRecipe = pgTable(
  'master_PhotoRecipe',
  {
    Id: text('Id').notNull(),
    Name: text('Name'),
    Description: text('Description'),
    Level: bigint('Level', { mode: 'number' }),
    PhotoAbilitySetId: text('PhotoAbilitySetId'),
    RetouchConsumptionId: text('RetouchConsumptionId'),
    SaleRewardId: text('SaleRewardId'),
    PhotoRetouchEnhanceGroupId: text('PhotoRetouchEnhanceGroupId'),
    MinPhotoLevel: bigint('MinPhotoLevel', { mode: 'number' }),
    MaxPhotoLevel: bigint('MaxPhotoLevel', { mode: 'number' }),
    Order: bigint('Order', { mode: 'number' }),
  },
  (t) => [uniqueIndex('master_photo_recipe_id_idx').on(t.Id)],
);

export const masterPhotoActivity = pgTable(
  'master_PhotoActivity',
  {
    Id: text('Id').notNull(),
    Name: text('Name'),
    Type: bigint('Type', { mode: 'number' }),
    ThumbAssetId: text('ThumbAssetId'),
    StageId: text('StageId'),
    CostumeTypeIds: jsonb('CostumeTypeIds'),
    ForceCostumeTypeId: text('ForceCostumeTypeId'),
    PhotoShootingMotionSetId: text('PhotoShootingMotionSetId'),
    IsDeleteCharacter: boolean('IsDeleteCharacter'),
    Order: bigint('Order', { mode: 'number' }),
    ViewConditionId: text('ViewConditionId'),
    UnlockConditionId: text('UnlockConditionId'),
    ImpossibleShootingCharacterIds: jsonb('ImpossibleShootingCharacterIds'),
  },
  (t) => [uniqueIndex('master_photo_activity_id_idx').on(t.Id)],
);

export const masterPhotoQuestMusic = pgTable(
  'master_PhotoQuestMusic',
  {
    Id: text('Id').notNull(),
    AssetId: text('AssetId'),
    Name: text('Name'),
    Description: text('Description'),
    Order: bigint('Order', { mode: 'number' }),
    Lyricist: text('Lyricist'),
    Composer: text('Composer'),
    Arranger: text('Arranger'),
    Singer: text('Singer'),
    ViewConditionId: text('ViewConditionId'),
    UnlockConditionId: text('UnlockConditionId'),
  },
  (t) => [uniqueIndex('master_photo_quest_music_id_idx').on(t.Id)],
);

export const masterStage = pgTable(
  'master_Stage',
  {
    Id: text('Id').notNull(),
    AssetId: text('AssetId'),
    Name: text('Name'),
    Order: bigint('Order', { mode: 'number' }),
    Type: bigint('Type', { mode: 'number' }),
  },
  (t) => [uniqueIndex('master_stage_id_idx').on(t.Id)],
);

export const masterPhotoQuestStage = pgTable(
  'master_PhotoQuestStage',
  {
    Id: text('Id').notNull(),
    AssetId: text('AssetId'),
    Name: text('Name'),
    MaxCapacity: bigint('MaxCapacity', { mode: 'number' }),
    Order: bigint('Order', { mode: 'number' }),
    ViewConditionId: text('ViewConditionId'),
    UnlockConditionId: text('UnlockConditionId'),
  },
  (t) => [uniqueIndex('master_photo_quest_stage_id_idx').on(t.Id)],
);

export const masterPhotoExpression = pgTable(
  'master_PhotoExpression',
  {
    Id: text('Id').notNull(),
    Name: text('Name'),
    ThumbnailAssetId: text('ThumbnailAssetId'),
    StageId: text('StageId'),
    CostumeTypeIds: jsonb('CostumeTypeIds'),
    ForceCostumeTypeId: text('ForceCostumeTypeId'),
    Order: bigint('Order', { mode: 'number' }),
    ViewConditionId: text('ViewConditionId'),
    UnlockConditionId: text('UnlockConditionId'),
    ImpossibleShootingCharacterIds: jsonb('ImpossibleShootingCharacterIds'),
    ImpossiblePhotoPoseIds: jsonb('ImpossiblePhotoPoseIds'),
    SceneLayoutAssetId: text('SceneLayoutAssetId'),
    CharacterAmountArray: jsonb('CharacterAmountArray'),
  },
  (t) => [uniqueIndex('master_photo_expression_id_idx').on(t.Id)],
);

export const masterPhotoExpressionStagePosition = pgTable(
  'master_PhotoExpressionStagePosition',
  {
    StageId: text('StageId').notNull(),
    Number: bigint('Number', { mode: 'number' }).notNull(),
    Name: text('Name'),
    PossiblePhotoPoseType: bigint('PossiblePhotoPoseType', { mode: 'number' }),
    InitialPhotoPoseId: text('InitialPhotoPoseId'),
    CharacterPositions: jsonb('CharacterPositions'),
    CharacterAngles: jsonb('CharacterAngles'),
    CameraPositions: jsonb('CameraPositions'),
    CameraAngles: jsonb('CameraAngles'),
    UpperLimit: doublePrecision('UpperLimit'),
    LowerLimit: doublePrecision('LowerLimit'),
    PreviewCameraPositions: jsonb('PreviewCameraPositions'),
    PreviewCameraAngles: jsonb('PreviewCameraAngles'),
    PreviewUpperLimit: doublePrecision('PreviewUpperLimit'),
    PreviewLowerLimit: doublePrecision('PreviewLowerLimit'),
    LookEffectAssetId: text('LookEffectAssetId'),
  },
  (t) => [uniqueIndex('master_photo_expression_stage_position_key_idx').on(t.StageId, t.Number)],
);

export const masterPhotoAbilitySet = pgTable(
  'master_PhotoAbilitySet',
  {
    Id: text('Id').notNull(),
    PhotoAbilityIds: jsonb('PhotoAbilityIds'),
    PhotoRarity: bigint('PhotoRarity', { mode: 'number' }),
    Limited: bigint('Limited', { mode: 'number' }),
  },
  (t) => [uniqueIndex('master_photo_ability_set_id_idx').on(t.Id)],
);

export const masterPhotoPose = pgTable(
  'master_PhotoPose',
  {
    Id: text('Id').notNull(),
    Name: text('Name'),
    Description: text('Description'),
    PoseType: bigint('PoseType', { mode: 'number' }),
    PoseMotionType: bigint('PoseMotionType', { mode: 'number' }),
    LookingType: bigint('LookingType', { mode: 'number' }),
    Order: bigint('Order', { mode: 'number' }),
    ReleaseDatetime: bigint('ReleaseDatetime', { mode: 'number' }),
  },
  (t) => [uniqueIndex('master_photo_pose_id_idx').on(t.Id)],
);

export const masterPhotoFacial = pgTable(
  'master_PhotoFacial',
  {
    Id: text('Id').notNull(),
    Name: text('Name'),
    Order: bigint('Order', { mode: 'number' }),
  },
  (t) => [uniqueIndex('master_photo_facial_id_idx').on(t.Id)],
);

export const masterPhotoAllInOne = pgTable(
  'master_PhotoAllInOne',
  {
    Id: text('Id').notNull(),
    AssetId: text('AssetId'),
    Name: text('Name'),
    Rarity: bigint('Rarity', { mode: 'number' }),
    PlaceName: text('PlaceName'),
    EventName: text('EventName'),
    Level: bigint('Level', { mode: 'number' }),
    Abilities: jsonb('Abilities'),
  },
  (t) => [uniqueIndex('master_photo_all_in_one_id_idx').on(t.Id)],
);

export const masterPhotoContestActivity = pgTable(
  'master_PhotoContestActivity',
  {
    Id: text('Id').notNull(),
    Name: text('Name'),
    Type: bigint('Type', { mode: 'number' }),
    ThumbAssetId: text('ThumbAssetId'),
    StageId: text('StageId'),
    CostumeTypeIds: jsonb('CostumeTypeIds'),
    ForceCostumeTypeId: text('ForceCostumeTypeId'),
    PhotoShootingMotionSetId: text('PhotoShootingMotionSetId'),
    IsDeleteCharacter: boolean('IsDeleteCharacter'),
    Order: bigint('Order', { mode: 'number' }),
    ViewConditionId: text('ViewConditionId'),
    UnlockConditionId: text('UnlockConditionId'),
    ImpossibleShootingCharacterIds: jsonb('ImpossibleShootingCharacterIds'),
  },
  (t) => [uniqueIndex('master_photo_contest_activity_id_idx').on(t.Id)],
);

export const masterPhotoContestQuestMusic = pgTable(
  'master_PhotoContestQuestMusic',
  {
    Id: text('Id').notNull(),
    MusicId: text('MusicId'),
    AssetId: text('AssetId'),
    Name: text('Name'),
    Description: text('Description'),
    Order: bigint('Order', { mode: 'number' }),
    Lyricist: text('Lyricist'),
    Composer: text('Composer'),
    Arranger: text('Arranger'),
    Singer: text('Singer'),
    ViewConditionId: text('ViewConditionId'),
    UnlockConditionId: text('UnlockConditionId'),
  },
  (t) => [uniqueIndex('master_photo_contest_quest_music_id_idx').on(t.Id)],
);

export const masterPhotoContestQuestStage = pgTable(
  'master_PhotoContestQuestStage',
  {
    Id: text('Id').notNull(),
    StageId: text('StageId'),
    AssetId: text('AssetId'),
    Name: text('Name'),
    Description: text('Description'),
    MaxCapacity: bigint('MaxCapacity', { mode: 'number' }),
    Order: bigint('Order', { mode: 'number' }),
    ViewConditionId: text('ViewConditionId'),
    UnlockConditionId: text('UnlockConditionId'),
  },
  (t) => [uniqueIndex('master_photo_contest_quest_stage_id_idx').on(t.Id)],
);

export const masterPhotoContestSection = pgTable(
  'master_PhotoContestSection',
  {
    Id: text('Id').notNull(),
    Name: text('Name'),
    Theme: text('Theme'),
    Description: text('Description'),
    AssetId: text('AssetId'),
    BackgroundColorCode: text('BackgroundColorCode'),
    UnlockConditionId: text('UnlockConditionId'),
  },
  (t) => [uniqueIndex('master_photo_contest_section_id_idx').on(t.Id)],
);

export const masterPhotoContestSectionReward = pgTable(
  'master_PhotoContestSectionReward',
  {
    Id: text('Id').notNull(),
    RequiredEvaluationPoint: bigint('RequiredEvaluationPoint', { mode: 'number' }),
    RewardId: text('RewardId'),
  },
  (t) => [uniqueIndex('master_photo_contest_section_reward_id_idx').on(t.Id)],
);

export const masterQuestContestRankingSeason = pgTable(
  'master_QuestContestRankingSeason',
  {
    Id: text('Id').notNull(),
    StartTime: bigint('StartTime', { mode: 'number' }),
  },
  (t) => [uniqueIndex('master_quest_contest_ranking_season_id_idx').on(t.Id)],
);

export const masterShowcaseFrame = pgTable(
  'master_ShowcaseFrame',
  {
    Id: text('Id').notNull(),
    Order: bigint('Order', { mode: 'number' }),
    Name: text('Name'),
    Description: text('Description'),
    AssetId: text('AssetId'),
    UnlockConditionId: text('UnlockConditionId'),
    ShowcaseToyPutCountLimit: bigint('ShowcaseToyPutCountLimit', { mode: 'number' }),
  },
  (t) => [uniqueIndex('master_showcase_frame_id_idx').on(t.Id)],
);

export const masterShowcaseHashtag = pgTable(
  'master_ShowcaseHashtag',
  {
    Id: text('Id').notNull(),
    Number: bigint('Number', { mode: 'number' }),
    Name: text('Name'),
    AssetId: text('AssetId'),
    CategoryType: bigint('CategoryType', { mode: 'number' }),
  },
  (t) => [uniqueIndex('master_showcase_hashtag_id_idx').on(t.Id)],
);

export const masterMusic = pgTable(
  'master_Music',
  {
    Id: text('Id').notNull(),
    AssetId: text('AssetId'),
    Name: text('Name'),
    Description: text('Description'),
    Order: bigint('Order', { mode: 'number' }),
    Lyricist: text('Lyricist'),
    Composer: text('Composer'),
    Arranger: text('Arranger'),
    Singer: text('Singer'),
    Is3DAvailable: boolean('Is3DAvailable'),
    ComboAdvantageId: text('ComboAdvantageId'),
    VolumePermyriads: jsonb('VolumePermyriads'),
    VocalVolumePermyriads: jsonb('VocalVolumePermyriads'),
    Bars: jsonb('Bars'),
    Beats: jsonb('Beats'),
    Bpms: jsonb('Bpms'),
    ChartStartOffsetMillisecond: bigint('ChartStartOffsetMillisecond', { mode: 'number' }),
    DisplayCharacterAmount: bigint('DisplayCharacterAmount', { mode: 'number' }),
    ColorVariation: bigint('ColorVariation', { mode: 'number' }),
    Digests: jsonb('Digests'),
    ReleaseTime: bigint('ReleaseTime', { mode: 'number' }),
    OriginalCharacterIds: jsonb('OriginalCharacterIds'),
    NotSelectableStageTypes: jsonb('NotSelectableStageTypes'),
    MvAssetId: text('MvAssetId'),
    SelectableStageIds: jsonb('SelectableStageIds'),
    Is360LiveExist: boolean('Is360LiveExist'),
  },
  (t) => [uniqueIndex('master_music_id_idx').on(t.Id)],
);

export const masterShowcaseMusic = pgTable(
  'master_ShowcaseMusic',
  {
    MusicId: text('MusicId').notNull(),
    Order: bigint('Order', { mode: 'number' }),
    ShowcaseMusicFilterId: text('ShowcaseMusicFilterId'),
  },
  (t) => [uniqueIndex('master_showcase_music_music_id_idx').on(t.MusicId)],
);

export const masterShowcaseMusicFilter = pgTable(
  'master_ShowcaseMusicFilter',
  {
    Id: text('Id').notNull(),
    Name: text('Name'),
    Order: bigint('Order', { mode: 'number' }),
  },
  (t) => [uniqueIndex('master_showcase_music_filter_id_idx').on(t.Id)],
);

export const masterShowcaseSetting = pgTable(
  'master_ShowcaseSetting',
  {
    Id: text('Id').notNull(),
    RewardLikeObtainLimit: bigint('RewardLikeObtainLimit', { mode: 'number' }),
    LikeCountLimit: bigint('LikeCountLimit', { mode: 'number' }),
    ShowcaseToyObtainLimit: bigint('ShowcaseToyObtainLimit', { mode: 'number' }),
    ShowcaseDetailNameLimit: bigint('ShowcaseDetailNameLimit', { mode: 'number' }),
    ShowcaseDetailDescriptionLimit: bigint('ShowcaseDetailDescriptionLimit', { mode: 'number' }),
    ShowcaseMysetNameLimit: bigint('ShowcaseMysetNameLimit', { mode: 'number' }),
    ShowcaseFrameDefaultId: text('ShowcaseFrameDefaultId'),
    RewardLikeDailyRecovery: bigint('RewardLikeDailyRecovery', { mode: 'number' }),
    ShowcaseUndoCountLimit: bigint('ShowcaseUndoCountLimit', { mode: 'number' }),
    ShowcaseThumbnailDefaultAssetId: text('ShowcaseThumbnailDefaultAssetId'),
    RewardLikeUsedRewardId: text('RewardLikeUsedRewardId'),
    DefaultShowcaseToyShopConsumptionItemId: text('DefaultShowcaseToyShopConsumptionItemId'),
  },
  (t) => [uniqueIndex('master_showcase_setting_id_idx').on(t.Id)],
);

export const masterShowcaseToy = pgTable(
  'master_ShowcaseToy',
  {
    Id: text('Id').notNull(),
    FilterIds: jsonb('FilterIds'),
    CategoryId: text('CategoryId'),
    Name: text('Name'),
    AssetId: text('AssetId'),
    Description: text('Description'),
    HashTagIds: jsonb('HashTagIds'),
    PutTypes: jsonb('PutTypes'),
    Order: bigint('Order', { mode: 'number' }),
    PhotoShootingCharacterIds: jsonb('PhotoShootingCharacterIds'),
    Angle: bigint('Angle', { mode: 'number' }),
  },
  (t) => [uniqueIndex('master_showcase_toy_id_idx').on(t.Id)],
);

export const masterShowcaseToyCategory = pgTable(
  'master_ShowcaseToyCategory',
  {
    Id: text('Id').notNull(),
    Order: bigint('Order', { mode: 'number' }),
    Name: text('Name'),
  },
  (t) => [uniqueIndex('master_showcase_toy_category_id_idx').on(t.Id)],
);

export const masterShowcaseToyShopFilter = pgTable(
  'master_ShowcaseToyShopFilter',
  {
    Id: text('Id').notNull(),
    Name: text('Name'),
    Order: bigint('Order', { mode: 'number' }),
    AssetId: text('AssetId'),
  },
  (t) => [uniqueIndex('master_showcase_toy_shop_filter_id_idx').on(t.Id)],
);

export const masterExcursionPlace = pgTable(
  'master_ExcursionPlace',
  {
    Id: text('Id').notNull(),
    Name: text('Name'),
    AdvAssetId: text('AdvAssetId'),
    IdleCameraMotionAssetId: text('IdleCameraMotionAssetId'),
    BackgroundAssetId: text('BackgroundAssetId'),
    BgmAssetId: text('BgmAssetId'),
    SceneLayoutAssetId: text('SceneLayoutAssetId'),
    AdvNotWearableCostumeTypeIds: jsonb('AdvNotWearableCostumeTypeIds'),
    FinishAdvNotWearableCostumeTypeIds: jsonb('FinishAdvNotWearableCostumeTypeIds'),
    NotWearableCostumeTypeIds: jsonb('NotWearableCostumeTypeIds'),
  },
  (t) => [uniqueIndex('master_excursion_place_id_idx').on(t.Id)],
);

export const masterSetting = pgTable(
  'master_Setting',
  {
    Id: text('Id').notNull(),
    AccessoryEnhancesRequiredMaterialAmount: bigint('AccessoryEnhancesRequiredMaterialAmount', { mode: 'number' }),
    AccessoryLimit: bigint('AccessoryLimit', { mode: 'number' }),
    CardResetStoneAmount: bigint('CardResetStoneAmount', { mode: 'number' }),
    CardSupportLevelLimit: bigint('CardSupportLevelLimit', { mode: 'number' }),
    CardSupportRemovableMinutes: bigint('CardSupportRemovableMinutes', { mode: 'number' }),
    PhotoDeleteAmountLimit: bigint('PhotoDeleteAmountLimit', { mode: 'number' }),
    PhotoDefaultLimit: bigint('PhotoDefaultLimit', { mode: 'number' }),
    PhotoLimitExtendAmount: bigint('PhotoLimitExtendAmount', { mode: 'number' }),
    PhotoLimitExtendStone: bigint('PhotoLimitExtendStone', { mode: 'number' }),
    PhotoLimitExtendLimit: bigint('PhotoLimitExtendLimit', { mode: 'number' }),
    PhotoRecipeLimit: bigint('PhotoRecipeLimit', { mode: 'number' }),
    PhotoRecipeSaleAmountLimit: bigint('PhotoRecipeSaleAmountLimit', { mode: 'number' }),
    GoldLimit: bigint('GoldLimit', { mode: 'number' }),
    ItemLimit: bigint('ItemLimit', { mode: 'number' }),
    FreeStoneLimit: bigint('FreeStoneLimit', { mode: 'number' }),
    PaidStoneLimit: bigint('PaidStoneLimit', { mode: 'number' }),
    CardStaminaBarMax: bigint('CardStaminaBarMax', { mode: 'number' }),
    SecondsPerActivityLessonStep: bigint('SecondsPerActivityLessonStep', { mode: 'number' }),
    SecondsPerActivityPromotionStep: bigint('SecondsPerActivityPromotionStep', { mode: 'number' }),
    CharacterSecondToRecover: bigint('CharacterSecondToRecover', { mode: 'number' }),
    LiveLightFanAmountWeightPermil: bigint('LiveLightFanAmountWeightPermil', { mode: 'number' }),
    LiveMiddleFanAmountWeightPermil: bigint('LiveMiddleFanAmountWeightPermil', { mode: 'number' }),
    LiveHeavyFanAmountWeightPermil: bigint('LiveHeavyFanAmountWeightPermil', { mode: 'number' }),
    PhotoShootingItemThresholds: jsonb('PhotoShootingItemThresholds'),
    StoryPhotoShootingDefaultCharacterId: text('StoryPhotoShootingDefaultCharacterId'),
    ActivityLessonPromoteLimitCount: bigint('ActivityLessonPromoteLimitCount', { mode: 'number' }),
    ActivityLessonPromoteRequiredStoneAmount: bigint('ActivityLessonPromoteRequiredStoneAmount', {
      mode: 'number',
    }),
    ActivityLessonPromoteEffectHours: bigint('ActivityLessonPromoteEffectHours', { mode: 'number' }),
    ActivityLessonPromoteFreeLimitCount: bigint('ActivityLessonPromoteFreeLimitCount', {
      mode: 'number',
    }),
  },
  (t) => [uniqueIndex('master_setting_id_idx').on(t.Id)],
);

export const masterStory = pgTable(
  'master_Story',
  {
    Id: text('Id').notNull(),
    SectionName: text('SectionName'),
    Name: text('Name'),
    Description: text('Description'),
    RewardId: text('RewardId'),
    AdvPlayTypes: jsonb('AdvPlayTypes'),
    AdvAssetIds: jsonb('AdvAssetIds'),
    AdditionalDisplayCharacterIds: jsonb('AdditionalDisplayCharacterIds'),
    BranchFirstText: text('BranchFirstText'),
    BranchCautionText: text('BranchCautionText'),
    BranchBgmAssetId: text('BranchBgmAssetId'),
    BranchChoices: jsonb('BranchChoices'),
  },
  (t) => [uniqueIndex('master_story_id_idx').on(t.Id)],
);

export const masterStoryPart = pgTable(
  'master_StoryPart',
  {
    Id: text('Id').notNull(),
    AssetId: text('AssetId'),
    Name: text('Name'),
    SubTitle: text('SubTitle'),
    Order: bigint('Order', { mode: 'number' }),
    Type: bigint('Type', { mode: 'number' }),
    ViewConditionId: text('ViewConditionId'),
    UnlockConditionId: text('UnlockConditionId'),
    PointType: bigint('PointType', { mode: 'number' }),
    StoryEpisodeConsumptionId: text('StoryEpisodeConsumptionId'),
    Chapters: jsonb('Chapters'),
    NoteText: text('NoteText'),
  },
  (t) => [uniqueIndex('master_story_part_id_idx').on(t.Id)],
);

export const masterStoryEpisodeConsumption = pgTable(
  'master_StoryEpisodeConsumption',
  {
    Id: text('Id').notNull(),
    ReleaseCount: bigint('ReleaseCount', { mode: 'number' }).notNull(),
    RequiredStoryPoint: bigint('RequiredStoryPoint', { mode: 'number' }),
  },
  (t) => [uniqueIndex('master_story_episode_consumption_key_idx').on(t.Id, t.ReleaseCount)],
);

export const masterEventStory = pgTable(
  'master_EventStory',
  {
    Id: text('Id').notNull(),
    AssetId: text('AssetId'),
    Name: text('Name'),
    Description: text('Description'),
    Order: bigint('Order', { mode: 'number' }),
    ViewConditionId: text('ViewConditionId'),
    Episodes: jsonb('Episodes'),
  },
  (t) => [uniqueIndex('master_event_story_id_idx').on(t.Id)],
);

export const masterExtraStory = pgTable(
  'master_ExtraStory',
  {
    Id: text('Id').notNull(),
    ExtraStoryPartId: text('ExtraStoryPartId'),
    AssetId: text('AssetId'),
    Name: text('Name'),
    Description: text('Description'),
    Order: bigint('Order', { mode: 'number' }),
    ViewConditionId: text('ViewConditionId'),
    UnlockConditionId: text('UnlockConditionId'),
    Episodes: jsonb('Episodes'),
    ExtraStoryType: bigint('ExtraStoryType', { mode: 'number' }),
    IconAssetId: text('IconAssetId'),
    BackgroundAssetId: text('BackgroundAssetId'),
    SecretEffectColorCode: text('SecretEffectColorCode'),
  },
  (t) => [uniqueIndex('master_extra_story_id_idx').on(t.Id)],
);

export const masterExtraStoryPart = pgTable(
  'master_ExtraStoryPart',
  {
    Id: text('Id').notNull(),
    AssetId: text('AssetId'),
    Name: text('Name'),
    SubTitle: text('SubTitle'),
    NoteText: text('NoteText'),
    Order: bigint('Order', { mode: 'number' }),
    Type: bigint('Type', { mode: 'number' }),
    ViewConditionId: text('ViewConditionId'),
    UnlockConditionId: text('UnlockConditionId'),
    ExtraStoryIds: jsonb('ExtraStoryIds'),
  },
  (t) => [uniqueIndex('master_extra_story_part_id_idx').on(t.Id)],
);

export const masterCardEvolution = pgTable(
  'master_CardEvolution',
  {
    CardId: text('CardId').notNull(),
    EvolutionLevel: bigint('EvolutionLevel', { mode: 'number' }).notNull(),
    RewardCostumeId: text('RewardCostumeId'),
    RewardHairId: text('RewardHairId'),
  },
  (t) => [uniqueIndex('master_card_evolution_key_idx').on(t.CardId, t.EvolutionLevel)],
);

export const masterCardEvolutionLevel = pgTable(
  'master_CardEvolutionLevel',
  {
    GroupId: text('GroupId').notNull(),
    Level: bigint('Level', { mode: 'number' }).notNull(),
    Exp: bigint('Exp', { mode: 'number' }),
    DuplicateObtainExp: bigint('DuplicateObtainExp', { mode: 'number' }),
  },
  (t) => [uniqueIndex('master_card_evolution_level_key_idx').on(t.GroupId, t.Level)],
);

export const masterCardEvolutionLevelRelease = pgTable(
  'master_CardEvolutionLevelRelease',
  {
    GroupId: text('GroupId').notNull(),
    Level: bigint('Level', { mode: 'number' }).notNull(),
    Targets: jsonb('Targets'),
  },
  (t) => [uniqueIndex('master_card_evolution_level_release_key_idx').on(t.GroupId, t.Level)],
);

export const masterCardEvolutionMessage = pgTable(
  'master_CardEvolutionMessage',
  {
    CardId: text('CardId').notNull(),
    EvolutionLevel: bigint('EvolutionLevel', { mode: 'number' }).notNull(),
    Number: bigint('Number', { mode: 'number' }).notNull(),
    CharacterId: text('CharacterId'),
    EvolveMessage: text('EvolveMessage'),
    VoiceAssetId: text('VoiceAssetId'),
  },
  (t) =>
    [uniqueIndex('master_card_evolution_message_key_idx').on(t.CardId, t.EvolutionLevel, t.Number)],
);

export const masterCharacter = pgTable(
  'master_Character',
  {
    Id: text('Id').notNull(),
    AssetId: text('AssetId'),
    CharacterGroupId: text('CharacterGroupId'),
    Name: text('Name'),
    EnName: text('EnName'),
    Cv: text('Cv'),
    Color: text('Color'),
    DefaultCostumeId: text('DefaultCostumeId'),
    LoveInfo: jsonb('LoveInfo'),
    LoveInfos: jsonb('LoveInfos'),
    Type: bigint('Type', { mode: 'number' }),
  },
  (t) => [uniqueIndex('master_character_key_idx').on(t.Id)],
);

export const masterMessageGroup = pgTable(
  'master_MessageGroup',
  {
    Id: text('Id').notNull(),
    Name: text('Name'),
    AssetId: text('AssetId'),
    CharacterIds: jsonb('CharacterIds'),
  },
  (t) => [uniqueIndex('master_message_group_id_idx').on(t.Id)],
);

export const masterMessage = pgTable(
  'master_Message',
  {
    Id: text('Id').notNull(),
    MessageGroupId: text('MessageGroupId'),
    Name: text('Name'),
    Type: bigint('Type', { mode: 'number' }),
    CharacterId: text('CharacterId'),
    InstantType: bigint('InstantType', { mode: 'number' }),
    RarityType: bigint('RarityType', { mode: 'number' }),
    UnlockConditionId: text('UnlockConditionId'),
    Details: jsonb('Details'),
  },
  (t) => [uniqueIndex('master_message_id_idx').on(t.Id)],
);

export const masterTelephone = pgTable(
  'master_Telephone',
  {
    Id: text('Id').notNull(),
    MessageGroupId: text('MessageGroupId'),
    CharacterId: text('CharacterId'),
    Name: text('Name'),
    AssetId: text('AssetId'),
    UnlockConditionId: text('UnlockConditionId'),
  },
  (t) => [uniqueIndex('master_telephone_id_idx').on(t.Id)],
);

export const masterLoveLevel = pgTable(
  'master_LoveLevel',
  {
    LoveId: text('LoveId').notNull(),
    Level: bigint('Level', { mode: 'number' }).notNull(),
    RequiredExp: bigint('RequiredExp', { mode: 'number' }),
    LessonStepRewardExp: bigint('LessonStepRewardExp', { mode: 'number' }),
    LessonStepRewardStoryReadItemAmount: bigint('LessonStepRewardStoryReadItemAmount', {
      mode: 'number',
    }),
  },
  (t) => [uniqueIndex('master_love_level_key_idx').on(t.LoveId, t.Level)],
);

export const masterLoveStoryEpisode = pgTable(
  'master_LoveStoryEpisode',
  {
    Id: text('Id').notNull(),
    LoveId: text('LoveId').notNull(),
    Episode: bigint('Episode', { mode: 'number' }).notNull(),
    StoryId: text('StoryId'),
    AssetId: text('AssetId'),
    ConsumptionItemAmount: bigint('ConsumptionItemAmount', { mode: 'number' }),
  },
  (t) => [uniqueIndex('master_love_story_episode_key_idx').on(t.Id)],
);

export const masterLoveColor = pgTable(
  'master_LoveColor',
  {
    LoveId: text('LoveId').notNull(),
    ExecuteButtonGradientStartColor: text('ExecuteButtonGradientStartColor'),
    ExecuteButtonGradientEndColor: text('ExecuteButtonGradientEndColor'),
    HomeButtonFrameColor: text('HomeButtonFrameColor'),
    StorySelectMaskColor: text('StorySelectMaskColor'),
    ItemBackgroundColor: text('ItemBackgroundColor'),
    LoveLevelBackgroundColor: text('LoveLevelBackgroundColor'),
    MainColor: text('MainColor'),
    NoticeColor: text('NoticeColor'),
    PickupTextColor: text('PickupTextColor'),
    OverlayBackgroundColor: text('OverlayBackgroundColor'),
    ScreenBackgroundColor: text('ScreenBackgroundColor'),
    IconColor: text('IconColor'),
    BorderLineColor: text('BorderLineColor'),
    GaugeColor: text('GaugeColor'),
    FooterGradientStartColor: text('FooterGradientStartColor'),
    FooterGradientEndColor: text('FooterGradientEndColor'),
    StartButtonGradientColor1: text('StartButtonGradientColor1'),
    StartButtonGradientColor2: text('StartButtonGradientColor2'),
    StartButtonGradientColor3: text('StartButtonGradientColor3'),
    StartButtonTextColor: text('StartButtonTextColor'),
    LoveLevelUpBackgroundColor: text('LoveLevelUpBackgroundColor'),
    AdvMainColor: text('AdvMainColor'),
  },
  (t) => [uniqueIndex('master_love_color_key_idx').on(t.LoveId)],
);

export const masterLoveHomeAction = pgTable(
  'master_LoveHomeAction',
  {
    Id: text('Id').notNull(),
    LoveId: text('LoveId').notNull(),
    CharacterId: text('CharacterId'),
    MotionAssetId: text('MotionAssetId'),
    AdditionMotionAssetId: text('AdditionMotionAssetId'),
    VoiceAssetId: text('VoiceAssetId'),
    Text: text('Text'),
    ActionType: bigint('ActionType', { mode: 'number' }),
    HiddenFavorabilityGte: bigint('HiddenFavorabilityGte', { mode: 'number' }),
    HiddenFavorabilityLte: bigint('HiddenFavorabilityLte', { mode: 'number' }),
    UnlockLoveStoryEndIds: jsonb('UnlockLoveStoryEndIds'),
    NowAfter: bigint('NowAfter', { mode: 'number' }),
    NowBefore: bigint('NowBefore', { mode: 'number' }),
    Weight: bigint('Weight', { mode: 'number' }),
    CostumeId: text('CostumeId'),
  },
  (t) => [uniqueIndex('master_love_home_action_key_idx').on(t.Id)],
);

export const masterGachaExchange = pgTable(
  'master_GachaExchange',
  {
    Id: text('Id').notNull(),
    RewardId: text('RewardId'),
    ExchangeLimit: bigint('ExchangeLimit', { mode: 'number' }),
    RequiredResourceAmount: bigint('RequiredResourceAmount', { mode: 'number' }),
    Order: bigint('Order', { mode: 'number' }),
    GachaId: text('GachaId'),
  },
  (t) => [uniqueIndex('master_gacha_exchange_id_idx').on(t.Id)],
);

export const masterGachaStamp = pgTable(
  'master_GachaStamp',
  {
    GroupId: text('GroupId').notNull(),
    SheetNumber: bigint('SheetNumber', { mode: 'number' }).notNull(),
    StampNumber: bigint('StampNumber', { mode: 'number' }).notNull(),
    RewardId: text('RewardId'),
    RewardGachaButtonId: text('RewardGachaButtonId'),
    AssetId: text('AssetId'),
    Description: text('Description'),
    IsFeatured: boolean('IsFeatured'),
  },
  (t) => [
    uniqueIndex('master_gacha_stamp_key_idx').on(t.GroupId, t.SheetNumber, t.StampNumber),
  ],
);

export const masterGachaStampSheet = pgTable(
  'master_GachaStampSheet',
  {
    GroupId: text('GroupId').notNull(),
    SheetNumber: bigint('SheetNumber', { mode: 'number' }).notNull(),
    CostumeIds: jsonb('CostumeIds'),
  },
  (t) => [uniqueIndex('master_gacha_stamp_sheet_key_idx').on(t.GroupId, t.SheetNumber)],
);

export const masterGachaStampSheetGroup = pgTable(
  'master_GachaStampSheetGroup',
  {
    GroupId: text('GroupId').notNull(),
    AssetId: text('AssetId'),
  },
  (t) => [uniqueIndex('master_gacha_stamp_sheet_group_key_idx').on(t.GroupId)],
);

export const masterBoxGacha = pgTable(
  'master_BoxGacha',
  {
    Id: text('Id').notNull(),
    BoxGachaGroupId: text('BoxGachaGroupId'),
    Name: text('Name'),
    UnlockConditionId: text('UnlockConditionId'),
    RequiredResourceAmount: bigint('RequiredResourceAmount', { mode: 'number' }),
    CanReset: boolean('CanReset'),
    ResetLimitCount: bigint('ResetLimitCount', { mode: 'number' }),
  },
  (t) => [uniqueIndex('master_box_gacha_id_idx').on(t.Id)],
);

export const masterBoxGachaGroup = pgTable(
  'master_BoxGachaGroup',
  {
    Id: text('Id').notNull(),
    RequiredResourceType: bigint('RequiredResourceType', { mode: 'number' }),
    RequiredResourceId: text('RequiredResourceId'),
  },
  (t) => [uniqueIndex('master_box_gacha_group_id_idx').on(t.Id)],
);

// Hierarchy grades: `Profile:Top` reports the player's current detail grade.
// The master rows are ordered high → low by required hierarchy points.
export const masterHierarchyDetailGrade = pgTable(
  'master_HierarchyDetailGrade',
  {
    Id: text('Id').notNull(),
    HierarchyGradeId: text('HierarchyGradeId'),
    SubName: text('SubName'),
    RequiredHierarchyPoint: bigint('RequiredHierarchyPoint', { mode: 'number' }),
    RequiredHierarchyRank: bigint('RequiredHierarchyRank', { mode: 'number' }),
  },
  (t) => [uniqueIndex('master_hierarchy_detail_grade_id_idx').on(t.Id)],
);

export const masterMarathonBoxGachaSetting = pgTable(
  'master_MarathonBoxGachaSetting',
  {
    MarathonId: text('MarathonId').notNull(),
    BoxGachaId: text('BoxGachaId').notNull(),
    Order: bigint('Order', { mode: 'number' }),
    UnlockRequiredPoint: bigint('UnlockRequiredPoint', { mode: 'number' }),
    GuageColorCode: text('GuageColorCode'),
    GuageName: text('GuageName'),
  },
  (t) => [
    uniqueIndex('master_marathon_box_gacha_setting_key_idx').on(t.MarathonId, t.BoxGachaId),
  ],
);

// Home-screen talks. `ConditionId` points at `master_Condition`; the sandbox
// seed reads the fan thresholds from there when it raises `UserCharacter`.
export const masterHomeTalk = pgTable(
  'master_HomeTalk',
  {
    HomeTalkId: text('HomeTalkId').notNull(),
    CharacterId: text('CharacterId'),
    PlaceType: bigint('PlaceType', { mode: 'number' }),
    ConditionId: text('ConditionId'),
    FirstPriority: bigint('FirstPriority', { mode: 'number' }),
    Weight: bigint('Weight', { mode: 'number' }),
    CallPatternId: text('CallPatternId'),
    ChoiceText: text('ChoiceText'),
    ManagerText: text('ManagerText'),
    Reliability: bigint('Reliability', { mode: 'number' }),
    Title: text('Title'),
    CardId: text('CardId'),
    DisplayConditionDescription: text('DisplayConditionDescription'),
    Order: bigint('Order', { mode: 'number' }),
    ReleaseDate: bigint('ReleaseDate', { mode: 'number' }),
    CharacterTalks: jsonb('CharacterTalks'),
  },
  (t) => [uniqueIndex('master_home_talk_id_idx').on(t.HomeTalkId)],
);

// Excursion (おでかけ) place availability per character. A character can visit
// the places listed here; the place itself (camera/background/wardrobe rules)
// lives in `master_ExcursionPlace`.
export const masterExcursionPlaceSetting = pgTable(
  'master_ExcursionPlaceSetting',
  {
    CharacterId: text('CharacterId').notNull(),
    ExcursionPlaceId: text('ExcursionPlaceId').notNull(),
    AdvForceCostumeId: text('AdvForceCostumeId'),
    PropAssetId: text('PropAssetId'),
    ForceCostumeId: text('ForceCostumeId'),
    MinFocalLength: doublePrecision('MinFocalLength'),
    DefaultFocalLength: doublePrecision('DefaultFocalLength'),
    MaxFocalLength: doublePrecision('MaxFocalLength'),
    SceneLayoutPositionIndex: bigint('SceneLayoutPositionIndex', { mode: 'number' }),
    FinishAdvForceCostumeId: text('FinishAdvForceCostumeId'),
  },
  (t) => [
    uniqueIndex('master_excursion_place_setting_key_idx').on(t.CharacterId, t.ExcursionPlaceId),
  ],
);

// Gaze reactions shown while the player watches an excursion scene. `Number`
// is the client-facing reaction number and is 0 for the default/idle reaction.
export const masterExcursionGazeReaction = pgTable(
  'master_ExcursionGazeReaction',
  {
    CharacterId: text('CharacterId').notNull(),
    ExcursionPlaceId: text('ExcursionPlaceId').notNull(),
    Number: bigint('Number', { mode: 'number' }).notNull(),
    MotionAssetId: text('MotionAssetId'),
    VoiceAssetId: text('VoiceAssetId'),
    UnlockCostumeIds: jsonb('UnlockCostumeIds'),
    UnlockNotCostumeIds: jsonb('UnlockNotCostumeIds'),
    CameraMotionAssetId: text('CameraMotionAssetId'),
    PropAssetId: text('PropAssetId'),
    IsFade: boolean('IsFade'),
    IsLookAt: boolean('IsLookAt'),
    Text: text('Text'),
    FocalLength: doublePrecision('FocalLength'),
    FNumberRatio: doublePrecision('FNumberRatio'),
    TrackingAccuracy: doublePrecision('TrackingAccuracy'),
    YOffset: doublePrecision('YOffset'),
    UnlockGazeNumbers: jsonb('UnlockGazeNumbers'),
  },
  (t) => [
    uniqueIndex('master_excursion_gaze_reaction_key_idx').on(
      t.CharacterId,
      t.ExcursionPlaceId,
      t.Number,
    ),
  ],
);

// Company (company enjoy) points earned per item, used to pick the excursion
// completion gift: the highest-`ObtainPoint` item for the character.
export const masterCompanyEnjoyObtainPointItemSetting = pgTable(
  'master_CompanyEnjoyObtainPointItemSetting',
  {
    CharacterId: text('CharacterId').notNull(),
    ItemId: text('ItemId').notNull(),
    ObtainPoint: bigint('ObtainPoint', { mode: 'number' }),
    GrowthType: bigint('GrowthType', { mode: 'number' }),
  },
  (t) => [
    uniqueIndex('master_company_enjoy_obtain_point_item_key_idx').on(t.CharacterId, t.ItemId),
  ],
);

// Area (エリア) presentation and daily limits. `QuestIds` references the
// quests shown for the area; the condition tables hold the client-side
// visibility/unlock settings.
export const masterArea = pgTable(
  'master_Area',
  {
    Id: text('Id').notNull(),
    Type: bigint('Type', { mode: 'number' }),
    Name: text('Name'),
    Description: text('Description'),
    Order: bigint('Order', { mode: 'number' }),
    AreaGroupId: text('AreaGroupId'),
    ViewConditionId: text('ViewConditionId'),
    UnlockConditionId: text('UnlockConditionId'),
    DailyLimitCount: bigint('DailyLimitCount', { mode: 'number' }),
    DailyTicketItemType: bigint('DailyTicketItemType', { mode: 'number' }),
    RewardAssetId: text('RewardAssetId'),
    AssetId: text('AssetId'),
    ColorCode: text('ColorCode'),
    DailySpecialTicketItemId: text('DailySpecialTicketItemId'),
    DailyRewardName: text('DailyRewardName'),
    QuestIds: jsonb('QuestIds'),
  },
  (t) => [uniqueIndex('master_area_id_idx').on(t.Id)],
);

export const masterCondition = pgTable(
  'master_Condition',
  {
    Id: text('Id').notNull(),
    Settings: jsonb('Settings'),
  },
  (t) => [uniqueIndex('master_condition_id_idx').on(t.Id)],
);

// Manager level progression (the old 0022 migration never reached main).
export const masterManagerLevel = pgTable(
  'master_ManagerLevel',
  {
    Level: bigint('Level', { mode: 'number' }).notNull(),
    RequiredExp: bigint('RequiredExp', { mode: 'number' }),
    MaxCardLevel: bigint('MaxCardLevel', { mode: 'number' }),
    MaxPhotoEnhanceLevel: bigint('MaxPhotoEnhanceLevel', { mode: 'number' }),
    MaxPhotoReportLevel: bigint('MaxPhotoReportLevel', { mode: 'number' }),
  },
  (t) => [uniqueIndex('master_manager_level_key_idx').on(t.Level)],
);
