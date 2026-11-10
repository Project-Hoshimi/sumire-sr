import { and, asc, desc, eq, inArray, like, sql } from 'drizzle-orm';
import { db } from '../db/client.ts';
import { serverMeta } from '../db/schema.ts';
import * as master from '../db/masterSchema.ts';

export const MASTER_VERSION_KEY = 'master_version';

export async function getManifestVersion(): Promise<string | null> {
  const [row] = await db
    .select({ value: serverMeta.value })
    .from(serverMeta)
    .where(eq(serverMeta.key, MASTER_VERSION_KEY))
    .limit(1);
  return row?.value ?? null;
}

export async function getHierarchyDetailGrade(id: string) {
  const [row] = await db
    .select()
    .from(master.masterHierarchyDetailGrade)
    .where(eq(master.masterHierarchyDetailGrade.Id, id))
    .limit(1);
  return row ?? null;
}

/**
 * Lowest hierarchy detail grade, i.e. where a fresh player starts. Master rows
 * are ordered high → low by required points, so order ascending and take the
 * first; a missing point value counts as 0.
 */
export async function getLowestHierarchyDetailGrade() {
  const [row] = await db
    .select()
    .from(master.masterHierarchyDetailGrade)
    .orderBy(
      asc(sql`coalesce(${master.masterHierarchyDetailGrade.RequiredHierarchyPoint}, 0)`),
      asc(master.masterHierarchyDetailGrade.Id),
    )
    .limit(1);
  return row ?? null;
}

export async function getItem(id: string) {
  const [row] = await db.select().from(master.masterItem).where(eq(master.masterItem.Id, id)).limit(1);
  return row ?? null;
}

export async function listItems() {
  return db.select().from(master.masterItem);
}

export async function getReward(id: string) {
  const [row] = await db.select().from(master.masterReward).where(eq(master.masterReward.Id, id)).limit(1);
  return row ?? null;
}

export async function listActivityPromotions() {
  return db.select().from(master.masterActivityPromotion);
}

export async function getActivityPromotion(id: string) {
  const [row] = await db
    .select()
    .from(master.masterActivityPromotion)
    .where(eq(master.masterActivityPromotion.Id, id))
    .limit(1);
  return row ?? null;
}

export async function getActivityPerformance(id: string) {
  const [row] = await db
    .select()
    .from(master.masterActivityPerformance)
    .where(eq(master.masterActivityPerformance.Id, id))
    .limit(1);
  return row ?? null;
}

export async function getCharacterActivityLevel(level: number) {
  const [row] = await db
    .select()
    .from(master.masterCharacterActivityLevel)
    .where(eq(master.masterCharacterActivityLevel.Level, level))
    .limit(1);
  return row ?? null;
}

export async function getMission(id: string) {
  const [row] = await db.select().from(master.masterMission).where(eq(master.masterMission.Id, id)).limit(1);
  return row ?? null;
}

export async function listMissions() {
  return db.select().from(master.masterMission);
}

export async function getLoginBonus(id: string) {
  const [row] = await db
    .select()
    .from(master.masterLoginBonus)
    .where(eq(master.masterLoginBonus.Id, id))
    .limit(1);
  return row ?? null;
}

export async function listLoginBonuses() {
  return db.select().from(master.masterLoginBonus);
}

export async function listLoginBonusTexts() {
  return db.select().from(master.masterLoginBonusText);
}

export async function getCard(id: string) {
  const [row] = await db.select().from(master.masterCard).where(eq(master.masterCard.Id, id)).limit(1);
  return row ?? null;
}

export async function getGacha(id: string) {
  const [row] = await db.select().from(master.masterGacha).where(eq(master.masterGacha.Id, id)).limit(1);
  return row ?? null;
}

export async function listGachas() {
  return db.select().from(master.masterGacha);
}

export async function getGachaButton(id: string) {
  const [row] = await db
    .select()
    .from(master.masterGachaButton)
    .where(eq(master.masterGachaButton.Id, id))
    .limit(1);
  return row ?? null;
}

export async function listGachaButtons() {
  return db.select().from(master.masterGachaButton);
}

export async function getConsumption(id: string) {
  const [row] = await db
    .select()
    .from(master.masterConsumption)
    .where(eq(master.masterConsumption.Id, id))
    .limit(1);
  return row ?? null;
}

export async function getCardDuplicateReward(initialRarity: number, currentRarity: number) {
  const [row] = await db
    .select()
    .from(master.masterCardDuplicateReward)
    .where(
      and(
        eq(master.masterCardDuplicateReward.InitialRarity, initialRarity),
        eq(master.masterCardDuplicateReward.CurrentRarity, currentRarity),
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function getCardDuplicateExp(initialRarity: number) {
  const [row] = await db
    .select()
    .from(master.masterCardDuplicateExp)
    .where(eq(master.masterCardDuplicateExp.InitialRarity, initialRarity))
    .limit(1);
  return row ?? null;
}

export async function getCardParameter(id: string, level: number) {
  const [row] = await db
    .select()
    .from(master.masterCardParameter)
    .where(and(eq(master.masterCardParameter.Id, id), eq(master.masterCardParameter.Level, level)))
    .limit(1);
  return row ?? null;
}

export async function getCardLevel(level: number) {
  const [row] = await db
    .select()
    .from(master.masterCardLevel)
    .where(eq(master.masterCardLevel.Level, level))
    .limit(1);
  return row ?? null;
}

export async function getMaxCardLevel(): Promise<number> {
  const rows = await db
    .select({ Level: master.masterCardLevel.Level })
    .from(master.masterCardLevel);
  return rows.reduce((m, r) => Math.max(m, Number(r.Level)), 0);
}

export async function getCardLevelRelease(id: string, level: number) {
  const [row] = await db
    .select()
    .from(master.masterCardLevelRelease)
    .where(
      and(
        eq(master.masterCardLevelRelease.Id, id),
        eq(master.masterCardLevelRelease.Level, level),
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function listCardLevelReleases(id: string) {
  return db
    .select()
    .from(master.masterCardLevelRelease)
    .where(eq(master.masterCardLevelRelease.Id, id))
    .orderBy(master.masterCardLevelRelease.Level);
}

export async function listCards() {
  return db.select().from(master.masterCard);
}

/** Card id -> Card.ReleaseDate (epoch ms); rows without a release date are omitted. */
export async function listCardReleaseDates(): Promise<Map<string, number>> {
  const rows = await db
    .select({ Id: master.masterCard.Id, ReleaseDate: master.masterCard.ReleaseDate })
    .from(master.masterCard);
  const dates = new Map<string, number>();
  for (const row of rows) {
    const release = Number(row.ReleaseDate ?? 0);
    if (release > 0) dates.set(String(row.Id), release);
  }
  return dates;
}

export async function getCostume(id: string) {
  const [row] = await db
    .select()
    .from(master.masterCostume)
    .where(eq(master.masterCostume.Id, id))
    .limit(1);
  return row ?? null;
}

export async function getHair(id: string) {
  const [row] = await db.select().from(master.masterHair).where(eq(master.masterHair.Id, id)).limit(1);
  return row ?? null;
}

export async function getAccessory(id: string) {
  const [row] = await db
    .select()
    .from(master.masterAccessory)
    .where(eq(master.masterAccessory.Id, id))
    .limit(1);
  return row ?? null;
}

export async function getAccessoryEnhancement(rarity: number) {
  const [row] = await db
    .select()
    .from(master.masterAccessoryEnhancement)
    .where(eq(master.masterAccessoryEnhancement.Rarity, rarity))
    .limit(1);
  return row ?? null;
}

export async function getCardRarity(rarity: number) {
  const [row] = await db
    .select()
    .from(master.masterCardRarity)
    .where(eq(master.masterCardRarity.Rarity, rarity))
    .limit(1);
  return row ?? null;
}

export async function getCardRank(rank: number) {
  const [row] = await db
    .select()
    .from(master.masterCardRank)
    .where(eq(master.masterCardRank.Rank, rank))
    .limit(1);
  return row ?? null;
}

export async function getCardSupportRelease(count: number) {
  const [row] = await db
    .select()
    .from(master.masterCardSupportRelease)
    .where(eq(master.masterCardSupportRelease.Count, count))
    .limit(1);
  return row ?? null;
}

export async function getPhotoRarityLevel(rarity: number, level: number) {
  const [row] = await db
    .select()
    .from(master.masterPhotoRarityLevel)
    .where(
      and(
        eq(master.masterPhotoRarityLevel.Rarity, rarity),
        eq(master.masterPhotoRarityLevel.Level, level),
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function listPhotoRarityLevels() {
  return db.select().from(master.masterPhotoRarityLevel);
}

/** Lowest and highest `Level` across every `PhotoRarityLevel` row; null when the
 *  master table is empty. Both bounds span all rarities, matching the Solis
 *  photo generator's clamp. */
export async function getPhotoRarityLevelRange(): Promise<{ min: number; max: number } | null> {
  const [row] = await db
    .select({
      min: sql<string | null>`min(${master.masterPhotoRarityLevel.Level})`,
      max: sql<string | null>`max(${master.masterPhotoRarityLevel.Level})`,
    })
    .from(master.masterPhotoRarityLevel);
  const min = Number(row?.min ?? 0);
  const max = Number(row?.max ?? 0);
  if (!(min > 0) || !(max >= min)) return null;
  return { min, max };
}

export async function getPhotoRetouchEnhance(groupId: string, photoLevel: number) {
  const [row] = await db
    .select()
    .from(master.masterPhotoRetouchEnhance)
    .where(
      and(
        eq(master.masterPhotoRetouchEnhance.GroupId, groupId),
        eq(master.masterPhotoRetouchEnhance.PhotoLevel, photoLevel),
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function getLiveAbility(id: string) {
  const [row] = await db
    .select()
    .from(master.masterLiveAbility)
    .where(eq(master.masterLiveAbility.Id, id))
    .limit(1);
  return row ?? null;
}

export async function getActivityAbility(id: string) {
  const [row] = await db
    .select()
    .from(master.masterActivityAbility)
    .where(eq(master.masterActivityAbility.Id, id))
    .limit(1);
  return row ?? null;
}

export async function getSkill(id: string) {
  const [row] = await db.select().from(master.masterSkill).where(eq(master.masterSkill.Id, id)).limit(1);
  return row ?? null;
}

export async function getPhotoAbility(id: string) {
  const [row] = await db
    .select()
    .from(master.masterPhotoAbility)
    .where(eq(master.masterPhotoAbility.Id, id))
    .limit(1);
  return row ?? null;
}

export async function getPhotoRecipe(id: string) {
  const [row] = await db
    .select()
    .from(master.masterPhotoRecipe)
    .where(eq(master.masterPhotoRecipe.Id, id))
    .limit(1);
  return row ?? null;
}

export async function getPhotoActivity(id: string) {
  const [row] = await db
    .select()
    .from(master.masterPhotoActivity)
    .where(eq(master.masterPhotoActivity.Id, id))
    .limit(1);
  return row ?? null;
}

export async function listPhotoActivities() {
  return db.select().from(master.masterPhotoActivity).orderBy(master.masterPhotoActivity.Order);
}

export async function getPhotoQuestMusic(id: string) {
  const [row] = await db
    .select()
    .from(master.masterPhotoQuestMusic)
    .where(eq(master.masterPhotoQuestMusic.Id, id))
    .limit(1);
  return row ?? null;
}

export async function listPhotoQuestMusics() {
  return db.select().from(master.masterPhotoQuestMusic).orderBy(master.masterPhotoQuestMusic.Order);
}

/** Solis `FindPhotoStage`: the master Stage row, else the photo-quest stage. */
export async function getPhotoStage(id: string) {
  const [row] = await db.select().from(master.masterStage).where(eq(master.masterStage.Id, id)).limit(1);
  return row ?? (await getPhotoQuestStage(id));
}

export async function getPhotoQuestStage(id: string) {
  const [row] = await db
    .select()
    .from(master.masterPhotoQuestStage)
    .where(eq(master.masterPhotoQuestStage.Id, id))
    .limit(1);
  return row ?? null;
}

export async function listPhotoQuestStages() {
  return db.select().from(master.masterPhotoQuestStage).orderBy(master.masterPhotoQuestStage.Order);
}

export async function getPhotoExpression(id: string) {
  const [row] = await db
    .select()
    .from(master.masterPhotoExpression)
    .where(eq(master.masterPhotoExpression.Id, id))
    .limit(1);
  return row ?? null;
}

export async function listPhotoExpressions() {
  return db.select().from(master.masterPhotoExpression).orderBy(master.masterPhotoExpression.Order);
}

export async function getPhotoExpressionStagePosition(stageId: string, number: number) {
  const [row] = await db
    .select()
    .from(master.masterPhotoExpressionStagePosition)
    .where(
      and(
        eq(master.masterPhotoExpressionStagePosition.StageId, stageId),
        eq(master.masterPhotoExpressionStagePosition.Number, number),
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function listPhotoExpressionStagePositions(stageId: string) {
  return db
    .select()
    .from(master.masterPhotoExpressionStagePosition)
    .where(eq(master.masterPhotoExpressionStagePosition.StageId, stageId));
}

export async function getPhotoAbilitySet(id: string) {
  const [row] = await db
    .select()
    .from(master.masterPhotoAbilitySet)
    .where(eq(master.masterPhotoAbilitySet.Id, id))
    .limit(1);
  return row ?? null;
}

export async function listPhotoAbilitySetsByRarity(rarity: number) {
  return db
    .select()
    .from(master.masterPhotoAbilitySet)
    .where(eq(master.masterPhotoAbilitySet.PhotoRarity, rarity));
}

export async function listPhotoAbilitySets() {
  return db.select().from(master.masterPhotoAbilitySet);
}

export async function getPhotoPose(id: string) {
  const [row] = await db
    .select()
    .from(master.masterPhotoPose)
    .where(eq(master.masterPhotoPose.Id, id))
    .limit(1);
  return row ?? null;
}

export async function listPhotoPoses() {
  return db.select().from(master.masterPhotoPose).orderBy(master.masterPhotoPose.Order);
}

export async function getPhotoFacial(id: string) {
  const [row] = await db
    .select()
    .from(master.masterPhotoFacial)
    .where(eq(master.masterPhotoFacial.Id, id))
    .limit(1);
  return row ?? null;
}

export async function listPhotoFacials() {
  return db.select().from(master.masterPhotoFacial).orderBy(master.masterPhotoFacial.Order);
}

export async function getPhotoAllInOne(id: string) {
  const [row] = await db
    .select()
    .from(master.masterPhotoAllInOne)
    .where(eq(master.masterPhotoAllInOne.Id, id))
    .limit(1);
  return row ?? null;
}

export async function listPhotoAllInOnes() {
  return db.select().from(master.masterPhotoAllInOne);
}

export async function getPhotoContestActivity(id: string) {
  const [row] = await db
    .select()
    .from(master.masterPhotoContestActivity)
    .where(eq(master.masterPhotoContestActivity.Id, id))
    .limit(1);
  return row ?? null;
}

export async function listPhotoContestActivities() {
  return db.select().from(master.masterPhotoContestActivity);
}

export async function getPhotoContestQuestMusic(id: string) {
  const [row] = await db
    .select()
    .from(master.masterPhotoContestQuestMusic)
    .where(eq(master.masterPhotoContestQuestMusic.Id, id))
    .limit(1);
  return row ?? null;
}

export async function listPhotoContestQuestMusics() {
  return db.select().from(master.masterPhotoContestQuestMusic);
}

export async function getPhotoContestQuestStage(id: string) {
  const [row] = await db
    .select()
    .from(master.masterPhotoContestQuestStage)
    .where(eq(master.masterPhotoContestQuestStage.Id, id))
    .limit(1);
  return row ?? null;
}

export async function listPhotoContestQuestStages() {
  return db.select().from(master.masterPhotoContestQuestStage);
}

export async function getPhotoContestSection(id: string) {
  const [row] = await db
    .select()
    .from(master.masterPhotoContestSection)
    .where(eq(master.masterPhotoContestSection.Id, id))
    .limit(1);
  return row ?? null;
}

export async function listPhotoContestSections() {
  return db.select().from(master.masterPhotoContestSection);
}

export async function getPhotoContestSectionReward(id: string) {
  const [row] = await db
    .select()
    .from(master.masterPhotoContestSectionReward)
    .where(eq(master.masterPhotoContestSectionReward.Id, id))
    .limit(1);
  return row ?? null;
}

export async function listPhotoContestSectionRewards() {
  return db.select().from(master.masterPhotoContestSectionReward);
}

export async function getQuestContestRankingSeason(id: string) {
  const [row] = await db
    .select()
    .from(master.masterQuestContestRankingSeason)
    .where(eq(master.masterQuestContestRankingSeason.Id, id))
    .limit(1);
  return row ?? null;
}

export async function listQuestContestRankingSeasons() {
  return db.select().from(master.masterQuestContestRankingSeason);
}

export async function getSetting() {
  const [row] = await db.select().from(master.masterSetting).limit(1);
  return row ?? null;
}

export async function getStory(id: string) {
  const [row] = await db.select().from(master.masterStory).where(eq(master.masterStory.Id, id)).limit(1);
  return row ?? null;
}

export async function listStories() {
  return db.select().from(master.masterStory);
}

export async function getStoryPart(id: string) {
  const [row] = await db
    .select()
    .from(master.masterStoryPart)
    .where(eq(master.masterStoryPart.Id, id))
    .limit(1);
  return row ?? null;
}

export async function getStoryEpisodeConsumption(id: string, releaseCount: number) {
  const [row] = await db
    .select()
    .from(master.masterStoryEpisodeConsumption)
    .where(
      and(
        eq(master.masterStoryEpisodeConsumption.Id, id),
        eq(master.masterStoryEpisodeConsumption.ReleaseCount, releaseCount),
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function getEventStory(id: string) {
  const [row] = await db
    .select()
    .from(master.masterEventStory)
    .where(eq(master.masterEventStory.Id, id))
    .limit(1);
  return row ?? null;
}

export async function listEventStories() {
  return db.select().from(master.masterEventStory);
}

export async function getExtraStory(id: string) {
  const [row] = await db
    .select()
    .from(master.masterExtraStory)
    .where(eq(master.masterExtraStory.Id, id))
    .limit(1);
  return row ?? null;
}

export async function listExtraStories() {
  return db.select().from(master.masterExtraStory);
}

export async function getExtraStoryPart(id: string) {
  const [row] = await db
    .select()
    .from(master.masterExtraStoryPart)
    .where(eq(master.masterExtraStoryPart.Id, id))
    .limit(1);
  return row ?? null;
}

export async function getCardEvolution(cardId: string, evolutionLevel: number) {
  const [row] = await db
    .select()
    .from(master.masterCardEvolution)
    .where(
      and(
        eq(master.masterCardEvolution.CardId, cardId),
        eq(master.masterCardEvolution.EvolutionLevel, evolutionLevel),
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function listCardEvolutions() {
  return db.select().from(master.masterCardEvolution);
}

export async function getCardEvolutionLevel(groupId: string, level: number) {
  const [row] = await db
    .select()
    .from(master.masterCardEvolutionLevel)
    .where(
      and(
        eq(master.masterCardEvolutionLevel.GroupId, groupId),
        eq(master.masterCardEvolutionLevel.Level, level),
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function getCardEvolutionLevelRelease(groupId: string, level: number) {
  const [row] = await db
    .select()
    .from(master.masterCardEvolutionLevelRelease)
    .where(
      and(
        eq(master.masterCardEvolutionLevelRelease.GroupId, groupId),
        eq(master.masterCardEvolutionLevelRelease.Level, level),
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function listCardEvolutionLevelReleases(groupId: string) {
  return db
    .select()
    .from(master.masterCardEvolutionLevelRelease)
    .where(eq(master.masterCardEvolutionLevelRelease.GroupId, groupId))
    .orderBy(master.masterCardEvolutionLevelRelease.Level);
}

export async function listCardEvolutionMessages(cardId: string, evolutionLevel: number) {
  return db
    .select()
    .from(master.masterCardEvolutionMessage)
    .where(
      and(
        eq(master.masterCardEvolutionMessage.CardId, cardId),
        eq(master.masterCardEvolutionMessage.EvolutionLevel, evolutionLevel),
      ),
    );
}

export async function getLoveLevel(loveId: string, level: number) {
  const [row] = await db
    .select()
    .from(master.masterLoveLevel)
    .where(
      and(
        eq(master.masterLoveLevel.LoveId, loveId),
        eq(master.masterLoveLevel.Level, level),
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function listLoveLevels(loveId: string) {
  return db
    .select()
    .from(master.masterLoveLevel)
    .where(eq(master.masterLoveLevel.LoveId, loveId));
}

export async function getLoveStoryEpisode(id: string) {
  const [row] = await db
    .select()
    .from(master.masterLoveStoryEpisode)
    .where(eq(master.masterLoveStoryEpisode.Id, id))
    .limit(1);
  return row ?? null;
}

export async function listLoveStoryEpisodes(loveId: string) {
  return db
    .select()
    .from(master.masterLoveStoryEpisode)
    .where(eq(master.masterLoveStoryEpisode.LoveId, loveId));
}

export async function getLoveColor(loveId: string) {
  const [row] = await db
    .select()
    .from(master.masterLoveColor)
    .where(eq(master.masterLoveColor.LoveId, loveId))
    .limit(1);
  return row ?? null;
}

export async function listLoveHomeActions(loveId: string) {
  return db
    .select()
    .from(master.masterLoveHomeAction)
    .where(eq(master.masterLoveHomeAction.LoveId, loveId));
}

export async function listLoveIds(): Promise<string[]> {
  const rows = await db
    .selectDistinct({ LoveId: master.masterLoveStoryEpisode.LoveId })
    .from(master.masterLoveStoryEpisode);
  return rows.map((r) => r.LoveId).filter((v): v is string => typeof v === 'string');
}

export async function getCharacter(id: string) {
  const [row] = await db
    .select()
    .from(master.masterCharacter)
    .where(eq(master.masterCharacter.Id, id))
    .limit(1);
  return row ?? null;
}

export async function listCharacters() {
  return db.select().from(master.masterCharacter);
}

export async function getGachaExchange(id: string) {
  const [row] = await db
    .select()
    .from(master.masterGachaExchange)
    .where(eq(master.masterGachaExchange.Id, id))
    .limit(1);
  return row ?? null;
}

export async function listGachaExchanges(gachaId: string) {
  return db
    .select()
    .from(master.masterGachaExchange)
    .where(eq(master.masterGachaExchange.GachaId, gachaId));
}

export async function listGachaStamps(groupId: string) {
  return db
    .select()
    .from(master.masterGachaStamp)
    .where(eq(master.masterGachaStamp.GroupId, groupId));
}

export async function getGachaStampSheet(groupId: string, sheetNumber: number) {
  const [row] = await db
    .select()
    .from(master.masterGachaStampSheet)
    .where(
      and(
        eq(master.masterGachaStampSheet.GroupId, groupId),
        eq(master.masterGachaStampSheet.SheetNumber, sheetNumber),
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function getGachaStampSheetGroup(groupId: string) {
  const [row] = await db
    .select()
    .from(master.masterGachaStampSheetGroup)
    .where(eq(master.masterGachaStampSheetGroup.GroupId, groupId))
    .limit(1);
  return row ?? null;
}

export async function getBoxGacha(id: string) {
  const [row] = await db
    .select()
    .from(master.masterBoxGacha)
    .where(eq(master.masterBoxGacha.Id, id))
    .limit(1);
  return row ?? null;
}

export async function listBoxGachas() {
  return db.select().from(master.masterBoxGacha);
}

export async function getBoxGachaGroup(id: string) {
  const [row] = await db
    .select()
    .from(master.masterBoxGachaGroup)
    .where(eq(master.masterBoxGachaGroup.Id, id))
    .limit(1);
  return row ?? null;
}

export async function listMarathonBoxGachaSettings(marathonId: string) {
  return db
    .select()
    .from(master.masterMarathonBoxGachaSetting)
    .where(eq(master.masterMarathonBoxGachaSetting.MarathonId, marathonId));
}

export async function getShowcaseFrame(id: string) {
  const [row] = await db
    .select()
    .from(master.masterShowcaseFrame)
    .where(eq(master.masterShowcaseFrame.Id, id))
    .limit(1);
  return row ?? null;
}

export async function listShowcaseFrames() {
  return db.select().from(master.masterShowcaseFrame);
}

export async function listShowcaseHashtags() {
  return db.select().from(master.masterShowcaseHashtag);
}

export async function listShowcaseMusics() {
  return db.select().from(master.masterShowcaseMusic);
}

export async function listMusics() {
  return db.select().from(master.masterMusic);
}

export async function listShowcaseMusicFilters() {
  return db.select().from(master.masterShowcaseMusicFilter);
}

export async function getShowcaseSetting() {
  const [row] = await db.select().from(master.masterShowcaseSetting).limit(1);
  return row ?? null;
}

export async function listShowcaseToys() {
  return db.select().from(master.masterShowcaseToy);
}

export async function listShowcaseToyCategories() {
  return db.select().from(master.masterShowcaseToyCategory);
}

export async function listShowcaseToyShopFilters() {
  return db.select().from(master.masterShowcaseToyShopFilter);
}

export async function getExcursionPlace(id: string) {
  const rows = await db.select().from(master.masterExcursionPlace).where(eq(master.masterExcursionPlace.Id, id)).limit(1);
  return rows[0] ?? null;
}

export async function getExcursionPlaceSetting(characterId: string, placeId: string) {
  const [row] = await db
    .select()
    .from(master.masterExcursionPlaceSetting)
    .where(
      and(
        eq(master.masterExcursionPlaceSetting.CharacterId, characterId),
        eq(master.masterExcursionPlaceSetting.ExcursionPlaceId, placeId),
      ),
    )
    .limit(1);
  return row ?? null;
}

/** All places a character can visit, in master (`ExcursionPlaceId`) order. */
export async function listExcursionPlaceSettingsByCharacter(characterId: string) {
  return db
    .select()
    .from(master.masterExcursionPlaceSetting)
    .where(eq(master.masterExcursionPlaceSetting.CharacterId, characterId))
    .orderBy(asc(master.masterExcursionPlaceSetting.ExcursionPlaceId));
}

export async function getExcursionGazeReaction(
  characterId: string,
  placeId: string,
  number: number,
) {
  const [row] = await db
    .select()
    .from(master.masterExcursionGazeReaction)
    .where(
      and(
        eq(master.masterExcursionGazeReaction.CharacterId, characterId),
        eq(master.masterExcursionGazeReaction.ExcursionPlaceId, placeId),
        eq(master.masterExcursionGazeReaction.Number, number),
      ),
    )
    .limit(1);
  return row ?? null;
}

/** Company-enjoy items for a character, highest `ObtainPoint` first. */
export async function listCompanyEnjoyObtainPointItemSettingsByCharacter(characterId: string) {
  return db
    .select()
    .from(master.masterCompanyEnjoyObtainPointItemSetting)
    .where(eq(master.masterCompanyEnjoyObtainPointItemSetting.CharacterId, characterId))
    .orderBy(
      desc(master.masterCompanyEnjoyObtainPointItemSetting.ObtainPoint),
      asc(master.masterCompanyEnjoyObtainPointItemSetting.ItemId),
    );
}

export async function listMessageGroups() {
  return db.select().from(master.masterMessageGroup);
}

export async function getMessageGroup(id: string) {
  const [row] = await db
    .select()
    .from(master.masterMessageGroup)
    .where(eq(master.masterMessageGroup.Id, id))
    .limit(1);
  return row ?? null;
}

export async function listMessages() {
  return db.select().from(master.masterMessage);
}

export async function getMessage(id: string) {
  const [row] = await db
    .select()
    .from(master.masterMessage)
    .where(eq(master.masterMessage.Id, id))
    .limit(1);
  return row ?? null;
}

export async function listTelephones() {
  return db.select().from(master.masterTelephone);
}

export async function getTelephone(id: string) {
  const [row] = await db
    .select()
    .from(master.masterTelephone)
    .where(eq(master.masterTelephone.Id, id))
    .limit(1);
  return row ?? null;
}

export async function listItemsByType(type: number) {
  return db.select().from(master.masterItem).where(eq(master.masterItem.Type, type));
}

/** Bulk card lookup (Solis `opmaster.FindLiveCards`). */
export async function listCardsByIds(ids: string[]) {
  if (ids.length === 0) return [];
  return db.select().from(master.masterCard).where(inArray(master.masterCard.Id, ids));
}

export async function listCardLevels() {
  return db
    .select()
    .from(master.masterCardLevel)
    .orderBy(master.masterCardLevel.Level);
}

export async function getManagerLevel(level: number) {
  const [row] = await db
    .select()
    .from(master.masterManagerLevel)
    .where(eq(master.masterManagerLevel.Level, level))
    .limit(1);
  return row ?? null;
}

export async function getMaxManagerLevel() {
  const [row] = await db
    .select()
    .from(master.masterManagerLevel)
    .orderBy(desc(master.masterManagerLevel.Level))
    .limit(1);
  return row ?? null;
}

export async function listCharacterActivityLevels() {
  return db.select().from(master.masterCharacterActivityLevel);
}

export async function listLiveAbilities(ids: string[]) {
  if (ids.length === 0) return [];
  return db.select().from(master.masterLiveAbility).where(inArray(master.masterLiveAbility.Id, ids));
}

export async function listSkills(ids: string[]) {
  if (ids.length === 0) return [];
  return db.select().from(master.masterSkill).where(inArray(master.masterSkill.Id, ids));
}

export async function listPhotoAbilities(ids: string[]) {
  if (ids.length === 0) return [];
  return db.select().from(master.masterPhotoAbility).where(inArray(master.masterPhotoAbility.Id, ids));
}

export async function getQuest(id: string) {
  const [row] = await db
    .select()
    .from(master.masterQuest)
    .where(eq(master.masterQuest.Id, id))
    .limit(1);
  return row ?? null;
}

export async function listQuests() {
  return db.select().from(master.masterQuest);
}

export async function listQuestsByArea(areaId: string) {
  return db
    .select()
    .from(master.masterQuest)
    .where(eq(master.masterQuest.AreaId, areaId))
    .orderBy(master.masterQuest.Order, master.masterQuest.Id);
}

export async function getArea(id: string) {
  const [row] = await db
    .select()
    .from(master.masterArea)
    .where(eq(master.masterArea.Id, id))
    .limit(1);
  return row ?? null;
}

export async function listAreas() {
  return db.select().from(master.masterArea).orderBy(master.masterArea.Order, master.masterArea.Id);
}

export async function getAreaGroup(id: string) {
  const [row] = await db
    .select()
    .from(master.masterAreaGroup)
    .where(eq(master.masterAreaGroup.Id, id))
    .limit(1);
  return row ?? null;
}

export async function listAreaGroups() {
  return db
    .select()
    .from(master.masterAreaGroup)
    .orderBy(master.masterAreaGroup.Order, master.masterAreaGroup.Id);
}

export async function getMusic(id: string) {
  const [row] = await db
    .select()
    .from(master.masterMusic)
    .where(eq(master.masterMusic.Id, id))
    .limit(1);
  return row ?? null;
}

/** Chart patterns are keyed by their chart id (e.g. "chart-hsm-006-001"). */
export async function listMusicChartPatterns(chartId: string) {
  return db
    .select()
    .from(master.masterMusicChartPattern)
    .where(eq(master.masterMusicChartPattern.Id, chartId))
    .orderBy(master.masterMusicChartPattern.Number);
}

export async function listMusicMasteryLevels() {
  return db
    .select()
    .from(master.masterMusicMasteryLevel)
    .orderBy(master.masterMusicMasteryLevel.Level);
}

export async function listMusicMasteryRewards(musicId: string) {
  return db
    .select()
    .from(master.masterMusicMasteryReward)
    .where(eq(master.masterMusicMasteryReward.MusicId, musicId));
}

export async function listMusicMasteryRewardLevels(rewardSetId: string) {
  return db
    .select()
    .from(master.masterMusicMasteryRewardSet)
    .where(eq(master.masterMusicMasteryRewardSet.Id, rewardSetId))
    .orderBy(master.masterMusicMasteryRewardSet.Level);
}

export async function getSkillEfficacy(id: string) {
  const [row] = await db
    .select()
    .from(master.masterSkillEfficacy)
    .where(eq(master.masterSkillEfficacy.Id, id))
    .limit(1);
  return row ?? null;
}

export async function listSkillEfficacies(ids: string[]) {
  if (ids.length === 0) return [];
  return db.select().from(master.masterSkillEfficacy).where(inArray(master.masterSkillEfficacy.Id, ids));
}

/**
 * Destination status definitions encode their master caps in the efficacy id
 * (`ef-<statusName>-...`). Mirrors Solis `opmaster.FindLiveStatusEfficacy`.
 */
export async function findLiveStatusEfficacy(statusName: string) {
  const [row] = await db
    .select()
    .from(master.masterSkillEfficacy)
    .where(like(master.masterSkillEfficacy.Id, `ef-${statusName}-%`))
    .limit(1);
  return row ?? null;
}

export async function getSkillTrigger(id: string) {
  const [row] = await db
    .select()
    .from(master.masterSkillTrigger)
    .where(eq(master.masterSkillTrigger.Id, id))
    .limit(1);
  return row ?? null;
}

export async function listSkillTriggers(ids: string[]) {
  if (ids.length === 0) return [];
  return db.select().from(master.masterSkillTrigger).where(inArray(master.masterSkillTrigger.Id, ids));
}

export async function getSkillTarget(id: string) {
  const [row] = await db
    .select()
    .from(master.masterSkillTarget)
    .where(eq(master.masterSkillTarget.Id, id))
    .limit(1);
  return row ?? null;
}

export async function listSkillTargets(ids: string[]) {
  if (ids.length === 0) return [];
  return db.select().from(master.masterSkillTarget).where(inArray(master.masterSkillTarget.Id, ids));
}

export async function getQuestStaminaConsumption(remainStaminaRatioPercent: number) {
  const [row] = await db
    .select()
    .from(master.masterQuestStaminaConsumption)
    .where(
      eq(
        master.masterQuestStaminaConsumption.RemainStaminaRatioPercent,
        remainStaminaRatioPercent,
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function listQuestStaminaConsumptions() {
  return db
    .select()
    .from(master.masterQuestStaminaConsumption)
    .orderBy(master.masterQuestStaminaConsumption.RemainStaminaRatioPercent);
}

export async function listQuestAudienceAdvantages(id: string) {
  return db
    .select()
    .from(master.masterQuestAudienceAdvantage)
    .where(eq(master.masterQuestAudienceAdvantage.Id, id))
    .orderBy(master.masterQuestAudienceAdvantage.AudienceAmount);
}

export async function getQuestCharacterAdvantage(id: string) {
  const [row] = await db
    .select()
    .from(master.masterQuestCharacterAdvantage)
    .where(eq(master.masterQuestCharacterAdvantage.Id, id))
    .limit(1);
  return row ?? null;
}

export async function listQuestCharacterAdvantages() {
  return db.select().from(master.masterQuestCharacterAdvantage);
}

export async function listComboAdvantages(comboAdvantageId?: string) {
  if (comboAdvantageId) {
    return db
      .select()
      .from(master.masterComboAdvantage)
      .where(eq(master.masterComboAdvantage.Id, comboAdvantageId))
      .orderBy(master.masterComboAdvantage.ComboCount);
  }
  return db
    .select()
    .from(master.masterComboAdvantage)
    .orderBy(master.masterComboAdvantage.ComboCount);
}

export async function getQuestPressure(id: string) {
  const [row] = await db
    .select()
    .from(master.masterQuestPressure)
    .where(eq(master.masterQuestPressure.Id, id))
    .limit(1);
  return row ?? null;
}

export async function getLiveBonus(id: string) {
  const [row] = await db
    .select()
    .from(master.masterLiveBonus)
    .where(eq(master.masterLiveBonus.Id, id))
    .limit(1);
  return row ?? null;
}

export async function listLiveBonuses(ids: string[]) {
  if (ids.length === 0) return [];
  return db.select().from(master.masterLiveBonus).where(inArray(master.masterLiveBonus.Id, ids));
}

export async function getLiveBonusGroup(groupId: string) {
  const [row] = await db
    .select()
    .from(master.masterLiveBonusGroup)
    .where(eq(master.masterLiveBonusGroup.GroupId, groupId))
    .limit(1);
  return row ?? null;
}

export async function getPhotoAbilityTarget(id: string) {
  const [row] = await db
    .select()
    .from(master.masterPhotoAbilityTarget)
    .where(eq(master.masterPhotoAbilityTarget.Id, id))
    .limit(1);
  return row ?? null;
}

export async function listPhotoAbilityTargets(ids: string[]) {
  if (ids.length === 0) return [];
  return db
    .select()
    .from(master.masterPhotoAbilityTarget)
    .where(inArray(master.masterPhotoAbilityTarget.Id, ids));
}

export async function getStage(id: string) {
  const [row] = await db
    .select()
    .from(master.masterStage)
    .where(eq(master.masterStage.Id, id))
    .limit(1);
  return row ?? null;
}

export async function listStages() {
  return db.select().from(master.masterStage).orderBy(master.masterStage.Order, master.masterStage.Id);
}

export async function getStatusEffectName(statusEffectType: number) {
  const [row] = await db
    .select()
    .from(master.masterStatusEffectName)
    .where(eq(master.masterStatusEffectName.StatusEffectType, statusEffectType))
    .limit(1);
  return row ?? null;
}

export async function listStatusEffectNames() {
  return db
    .select()
    .from(master.masterStatusEffectName)
    .orderBy(master.masterStatusEffectName.StatusEffectType);
}

export async function getCondition(id: string) {
  const [row] = await db.select().from(master.masterCondition).where(eq(master.masterCondition.Id, id)).limit(1);
  return row ?? null;
}

export async function listConditions(ids: string[]) {
  if (ids.length === 0) return [];
  return db.select().from(master.masterCondition).where(inArray(master.masterCondition.Id, ids));
}

export async function getFunctionLock(type: number) {
  const [row] = await db.select().from(master.masterFunctionLock).where(eq(master.masterFunctionLock.Type, type)).limit(1);
  return row ?? null;
}

export function listHierarchyDetailGrades() {
  return db.select().from(master.masterHierarchyDetailGrade);
}

export function listHierarchyRewards() {
  return db.select().from(master.masterHierarchyReward);
}

export function listHierarchyDivisionRewards() {
  return db.select().from(master.masterHierarchyDivisionReward);
}

export { master };
