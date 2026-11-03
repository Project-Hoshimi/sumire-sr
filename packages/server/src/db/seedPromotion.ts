// Seed the Activity-promotion master slice added by migration
// 0023_activity_promotion.sql.
//
// Sources:
//  * phaseA2/out/structured/{ActivityPromotion,ActivityPerformance,
//    CharacterActivityLevel,Costume,Hair,Setting}.json — the harvested master.
//  * Solis `internal/makino/user/catalogdata/god_activity.yaml` for the
//    per-promotion timing/economy profile. The retail master does not carry
//    these columns (they live in the Solis activity catalog), so they are
//    overlaid here instead of re-deriving them.
//
// Only the affected tables/columns are written; the rest of the master data is
// left untouched (do NOT run db:seed-master for this slice).
//
// Usage: node src/db/seedPromotion.ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { eq, sql } from 'drizzle-orm';
import { db } from './client.ts';
import { DATA_DIR } from '../config.ts';
import {
  masterActivityPerformance,
  masterActivityPromotion,
  masterCharacterActivityLevel,
  masterCostume,
  masterHair,
  masterSetting,
} from './masterSchema.ts';

const STRUCTURED_DIR =
  process.env.MASTER_STRUCTURED_DIR ??
  join(DATA_DIR, 'phaseA2', 'out', 'structured');

type Row = Record<string, unknown>;

function rows(type: string): Row[] {
  const raw = JSON.parse(readFileSync(join(STRUCTURED_DIR, `${type}.json`), 'utf8'));
  return Array.isArray(raw) ? (raw as Row[]) : [];
}

// Solis catalogdata/god_activity.yaml (promotions block).
const PROMOTION_PROFILES: Record<
  string,
  {
    ActivityPerformanceId: string;
    PromotionLevel: number;
    RequiredStamina: number;
    StepConsumptionStamina: number;
    StepRewardGold: number;
    StepRewardCardEnhanceItem: number;
    MultiStepRewardId: string;
    MaxFanAmount: number;
    SubGenre: string;
  }
> = {
  'act-pro-01': {
    ActivityPerformanceId: 'popup',
    PromotionLevel: 65,
    RequiredStamina: 1,
    StepConsumptionStamina: 1,
    StepRewardGold: 470,
    StepRewardCardEnhanceItem: 531,
    MultiStepRewardId: 'rd-act-pro-01-65',
    MaxFanAmount: 405000,
    SubGenre: 'popup',
  },
  'act-pro-02': {
    ActivityPerformanceId: 'cm',
    PromotionLevel: 60,
    RequiredStamina: 1,
    StepConsumptionStamina: 1,
    StepRewardGold: 471,
    StepRewardCardEnhanceItem: 534,
    MultiStepRewardId: 'rd-act-pro-02-60',
    MaxFanAmount: 405000,
    SubGenre: 'cm',
  },
  'act-pro-03': {
    ActivityPerformanceId: 'public-radio',
    PromotionLevel: 60,
    RequiredStamina: 1,
    StepConsumptionStamina: 1,
    StepRewardGold: 471,
    StepRewardCardEnhanceItem: 534,
    MultiStepRewardId: 'rd-act-pro-03-60',
    MaxFanAmount: 405000,
    SubGenre: 'public-radio',
  },
};

function columnValues(row: Row, columns: string[]): Row {
  const out: Row = {};
  for (const c of columns) out[c] = row[c] ?? null;
  return out;
}

async function main() {
  await db.transaction(async (tx) => {
    // Promotions: harvested presentation data + Solis catalog profile.
    const promotions = rows('ActivityPromotion').map((promo) => {
      const id = String(promo.Id);
      const profile = PROMOTION_PROFILES[id];
      if (!profile) throw new Error(`missing promotion catalog profile for ${id}`);
      return {
        Id: id,
        Name: (promo.Name as string | null) ?? null,
        ViewConditionId: (promo.ViewConditionId as string | null) ?? null,
        UnlockConditionId: (promo.UnlockConditionId as string | null) ?? null,
        Order: (promo.Order as number | null) ?? null,
        Levels: (promo.Levels as unknown) ?? null,
        ...profile,
      };
    });
    await tx.execute(sql`delete from ${masterActivityPromotion}`);
    if (promotions.length) await tx.insert(masterActivityPromotion).values(promotions);

    const performances = rows('ActivityPerformance').map((row) =>
      columnValues(row, [
        'Id',
        'CostumeTypeIds',
        'ForceCostumeTypeId',
        'FieldId',
        'ExistBackground',
        'ExistForeground',
        'BackgroundTopColorCode',
        'BackgroundBottomColorCode',
        'FieldSpineNumber',
        'ExistProp',
      ]),
    );
    await tx.execute(sql`delete from ${masterActivityPerformance}`);
    if (performances.length) {
      await tx
        .insert(masterActivityPerformance)
        .values(performances as (typeof masterActivityPerformance.$inferInsert)[]);
    }

    const levels = rows('CharacterActivityLevel').map((row) =>
      columnValues(row, ['Level', 'RequiredExp', 'MaxStamina', 'BaseActivityPoint']),
    );
    await tx.execute(sql`delete from ${masterCharacterActivityLevel}`);
    if (levels.length) {
      await tx
        .insert(masterCharacterActivityLevel)
        .values(levels as (typeof masterCharacterActivityLevel.$inferInsert)[]);
    }

    for (const row of rows('Costume')) {
      await tx
        .update(masterCostume)
        .set({ CostumeTypeId: (row.CostumeTypeId as string | null) ?? null })
        .where(eq(masterCostume.Id, String(row.Id)));
    }
    for (const row of rows('Hair')) {
      await tx
        .update(masterHair)
        .set({
          WearableCostumeIds: (row.WearableCostumeIds as unknown) ?? null,
          NotWearableCostumeIds: (row.NotWearableCostumeIds as unknown) ?? null,
        })
        .where(eq(masterHair.Id, String(row.Id)));
    }

    const [setting] = rows('Setting');
    if (setting) {
      await tx
        .update(masterSetting)
        .set({
          SecondsPerActivityPromotionStep: (setting.SecondsPerActivityPromotionStep as number | null) ?? null,
          CharacterSecondToRecover: (setting.CharacterSecondToRecover as number | null) ?? null,
          LiveLightFanAmountWeightPermil: (setting.LiveLightFanAmountWeightPermil as number | null) ?? null,
          LiveMiddleFanAmountWeightPermil: (setting.LiveMiddleFanAmountWeightPermil as number | null) ?? null,
          LiveHeavyFanAmountWeightPermil: (setting.LiveHeavyFanAmountWeightPermil as number | null) ?? null,
        })
        .where(eq(masterSetting.Id, String(setting.Id)));
    }

    console.log(
      `seeded activity promotion slice: ${promotions.length} promotions, ${performances.length} performances, ${levels.length} character activity levels`,
    );
  });
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
