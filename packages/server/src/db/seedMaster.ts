// Seed the curated A2 master-data tables into Postgres from
// phaseA2/out/structured/<Type>.json. Re-runnable: each table is cleared then
// fully re-inserted, and the manifest version is recorded in server_meta.
//
// Usage: npm run db:seed-master
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getTableColumns, sql } from 'drizzle-orm';
import { db } from './client.ts';
import { DATA_DIR } from '../config.ts';
import { serverMeta } from './schema.ts';
import {
  masterItem,
  masterReward,
  masterRewardSort,
  masterMission,
  masterEventMission,
  masterLoginBonus,
  masterLoginBonusText,
  masterCard,
  masterCardLevel,
  masterCardLevelRelease,
  masterCardParameter,
  masterGacha,
  masterGachaButton,
  masterConsumption,
  masterCardDuplicateReward,
  masterCardDuplicateExp,
  masterCostume,
  masterHair,
  masterEmblem,
  masterAccessory,
  masterAccessoryEnhancement,
  masterCardRarity,
  masterCardRank,
  masterCardSupportRelease,
  masterPhotoRarityLevel,
  masterPhotoRetouchEnhance,
  masterLiveAbility,
  masterActivityAbility,
  masterSkill,
  masterPhotoAbility,
  masterPhotoRecipe,
  masterPhotoActivity,
  masterPhotoQuestMusic,
  masterPhotoQuestStage,
  masterStage,
  masterPhotoExpression,
  masterPhotoExpressionStagePosition,
  masterPhotoAbilitySet,
  masterPhotoPose,
  masterPhotoFacial,
  masterPhotoAllInOne,
  masterPhotoContestActivity,
  masterPhotoContestQuestMusic,
  masterPhotoContestQuestStage,
  masterPhotoContestSection,
  masterPhotoContestSectionReward,
  masterQuestContestRankingSeason,
  masterShowcaseFrame,
  masterShowcaseHashtag,
  masterShowcaseMusic,
  masterShowcaseMusicFilter,
  masterShowcaseSetting,
  masterShowcaseToy,
  masterShowcaseToyCategory,
  masterShowcaseToyShopFilter,
  masterExcursionPlace,
  masterExcursionPlaceSetting,
  masterExcursionGazeReaction,
  masterCompanyEnjoyObtainPointItemSetting,
  masterSetting,
  masterStory,
  masterStoryPart,
  masterStoryEpisodeConsumption,
  masterEventStory,
  masterExtraStory,
  masterExtraStoryPart,
  masterCardEvolution,
  masterCardEvolutionLevel,
  masterCardEvolutionLevelRelease,
  masterCardEvolutionMessage,
  masterCharacter,
  masterMessageGroup,
  masterMessage,
  masterTelephone,
  masterLoveLevel,
  masterLoveStoryEpisode,
  masterLoveColor,
  masterLoveHomeAction,
  masterGachaExchange,
  masterGachaStamp,
  masterGachaStampSheet,
  masterGachaStampSheetGroup,
  masterBoxGacha,
  masterBoxGachaGroup,
  masterMarathonBoxGachaSetting,
  masterHomeTalk,
  masterArea,
  masterCondition,
  masterManagerLevel,
  masterMusic,
  masterHierarchyDetailGrade,
  masterActivityPerformance,
  masterCharacterActivityLevel,
  masterQuest,
  masterAreaGroup,
  masterMusicChartPattern,
  masterMusicMasteryLevel,
  masterMusicMasteryReward,
  masterMusicMasteryRewardSet,
  masterSkillEfficacy,
  masterSkillTrigger,
  masterSkillTarget,
  masterQuestStaminaConsumption,
  masterQuestAudienceAdvantage,
  masterQuestCharacterAdvantage,
  masterComboAdvantage,
  masterQuestPressure,
  masterLiveBonus,
  masterLiveBonusGroup,
  masterPhotoAbilityTarget,
  masterStatusEffectName,
  masterFunctionLock,
  masterHierarchyReward,
  masterHierarchyDivisionReward,
} from './masterSchema.ts';

const STRUCTURED_DIR =
  process.env.MASTER_STRUCTURED_DIR ??
  join(DATA_DIR, 'phaseA2', 'out', 'structured');
const MANIFEST_PATH = join(STRUCTURED_DIR, '..', 'manifest.json');

// type name in structured/<Type>.json -> drizzle table
const MASTER_TABLES = {
  Item: masterItem,
  Reward: masterReward,
  RewardSort: masterRewardSort,
  Mission: masterMission,
  EventMission: masterEventMission,
  LoginBonus: masterLoginBonus,
  LoginBonusText: masterLoginBonusText,
  Card: masterCard,
  CardLevel: masterCardLevel,
  CardLevelRelease: masterCardLevelRelease,
  CardParameter: masterCardParameter,
  Gacha: masterGacha,
  GachaButton: masterGachaButton,
  Consumption: masterConsumption,
  CardDuplicateReward: masterCardDuplicateReward,
  CardDuplicateExp: masterCardDuplicateExp,
  Costume: masterCostume,
  Hair: masterHair,
  Emblem: masterEmblem,
  Accessory: masterAccessory,
  AccessoryEnhancement: masterAccessoryEnhancement,
  CardRarity: masterCardRarity,
  CardRank: masterCardRank,
  CardSupportRelease: masterCardSupportRelease,
  PhotoRarityLevel: masterPhotoRarityLevel,
  PhotoRetouchEnhance: masterPhotoRetouchEnhance,
  LiveAbility: masterLiveAbility,
  ActivityAbility: masterActivityAbility,
  Skill: masterSkill,
  PhotoAbility: masterPhotoAbility,
  PhotoRecipe: masterPhotoRecipe,
  PhotoActivity: masterPhotoActivity,
  PhotoQuestMusic: masterPhotoQuestMusic,
  PhotoQuestStage: masterPhotoQuestStage,
  Stage: masterStage,
  PhotoExpression: masterPhotoExpression,
  PhotoExpressionStagePosition: masterPhotoExpressionStagePosition,
  PhotoAbilitySet: masterPhotoAbilitySet,
  PhotoPose: masterPhotoPose,
  PhotoFacial: masterPhotoFacial,
  PhotoAllInOne: masterPhotoAllInOne,
  PhotoContestActivity: masterPhotoContestActivity,
  PhotoContestQuestMusic: masterPhotoContestQuestMusic,
  PhotoContestQuestStage: masterPhotoContestQuestStage,
  PhotoContestSection: masterPhotoContestSection,
  PhotoContestSectionReward: masterPhotoContestSectionReward,
  QuestContestRankingSeason: masterQuestContestRankingSeason,
  ShowcaseFrame: masterShowcaseFrame,
  ShowcaseHashtag: masterShowcaseHashtag,
  ShowcaseMusic: masterShowcaseMusic,
  ShowcaseMusicFilter: masterShowcaseMusicFilter,
  ShowcaseSetting: masterShowcaseSetting,
  ShowcaseToy: masterShowcaseToy,
  ShowcaseToyCategory: masterShowcaseToyCategory,
  ShowcaseToyShopFilter: masterShowcaseToyShopFilter,
  ExcursionPlace: masterExcursionPlace,
  ExcursionPlaceSetting: masterExcursionPlaceSetting,
  ExcursionGazeReaction: masterExcursionGazeReaction,
  CompanyEnjoyObtainPointItemSetting: masterCompanyEnjoyObtainPointItemSetting,
  Setting: masterSetting,
  Story: masterStory,
  StoryPart: masterStoryPart,
  StoryEpisodeConsumption: masterStoryEpisodeConsumption,
  EventStory: masterEventStory,
  ExtraStory: masterExtraStory,
  ExtraStoryPart: masterExtraStoryPart,
  CardEvolution: masterCardEvolution,
  CardEvolutionLevel: masterCardEvolutionLevel,
  CardEvolutionLevelRelease: masterCardEvolutionLevelRelease,
  CardEvolutionMessage: masterCardEvolutionMessage,
  LoveLevel: masterLoveLevel,
  LoveStoryEpisode: masterLoveStoryEpisode,
  LoveColor: masterLoveColor,
  LoveHomeAction: masterLoveHomeAction,
  Character: masterCharacter,
  MessageGroup: masterMessageGroup,
  Message: masterMessage,
  Telephone: masterTelephone,
  GachaExchange: masterGachaExchange,
  GachaStamp: masterGachaStamp,
  GachaStampSheet: masterGachaStampSheet,
  GachaStampSheetGroup: masterGachaStampSheetGroup,
  BoxGacha: masterBoxGacha,
  BoxGachaGroup: masterBoxGachaGroup,
  MarathonBoxGachaSetting: masterMarathonBoxGachaSetting,
  HomeTalk: masterHomeTalk,
  Area: masterArea,
  Condition: masterCondition,
  ManagerLevel: masterManagerLevel,
  Music: masterMusic,
  HierarchyDetailGrade: masterHierarchyDetailGrade,
  ActivityPerformance: masterActivityPerformance,
  CharacterActivityLevel: masterCharacterActivityLevel,
  Quest: masterQuest,
  AreaGroup: masterAreaGroup,
  MusicChartPattern: masterMusicChartPattern,
  MusicMasteryLevel: masterMusicMasteryLevel,
  MusicMasteryReward: masterMusicMasteryReward,
  MusicMasteryRewardSet: masterMusicMasteryRewardSet,
  SkillEfficacy: masterSkillEfficacy,
  SkillTrigger: masterSkillTrigger,
  SkillTarget: masterSkillTarget,
  QuestStaminaConsumption: masterQuestStaminaConsumption,
  QuestAudienceAdvantage: masterQuestAudienceAdvantage,
  QuestCharacterAdvantage: masterQuestCharacterAdvantage,
  ComboAdvantage: masterComboAdvantage,
  QuestPressure: masterQuestPressure,
  LiveBonus: masterLiveBonus,
  LiveBonusGroup: masterLiveBonusGroup,
  PhotoAbilityTarget: masterPhotoAbilityTarget,
  StatusEffectName: masterStatusEffectName,
  FunctionLock: masterFunctionLock,
  HierarchyReward: masterHierarchyReward,
  HierarchyDivisionReward: masterHierarchyDivisionReward,
} as const;

type MasterType = keyof typeof MASTER_TABLES;

// Keep each INSERT under postgres-js' ~65535 bind-parameter ceiling.
const MAX_PARAMS = 30000;

function rowsFor(type: MasterType): Record<string, unknown>[] {
  const raw = JSON.parse(readFileSync(join(STRUCTURED_DIR, `${type}.json`), 'utf8'));
  if (!Array.isArray(raw)) return [];
  return raw;
}

async function seedTable(type: MasterType): Promise<number> {
  const table = MASTER_TABLES[type];
  const cols = getTableColumns(table);
  const colNames = Object.keys(cols);
  const rows = rowsFor(type);

  await db.execute(sql`delete from ${table}`);
  if (rows.length === 0) return 0;

  const values = rows.map((r) => {
    const v: Record<string, unknown> = {};
    for (const c of colNames) {
      const value = (r as Record<string, unknown>)[c] ?? null;
      // The structured JSON writes proto bools as 0/1; postgres-js would store
      // a numeric 1 in a boolean column as false.
      v[c] = (cols as Record<string, { dataType: string }>)[c].dataType === 'boolean' && typeof value === 'number' ? value !== 0 : value;
    }
    return v;
  });

  const perChunk = Math.max(1, Math.floor(MAX_PARAMS / colNames.length));
  let inserted = 0;
  for (let i = 0; i < values.length; i += perChunk) {
    const chunk = values.slice(i, i + perChunk);
    await db.insert(table).values(chunk);
    inserted += chunk.length;
  }
  return inserted;
}

async function main() {
  const version = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')).version as string;
  let grand = 0;
  for (const type of Object.keys(MASTER_TABLES) as MasterType[]) {
    const n = await seedTable(type);
    grand += n;
    console.log(`  ${type.padEnd(18)} ${n} rows`);
  }
  await db
    .insert(serverMeta)
    .values({ key: 'master_version', value: version })
    .onConflictDoUpdate({
      target: serverMeta.key,
      set: { value: version, updatedAt: new Date() },
    });
  console.log(`seeded ${grand} master rows; version=${version}`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
