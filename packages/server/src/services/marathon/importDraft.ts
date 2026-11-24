/**
 * Derivation of the event-level marathon draft fields from master data.
 *
 * `plugin.importFromMaster` fetches the master rows (database access) and hands
 * them to `deriveMarathonDraft`, which is pure so the naming rules can be
 * unit-tested without a database. The rules were checked against the real
 * master data for `marathon-22-0526` (whose checked-in catalogue is the
 * reference) and `mini-marathon-raid-23-1226`.
 */
import type { MarathonDraft } from './plugin.ts';

/** Event-level defaults matching the checked-in `marathon-22-0526` catalogue. */
export const IMPORT_INITIAL_STAMINA = 600;
export const IMPORT_STAMINA_RECOVERY_MINUTES = 5;
export const IMPORT_ORDER = 1;

/** `Solis.Common.Proto.MarathonType` raid value; normal marathons are 1. */
const MARATHON_TYPE_NORMAL = 1;
const MARATHON_TYPE_RAID = 2;

/** Trailing `NN-NNNN` date suffix shared by every marathon id, e.g. `23-1226`. */
const DATE_SUFFIX = /(\d{2}-\d{4})$/;

/** The trailing `NN-NNNN` date suffix of a marathon id, or '' when it has none. */
export function marathonDateSuffix(eventId: string): string {
  const match = DATE_SUFFIX.exec(eventId);
  return match?.[1] ?? '';
}

/** Marathon id without its date suffix: `mini-marathon-raid-23-1226` → `mini-marathon-raid`. */
export function marathonIdStem(eventId: string): string {
  const suffix = marathonDateSuffix(eventId);
  return suffix === '' ? eventId : eventId.slice(0, -(suffix.length + 1));
}

/**
 * `item-<family>_<kind>-<suffix>` candidate ids, most specific family first.
 * Item families in master data are the marathon id stem (`mini-marathon-raid`),
 * `marathon` or `raid`; the stem is listed first so a raid event resolves its
 * own `item-mini-marathon-raid_stamina_recovery-23-1226` rather than a normal
 * marathon item.
 */
function itemIdCandidates(eventId: string, kind: string): string[] {
  const suffix = marathonDateSuffix(eventId);
  if (suffix === '') return [];
  const families = [marathonIdStem(eventId), 'marathon', 'raid', 'mini-marathon-raid'];
  return [...new Set(families.filter((family) => family !== '').map((family) => `item-${family}_${kind}-${suffix}`))];
}

/** Candidate `master_Item` ids for the stamina recovery item of `eventId`. */
export function staminaRecoveryItemCandidates(eventId: string): string[] {
  return itemIdCandidates(eventId, 'stamina_recovery');
}

/** Candidate `master_Item` ids for the quest unlock item of `eventId`. */
export function questUnlockItemCandidates(eventId: string): string[] {
  return itemIdCandidates(eventId, 'quest_unlock');
}

/**
 * Master rows the derivation reads. Every entry is already resolved to the
 * value the draft needs, so the derivation itself does no lookups.
 */
export interface MarathonDraftLookups {
  /** A `master_EventStory` row has `AssetId` `event-<id>`. */
  eventStoryAssetIdExists: boolean;
  /** The `master_EventMission` row with id `event-<id>`, when it exists. */
  eventMission: { name: string } | null;
  /** `master_RaidQuest.Name` for the marathon's raid quest, when it has one. */
  raidQuestName: string | null;
  /** `master_BoxGacha.BoxGachaGroupId` of the marathon's first box gacha setting, or ''. */
  boxGachaGroupId: string;
  /** Candidate item ids that exist in `master_Item` (see the candidate helpers). */
  existingItemIds: readonly string[];
}

function firstNonEmpty(...values: (string | null | undefined)[]): string {
  for (const value of values) {
    if (typeof value === 'string' && value !== '') return value;
  }
  return '';
}

/** Event-level draft for `eventId`, derived from `lookups`; no DB access here. */
export function deriveMarathonDraft(eventId: string, lookups: MarathonDraftLookups): MarathonDraft {
  const eventMissionId = `event-${eventId}`;
  const existingItems = new Set(lookups.existingItemIds);
  const firstExistingItem = (candidates: readonly string[]): string =>
    candidates.find((id) => existingItems.has(id)) ?? '';
  const hasEventAsset =
    lookups.eventStoryAssetIdExists || lookups.eventMission !== null;

  return {
    id: eventId,
    name: firstNonEmpty(lookups.raidQuestName, lookups.eventMission?.name, eventId),
    type: eventId.includes('-raid-') ? MARATHON_TYPE_RAID : MARATHON_TYPE_NORMAL,
    assetId: hasEventAsset ? eventMissionId : '',
    // The banner asset has no master table of its own; follow the asset naming
    // pattern from the checked-in catalogue whenever the event asset exists.
    bannerAssetId: hasEventAsset ? `img_banner_l_${eventMissionId}` : '',
    boxGachaGroupId: lookups.boxGachaGroupId,
    initialStamina: IMPORT_INITIAL_STAMINA,
    staminaRecoveryMinutes: IMPORT_STAMINA_RECOVERY_MINUTES,
    staminaRecoveryItemId: firstExistingItem(staminaRecoveryItemCandidates(eventId)),
    questUnlockItemId: firstExistingItem(questUnlockItemCandidates(eventId)),
    eventMissionId: lookups.eventMission === null ? '' : eventMissionId,
    order: IMPORT_ORDER,
  };
}
