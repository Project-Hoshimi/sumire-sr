// Event-level marathon draft derivation tests. Pure unit tests: the catalogue
// JSON ships with the server and the master-row lookups are plain values, so no
// database or game master data is required.
//
//   node --test src/services/marathon/importDraft.test.ts
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';
import {
  deriveMarathonDraft,
  marathonDateSuffix,
  marathonIdStem,
  questUnlockItemCandidates,
  staminaRecoveryItemCandidates,
  type MarathonDraftLookups,
} from './importDraft.ts';

/** Empty lookups: an event id that has no master rows at all. */
function noLookups(overrides: Partial<MarathonDraftLookups> = {}): MarathonDraftLookups {
  return {
    eventStoryAssetIdExists: false,
    eventMission: null,
    raidQuestName: null,
    boxGachaGroupId: '',
    existingItemIds: [],
    ...overrides,
  };
}

const CATALOG_URL = new URL('./catalog/marathon-22-0526.json', import.meta.url);
/** The checked-in catalogue is private game data and is not in the public export. */
const MISSING_CATALOG =
  !existsSync(CATALOG_URL) && 'catalog/marathon-22-0526.json is private data, not in this checkout';

test('marathon-22-0526 derives the checked-in catalogue event fields', { skip: MISSING_CATALOG }, () => {
  const catalog = JSON.parse(readFileSync(CATALOG_URL, 'utf8')) as Record<string, unknown>;

  const draft = deriveMarathonDraft(
    'marathon-22-0526',
    noLookups({
      // master_EventStory `st-eve-2206-marathon` has AssetId event-marathon-22-0526
      eventStoryAssetIdExists: true,
      // master_EventMission event-marathon-22-0526 is named イベントミッション
      eventMission: { name: 'イベントミッション' },
      boxGachaGroupId: 'box_gacha_group-22-0526-001',
      existingItemIds: [
        'item-marathon_stamina_recovery-22-0526',
        'item-marathon_quest_unlock-22-0526',
      ],
    }),
  );

  const eventLevelFields = [
    'id',
    'type',
    'assetId',
    'bannerAssetId',
    'boxGachaGroupId',
    'initialStamina',
    'staminaRecoveryMinutes',
    'staminaRecoveryItemId',
    'questUnlockItemId',
    'eventMissionId',
    'order',
  ] as const;
  for (const field of eventLevelFields) {
    assert.deepEqual(draft[field], catalog[field], `field ${field}`);
  }
  // The catalogue authors the event title; master data only has the mission
  // label, so the derived name is deliberately different.
  assert.equal(draft.name, 'イベントミッション');
  assert.notEqual(draft.name, catalog.name);
});

test('mini-marathon-raid-23-1226 derives a raid draft from mission/box/item rows', () => {
  const draft = deriveMarathonDraft(
    'mini-marathon-raid-23-1226',
    noLookups({
      // No EventStory row for this event, but the EventMission exists.
      eventMission: { name: 'イベントミッション' },
      raidQuestName: '協力ライブ',
      boxGachaGroupId: 'box_gacha_group-23-1226-001',
      existingItemIds: [
        'item-mini-marathon-raid_stamina_recovery-23-1226',
        'item-mini-marathon-raid_quest_unlock-23-1226',
        'item-mini-marathon-raid_raid-stamina_recovery-23-1226',
      ],
    }),
  );

  assert.deepEqual(draft, {
    id: 'mini-marathon-raid-23-1226',
    name: '協力ライブ',
    type: 2,
    assetId: 'event-mini-marathon-raid-23-1226',
    bannerAssetId: 'img_banner_l_event-mini-marathon-raid-23-1226',
    boxGachaGroupId: 'box_gacha_group-23-1226-001',
    initialStamina: 600,
    staminaRecoveryMinutes: 5,
    staminaRecoveryItemId: 'item-mini-marathon-raid_stamina_recovery-23-1226',
    questUnlockItemId: 'item-mini-marathon-raid_quest_unlock-23-1226',
    eventMissionId: 'event-mini-marathon-raid-23-1226',
    order: 1,
  });
});

test('an event with no master rows falls back to the id and blank assets', () => {
  const draft = deriveMarathonDraft('marathon-30-0101', noLookups());

  assert.deepEqual(draft, {
    id: 'marathon-30-0101',
    name: 'marathon-30-0101',
    type: 1,
    assetId: '',
    bannerAssetId: '',
    boxGachaGroupId: '',
    initialStamina: 600,
    staminaRecoveryMinutes: 5,
    staminaRecoveryItemId: '',
    questUnlockItemId: '',
    eventMissionId: '',
    order: 1,
  });
});

test('raid quest name wins over the generic EventMission name', () => {
  const raidQuestName = '協力ライブ';

  const missionNamed = deriveMarathonDraft(
    'marathon-raid-24-0827',
    noLookups({ eventMission: { name: 'イベントミッション' }, raidQuestName }),
  );
  assert.equal(missionNamed.name, raidQuestName);

  const noRaid = deriveMarathonDraft(
    'marathon-raid-24-0827',
    noLookups({ eventMission: { name: 'イベントミッション' } }),
  );
  assert.equal(noRaid.name, 'イベントミッション');

  const missionUnnamed = deriveMarathonDraft(
    'marathon-raid-24-0827',
    noLookups({ eventMission: { name: '' }, raidQuestName }),
  );
  assert.equal(missionUnnamed.name, raidQuestName);

  const noMission = deriveMarathonDraft(
    'marathon-raid-24-0827',
    noLookups({ raidQuestName }),
  );
  assert.equal(noMission.name, raidQuestName);
  // No EventMission row means no event mission id, but the raid story asset can
  // still exist on its own.
  assert.equal(noMission.eventMissionId, '');
  assert.equal(noMission.assetId, '');
});

test('an EventStory asset alone marks the event asset and banner', () => {
  const draft = deriveMarathonDraft(
    'mini-marathon-22-0413',
    noLookups({ eventStoryAssetIdExists: true }),
  );

  assert.equal(draft.assetId, 'event-mini-marathon-22-0413');
  assert.equal(draft.bannerAssetId, 'img_banner_l_event-mini-marathon-22-0413');
  assert.equal(draft.eventMissionId, '');
  assert.equal(draft.type, 1);
});

test('date suffix and stem split the trailing NN-NNNN date', () => {
  assert.equal(marathonDateSuffix('marathon-22-0526'), '22-0526');
  assert.equal(marathonDateSuffix('mini-marathon-raid-23-1226'), '23-1226');
  assert.equal(marathonDateSuffix('placeholder'), '');
  assert.equal(marathonDateSuffix(''), '');

  assert.equal(marathonIdStem('marathon-22-0526'), 'marathon');
  assert.equal(marathonIdStem('mini-marathon-raid-23-1226'), 'mini-marathon-raid');
  assert.equal(marathonIdStem('placeholder'), 'placeholder');
  assert.equal(marathonIdStem(''), '');
});

test('item candidates list the event stem first, then the item families', () => {
  assert.deepEqual(staminaRecoveryItemCandidates('mini-marathon-raid-23-1226'), [
    'item-mini-marathon-raid_stamina_recovery-23-1226',
    'item-marathon_stamina_recovery-23-1226',
    'item-raid_stamina_recovery-23-1226',
  ]);
  assert.deepEqual(questUnlockItemCandidates('marathon-22-0526'), [
    'item-marathon_quest_unlock-22-0526',
    'item-raid_quest_unlock-22-0526',
    'item-mini-marathon-raid_quest_unlock-22-0526',
  ]);
  // No date suffix: no candidate can exist, so the derivation stays blank.
  assert.deepEqual(staminaRecoveryItemCandidates('marathon'), []);
  assert.deepEqual(questUnlockItemCandidates(''), []);
});

test('the first existing candidate item is used, ignoring later ones', () => {
  const draft = deriveMarathonDraft(
    'marathon-22-0526',
    noLookups({ existingItemIds: ['item-raid_quest_unlock-22-0526'] }),
  );

  assert.equal(draft.questUnlockItemId, 'item-raid_quest_unlock-22-0526');
  assert.equal(draft.staminaRecoveryItemId, '');
});
