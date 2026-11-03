// Sandbox profile tests. Unit-level only: no database or game master data is
// required (the acceptance suite runs without real game data).
//
//   node src/profiles/sandbox/sandbox.test.ts
import fs from 'node:fs';
import { PROFILE, isSandbox, parseProfile } from '../../profile.ts';
import {
  SANDBOX_GACHA_RARITIES,
  sandboxCardBuckets,
  sandboxRarityOf,
} from './gacha.ts';
import {
  MEMORIAL_GACHA_CATEGORY,
  MEMORIAL_GACHA_IDS,
  MEMORIAL_RATES,
  buildMemorialPools,
  gachaFamily,
  isMemorialGachaId,
  memorialBuckets,
  memorialCategoryOf,
} from './memorialGacha.ts';
import { SANDBOX_BLOCKED_RPCS } from './blockedRpcs.ts';
import { endpoints } from '@sumire-sr/protocol/gen/endpoints.ts';
import {
  existingHistoryPath,
  firstPath,
  resolveMessageDetails,
  terminalMessageDetailId,
  validateMessageProgressExtension,
} from '../../services/messagePath.ts';
import {
  CALL_DELAY_MS,
  SANDBOX_LAUNCH_TIME,
  messageReleaseTime,
  parseDateInId,
} from './messageDates.ts';
import {
  SANDBOX_SPECIAL_PHOTO_SHOOTING_ID,
  sandboxSpecialPhotoShootingInfo,
} from './specialPhoto.ts';
import {
  SANDBOX_SHELF_ALBUMS,
  SANDBOX_SHELF_DEFAULT_TEMPLATE_ID,
  SANDBOX_SHELF_END_TIME,
  SANDBOX_SHELF_PLAY_CONDITION_ID,
  SANDBOX_SHELF_START,
  SANDBOX_SHELF_STORY_CONDITION_ID,
  SANDBOX_SHELF_TEMPLATES,
  sandboxShelfAlbumTemplateId,
  sandboxHomeShelfInfo,
  sandboxShelfButton,
  sandboxShelfEpisodeInfos,
  sandboxShelfInfo,
  shelfPageSubject,
  sandboxShelfTemplateInfos,
  sandboxShelfAlbum,
} from './shelf.ts';
import {
  createTitleRotation,
  titleMasterVersion,
  titleVariantBlobPath,
  type TitleVariant,
} from './titleBackground.ts';
import type { Decoded } from '@sumire-sr/protocol/runtime/proto.ts';
import {
  SANDBOX_SHOWCASE_CASE_COUNT,
  SANDBOX_SHOWCASE_TOY_AMOUNT,
  isSandboxBlockedGacha,
  sandboxShowcaseShops,
  withSandboxShowcaseSlots,
} from './showcase.ts';

let pass = 0;
let fail = 0;

function check(label: string, cond: boolean): void {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${label}`);
  cond ? pass++ : fail++;
}

function throws(label: string, fn: () => unknown): void {
  let threw = false;
  try {
    fn();
  } catch {
    threw = true;
  }
  check(label, threw);
}

// ---------------------------------------------------------------------------
// Profile parsing
// ---------------------------------------------------------------------------
if (process.env.SUMIRE_PROFILE === undefined) {
  check('unset SUMIRE_PROFILE defaults to sandbox', PROFILE === 'sandbox' && isSandbox());
}
check('parseProfile(undefined) -> sandbox', parseProfile(undefined) === 'sandbox');
check('parseProfile("official") -> official', parseProfile('official') === 'official');
check('parseProfile("sandbox") -> sandbox', parseProfile('sandbox') === 'sandbox');
throws('parseProfile("") throws', () => parseProfile(''));
throws('parseProfile("SANDBOX") throws', () => parseProfile('SANDBOX'));
throws('parseProfile("sandbox ") throws', () => parseProfile('sandbox '));
throws('parseProfile("dev") throws', () => parseProfile('dev'));

// ---------------------------------------------------------------------------
// Sandbox gacha pool override
// ---------------------------------------------------------------------------
const fakeCards = [
  { Id: 'card-5', InitialRarity: 5 },
  { Id: 'card-4', InitialRarity: 4 },
  { Id: 'card-3', InitialRarity: 3 },
  { Id: 'card-1', InitialRarity: 1 },
  { Id: 'card-2', InitialRarity: 2 },
  { Id: '', InitialRarity: 5 },
];

check('sandboxRarityOf keeps ★5', sandboxRarityOf(fakeCards[0]!) === 5);
check('sandboxRarityOf keeps ★4', sandboxRarityOf(fakeCards[1]!) === 4);
check('sandboxRarityOf keeps ★3', sandboxRarityOf(fakeCards[2]!) === 3);
check('sandboxRarityOf folds non-gacha rarity into ★3', sandboxRarityOf(fakeCards[3]!) === 3);

const buckets = sandboxCardBuckets(fakeCards);
const allIds = [...buckets.values()].flat().sort();
check(
  'sandbox buckets contain every master card (incl. ★1/★2)',
  JSON.stringify(allIds) ===
    JSON.stringify(['card-1', 'card-2', 'card-3', 'card-4', 'card-5']),
);
check(
  'sandbox buckets only use drawable rarities',
  [...buckets.keys()].every((r) => (SANDBOX_GACHA_RARITIES as readonly number[]).includes(r)),
);
check('★5 bucket is unchanged', JSON.stringify(buckets.get(5)) === JSON.stringify(['card-5']));
check('★4 bucket is unchanged', JSON.stringify(buckets.get(4)) === JSON.stringify(['card-4']));
check(
  '★3 bucket also carries the non-gacha cards',
  JSON.stringify(buckets.get(3)) === JSON.stringify(['card-3', 'card-1', 'card-2']),
);
check(
  'each card appears in exactly one bucket',
  buckets.size === 3 && allIds.length === new Set(allIds).size,
);

const empty = sandboxCardBuckets([]);
check('empty catalogue yields an empty bucket map', empty.size === 0);

// ---------------------------------------------------------------------------
// Memorial gacha category pools
// ---------------------------------------------------------------------------
check(
  'gachaFamily strips prefix, release marker and date',
  gachaFamily('gacha-all-star-01-26-0817') === 'all-star',
);
check(
  'gachaFamily keeps the lm-set family',
  gachaFamily('gacha-lm-set-bloom-25-0212-free') === 'lm-set-bloom',
);
check(
  'gachaFamily keeps rev-birthday',
  gachaFamily('gacha-rev-birthday-25-0505') === 'rev-birthday',
);

const birthdayFamilies = new Set(['rev-birthday']);
const fesFamilies = new Set(['fs-set-bloom']);
const limitedFamilies = new Set(['lm-set-bloom']);
const excursionFamilies = new Set(['excursion']);
const emptyFamilies = new Set<string>();

check(
  'birthday family is birthday',
  memorialCategoryOf('card-a-05-fest-00', birthdayFamilies, undefined) === 'birthday',
);
check(
  'birthday beats fes',
  memorialCategoryOf('card-a-05-fest-00', new Set(['birthday', 'fs-set']), undefined) === 'birthday',
);
check(
  'link tag beats a fes family',
  memorialCategoryOf('card-kan-05-link-00', fesFamilies, 'character_group_1') === 'link',
);
check(
  'fest tag is fes',
  memorialCategoryOf('card-a-05-fest-00', emptyFamilies, undefined) === 'fes',
);
check(
  'fs- family is fes',
  memorialCategoryOf('card-a-05-plain-00', fesFamilies, undefined) === 'fes',
);
check(
  'excursion-01 family is excursion',
  memorialCategoryOf('card-a-05-casl-04', excursionFamilies, 'character_group_1') === 'excursion',
);
check(
  'excursion wins over lm-set-bloom',
  memorialCategoryOf('card-a-05-casl-04', new Set(['excursion', 'lm-set-bloom']), 'character_group_1') ===
    'excursion',
);
for (const group of ['character_group_1', 'character_group_4', 'character_group_6']) {
  check(
    `limited ${group} is limited1`,
    memorialCategoryOf('card-a-05-plain-00', limitedFamilies, group) === 'limited1',
  );
}
for (const group of ['character_group_2', 'character_group_3', 'character_group_5']) {
  check(
    `limited ${group} is limited2`,
    memorialCategoryOf('card-a-05-plain-00', limitedFamilies, group) === 'limited2',
  );
}
check(
  'limited outside the six units is collab',
  memorialCategoryOf('card-a-05-plain-00', limitedFamilies, 'character_group_goch') === 'collab',
);
check(
  'limited without a group is collab',
  memorialCategoryOf('card-a-05-plain-00', limitedFamilies, undefined) === 'collab',
);
check(
  'birthday beats excursion',
  memorialCategoryOf('card-a-05-casl-04', new Set(['birthday', 'excursion']), 'character_group_1') ===
    'birthday',
);
check(
  'link tag beats an excursion family',
  memorialCategoryOf('card-kan-05-link-00', excursionFamilies, 'character_group_1') === 'link',
);
check(
  'fest tag beats an excursion family',
  memorialCategoryOf('card-a-05-fest-00', excursionFamilies, 'character_group_1') === 'fes',
);
check(
  'fs- family beats an excursion family',
  memorialCategoryOf('card-a-05-plain-00', new Set(['fs-set', 'excursion']), undefined) === 'fes',
);
check(
  'never-featured card is normal',
  memorialCategoryOf('card-a-05-plain-00', emptyFamilies, 'character_group_1') === 'normal',
);
check(
  'premium tag is premium',
  memorialCategoryOf('card-a-05-prem-00', new Set(), undefined) === 'premium',
);

check(
  'MEMORIAL_RATES sums to exactly 100',
  MEMORIAL_RATES[5] + MEMORIAL_RATES[4] + MEMORIAL_RATES[3] === 100,
);
const expectedMemorialCategories = [
  'birthday',
  'fes',
  'excursion',
  'limited1',
  'limited2',
  'link',
  'normal',
  'collab',
  'premium',
];
const memorialCategories = Object.values(MEMORIAL_GACHA_CATEGORY);
check(
  'MEMORIAL_GACHA_CATEGORY covers all 9 categories exactly once',
  memorialCategories.length === 9 &&
    new Set(memorialCategories).size === 9 &&
    expectedMemorialCategories.every((c) => (memorialCategories as string[]).includes(c)),
);
check(
  'MEMORIAL_GACHA_IDS lists every memorial banner',
  MEMORIAL_GACHA_IDS.length === 9 && MEMORIAL_GACHA_IDS.every((id) => isMemorialGachaId(id)),
);
check(
  'isMemorialGachaId rejects other ids',
  !isMemorialGachaId('gacha-fes-21-0928') && !isMemorialGachaId(null) && !isMemorialGachaId(7),
);

const memorialCards = [
  { Id: 'card-a-05-bday-00', InitialRarity: 5, CharacterId: 'char-a' },
  { Id: 'card-b-05-fest-00', InitialRarity: 5, CharacterId: 'char-b' },
  { Id: 'card-c-05-link-00', InitialRarity: 5, CharacterId: 'char-c' },
  { Id: 'card-d-05-lmst-00', InitialRarity: 5, CharacterId: 'char-d' },
  { Id: 'card-e-05-lmst-00', InitialRarity: 5, CharacterId: 'char-e' },
  { Id: 'card-f-05-lmst-00', InitialRarity: 5, CharacterId: 'char-f' },
  { Id: 'card-g-05-norm-00', InitialRarity: 5, CharacterId: 'char-g' },
  { Id: 'card-p-05-prem-00', InitialRarity: 5, CharacterId: 'char-p' },
  { Id: 'card-h-04-lmst-00', InitialRarity: 4, CharacterId: 'char-d' },
  { Id: 'card-i-05-lmst-00', InitialRarity: 5, CharacterId: 'char-d' },
];
const memorialGachas = [
  { Id: 'gacha-birthday-25-0505', PickupCardIds: ['card-a-05-bday-00'] },
  { Id: 'gacha-fes-26-0301', SelectCardIds: ['card-b-05-fest-00'] },
  { Id: 'gacha-link-26-0101', PickupCardIds: ['card-c-05-link-00'] },
  {
    Id: 'gacha-lm-set-bloom-25-0212-free',
    PickupCardIds: ['card-d-05-lmst-00', 'card-e-05-lmst-00', 'card-f-05-lmst-00'],
  },
  { Id: 'gacha-normal-25-0101', PickupCardIds: ['card-g-05-norm-00'] },
  { Id: 'gacha-sandbox-collab-memorial', PickupCardIds: ['card-i-05-lmst-00'] },
];
const memorialCharacters = [
  { Id: 'char-a', CharacterGroupId: 'character_group_1' },
  { Id: 'char-b', CharacterGroupId: 'character_group_2' },
  { Id: 'char-c', CharacterGroupId: 'character_group_3' },
  { Id: 'char-d', CharacterGroupId: 'character_group_1' },
  { Id: 'char-e', CharacterGroupId: 'character_group_2' },
  { Id: 'char-f', CharacterGroupId: 'character_group_goch' },
  { Id: 'char-g', CharacterGroupId: 'character_group_1' },
];
const memorialPools = buildMemorialPools({
  cards: memorialCards,
  gachas: memorialGachas,
  characters: memorialCharacters,
});
check(
  'buildMemorialPools always exposes all 9 categories',
  memorialPools.size === 9 &&
    expectedMemorialCategories.every((c) => memorialPools.has(c as never)),
);
check(
  'birthday pool',
  JSON.stringify(memorialPools.get('birthday')) === JSON.stringify(['card-a-05-bday-00']),
);
check(
  'fes pool',
  JSON.stringify(memorialPools.get('fes')) === JSON.stringify(['card-b-05-fest-00']),
);
check(
  'link pool',
  JSON.stringify(memorialPools.get('link')) === JSON.stringify(['card-c-05-link-00']),
);
check(
  'limited1 pool',
  JSON.stringify(memorialPools.get('limited1')) === JSON.stringify(['card-d-05-lmst-00']),
);
check(
  'limited2 pool',
  JSON.stringify(memorialPools.get('limited2')) === JSON.stringify(['card-e-05-lmst-00']),
);
check(
  'collab pool',
  JSON.stringify(memorialPools.get('collab')) === JSON.stringify(['card-f-05-lmst-00']),
);
check(
  'premium pool',
  JSON.stringify(memorialPools.get('premium')) === JSON.stringify(['card-p-05-prem-00']),
);
check(
  'memorial gacha ids are skipped when collecting families',
  JSON.stringify(memorialPools.get('normal')) ===
    JSON.stringify(['card-g-05-norm-00', 'card-i-05-lmst-00']),
);
check(
  'buildMemorialPools ignores non-★5 cards',
  ![...memorialPools.values()].flat().includes('card-h-04-lmst-00'),
);
check(
  'buildMemorialPools classifies every ★5 card exactly once',
  [...memorialPools.values()].flat().length === 9 &&
    [...memorialPools.values()].flat().length === new Set([...memorialPools.values()].flat()).size,
);
const emptyMemorialPools = buildMemorialPools({ cards: [], gachas: [], characters: [] });
check(
  'empty master still yields all 9 empty pools',
  emptyMemorialPools.size === 9 &&
    [...emptyMemorialPools.values()].every((ids) => ids.length === 0),
);

const bucketCards = [
  { Id: 'card-a-05-bday-00', InitialRarity: 5 },
  { Id: 'card-h-04-lmst-00', InitialRarity: 4 },
  { Id: 'card-j-03-lmst-00', InitialRarity: 3 },
  { Id: 'card-k-02-lmst-00', InitialRarity: 2 },
  { Id: 'card-l-01-lmst-00', InitialRarity: 1 },
];
const memorialBucketsForBirthday = memorialBuckets('birthday', memorialPools, bucketCards);
check(
  'memorialBuckets ★5 is the category pool',
  JSON.stringify(memorialBucketsForBirthday.get(5)) === JSON.stringify(['card-a-05-bday-00']),
);
check(
  'memorialBuckets ★4 is every InitialRarity-4 card',
  JSON.stringify(memorialBucketsForBirthday.get(4)) === JSON.stringify(['card-h-04-lmst-00']),
);
check(
  'memorialBuckets ★3 is every InitialRarity-3 card',
  JSON.stringify(memorialBucketsForBirthday.get(3)) === JSON.stringify(['card-j-03-lmst-00']),
);
check(
  'memorialBuckets never exposes ★1/★2',
  !memorialBucketsForBirthday.has(1) && !memorialBucketsForBirthday.has(2),
);

// ---------------------------------------------------------------------------
// Blocked RPCs: each must be a real endpoint, or the router check never fires.
// ---------------------------------------------------------------------------
check('LIVE page entry (Quest:Top) is blocked', SANDBOX_BLOCKED_RPCS.has('Quest:Top'));
check('Shop page entry (Shop:List) is blocked', SANDBOX_BLOCKED_RPCS.has('Shop:List'));
check('home Roulette button (Roulette:Top) is blocked', SANDBOX_BLOCKED_RPCS.has('Roulette:Top'));
check('home Login Bonus button (LoginBonus:List) is blocked', SANDBOX_BLOCKED_RPCS.has('LoginBonus:List'));
check('home Task button (Mission:List) is blocked', SANDBOX_BLOCKED_RPCS.has('Mission:List'));
check(
  'home VENUS UNION button (Guild:Top / Guild:List) is blocked',
  SANDBOX_BLOCKED_RPCS.has('Guild:Top') && SANDBOX_BLOCKED_RPCS.has('Guild:List'),
);
check('home Manager Training button (Exercise:Top) is blocked', SANDBOX_BLOCKED_RPCS.has('Exercise:Top'));
check('home Invite Code button (Invite:Top) is blocked', SANDBOX_BLOCKED_RPCS.has('Invite:Top'));
check('home Exchange button (Exchange:List) is blocked', SANDBOX_BLOCKED_RPCS.has('Exchange:List'));
check(
  'accessory screens (Enhance / LimitBreak / Sell) are blocked',
  ['Accessory:Enhance', 'Accessory:LimitBreak', 'Accessory:Sell'].every((name) =>
    SANDBOX_BLOCKED_RPCS.has(name),
  ),
);
check(
  'showcase goods shop (Shop:ListItem / Shop:Purchase) is blocked',
  SANDBOX_BLOCKED_RPCS.has('Shop:ListItem') && SANDBOX_BLOCKED_RPCS.has('Shop:Purchase'),
);
check('showcase gallery (Showcase:GalleryTop) is blocked', SANDBOX_BLOCKED_RPCS.has('Showcase:GalleryTop'));
check(
  'placeholder goods shops cover ShowcaseToyShop, DefaultShowcaseToyShop and OnlyShowcaseShop',
  [5, 1003, 2001].every((t) => sandboxShowcaseShops().some((s) => s.Type === t)),
);
check('showcase toy gachas (GachaType 6) are blocked', isSandboxBlockedGacha({ GachaType: 6 }));
check(
  'other gachas are not blocked',
  !isSandboxBlockedGacha({ GachaType: 3 }) && !isSandboxBlockedGacha({ GachaType: 1 }) && !isSandboxBlockedGacha(null),
);
check(
  'placeholder goods shop ids are unique',
  new Set(sandboxShowcaseShops().map((s) => s.Id)).size === sandboxShowcaseShops().length,
);
check('Lv Assist (Card:SetSupport) is blocked', SANDBOX_BLOCKED_RPCS.has('Card:SetSupport'));
check('Renewal (Card:Reset) is blocked', SANDBOX_BLOCKED_RPCS.has('Card:Reset'));
for (const name of SANDBOX_BLOCKED_RPCS) {
  const [service, method] = name.split(':');
  check(`blocked rpc ${name} is a known endpoint`, Boolean((endpoints as any)[service]?.[method]));
}

// ---------------------------------------------------------------------------
// Home Idol slot (HomePositionType 4). The client fills Satomi's side spot from
// this row and hangs on the lobby load when it is missing, so it must always be
// present: Satomi when she is not placed in slots 1-3, otherwise another owned,
// unplaced idol. A valid stored row is kept so the random pick is stable.
// ---------------------------------------------------------------------------
const { resolveIdolSlot } = await import('../../services/home.ts');
const position = (type: number, characterId: string) => ({
  __msg: 'Solis.Common.Proto.Transaction.UserHomePosition',
  HomePositionType: type,
  CharacterId: characterId,
  IsCharacterRandom: false,
  IsCostumeRandom: false,
});
const ownedIds = ['char-a', 'char-b', 'char-c', 'char-stm'];

const unplaced = resolveIdolSlot([position(1, 'char-a')], ownedIds);
check('idol slot is Satomi when she is not placed', unplaced.CharacterId === 'char-stm');
check(
  'idol slot row carries type 4 and the fixed flags',
  unplaced.HomePositionType === 4 &&
    unplaced.IsCharacterRandom === false &&
    unplaced.IsCostumeRandom === false &&
    unplaced.__msg === 'Solis.Common.Proto.Transaction.UserHomePosition',
);
check('idol slot defaults to Satomi with no positions', resolveIdolSlot([], ownedIds).CharacterId === 'char-stm');

const idolPick = resolveIdolSlot([position(1, 'char-stm'), position(2, 'char-a')], ownedIds, () => 0);
check('idol pick is owned, not Satomi and not already placed', idolPick.CharacterId === 'char-b');
check(
  'idol pick honours the injected rand',
  resolveIdolSlot([position(1, 'char-stm'), position(2, 'char-a')], ownedIds, () => 0.999).CharacterId === 'char-c',
);

const stable = resolveIdolSlot([position(1, 'char-stm'), position(2, 'char-a'), position(4, 'char-c')], ownedIds, () => 0);
check('a still-valid stored idol row is kept', stable.CharacterId === 'char-c');
const stale = resolveIdolSlot([position(1, 'char-stm'), position(4, 'char-b')], ['char-a', 'char-c'], () => 0);
check('a stored idol row that is no longer valid is replaced', stale.CharacterId === 'char-a');
check(
  'idol slot returns Satomi when she is not placed even if a row exists',
  resolveIdolSlot([position(1, 'char-a'), position(4, 'char-b')], ['char-a', 'char-b']).CharacterId === 'char-stm',
);
check(
  'no eligible idol falls back to Satomi',
  resolveIdolSlot([position(1, 'char-stm'), position(2, 'char-a')], ['char-stm', 'char-a']).CharacterId === 'char-stm',
);
check(
  'a kept stored idol row is normalized to non-random',
  resolveIdolSlot(
    [position(1, 'char-stm'), { ...position(4, 'char-b'), IsCharacterRandom: true }],
    ['char-b'],
  ).IsCharacterRandom === false,
);

// ---------------------------------------------------------------------------
// Message detail graph (FirstPath / ExistingHistoryPath port).
// ---------------------------------------------------------------------------
const branchMessage = {
  Id: 'message-test-branch',
  MessageGroupId: 'message_group_test',
  Details: [
    { MessageDetailId: '1', NextMessageDetailIds: ['2a', '2b'] },
    { MessageDetailId: '2a', ChoiceText: 'A', NextMessageDetailIds: ['3'] },
    { MessageDetailId: '2b', ChoiceText: 'B', NextMessageDetailIds: ['3'] },
    { MessageDetailId: '3', NextMessageDetailIds: [] },
  ],
};
const first = firstPath(branchMessage);
check(
  'FirstPath takes the first listed choice',
  JSON.stringify(first.selections) === JSON.stringify(['2a']) &&
    first.terminal.MessageDetailId === '3',
);
const second = resolveMessageDetails(branchMessage, ['2b'], '');
check(
  'resolveMessageDetails follows the selected branch',
  JSON.stringify(second.selections) === JSON.stringify(['2b']) &&
    second.path.map((detail) => detail.MessageDetailId).join(',') === '1,2b,3',
);
check(
  'ExistingHistoryPath accepts a complete selected route',
  existingHistoryPath(branchMessage, ['2a']).MessageDetailId === '3',
);
let branchThrew = false;
try {
  resolveMessageDetails(branchMessage, [], '');
} catch {
  branchThrew = true;
}
check('resolveMessageDetails requires one choice at a branch', branchThrew);
branchThrew = false;
try {
  existingHistoryPath(branchMessage, ['nope']);
} catch {
  branchThrew = true;
}
check('ExistingHistoryPath rejects unknown choices', branchThrew);
const prefixPath = resolveMessageDetails(branchMessage, ['2a'], '2a').path;
validateMessageProgressExtension(branchMessage, '2a', ['2a'], prefixPath);
check('saved progress can extend along the same route', true);
branchThrew = false;
try {
  validateMessageProgressExtension(
    branchMessage,
    '2a',
    ['2a'],
    resolveMessageDetails(branchMessage, ['2b'], '').path,
  );
} catch {
  branchThrew = true;
}
check('saved progress cannot switch routes', branchThrew);
check(
  'terminalMessageDetailId uses the greatest terminal id',
  terminalMessageDetailId({
    Id: 'message-test-terminals',
    Details: [
      { MessageDetailId: '1', NextMessageDetailIds: ['9', '10'] },
      { MessageDetailId: '9', ChoiceText: 'nine', NextMessageDetailIds: [] },
      { MessageDetailId: '10', ChoiceText: 'ten', NextMessageDetailIds: [] },
    ],
  }) === '9',
);

// ---------------------------------------------------------------------------
// Sandbox message/call release dates
// ---------------------------------------------------------------------------
const cardRelease = 1672714800000; // 2023-01-03 12:00 JST
const dateContext = { now: 1793564775819 };
check(
  'card-linked message uses the card release date',
  messageReleaseTime('message-card-ai-01', {
    ...dateContext,
    cardReleaseDates: new Map([['card-ai-01', cardRelease]]),
  }) === cardRelease,
);
check(
  'date in id resolves to 12:00 JST',
  messageReleaseTime('message-hbd-ai-22-0209', dateContext) ===
    Date.UTC(2022, 1, 9, 3, 0, 0),
);
check(
  'event ladder id resolves to 12:00 JST',
  messageReleaseTime('message-event-ladder-22-0513-01', dateContext) ===
    Date.UTC(2022, 4, 13, 3, 0, 0),
);
check(
  'year-only event uses its event date',
  messageReleaseTime('message-event-vlnt-25-01', dateContext) ===
    Date.UTC(2025, 1, 14, 3, 0, 0),
);
const parentTime = Date.UTC(2023, 0, 3, 3, 0, 0);
check(
  'embedded call is one minute after its parent message',
  messageReleaseTime('tel-message-love-mei-24-0517', {
    ...dateContext,
    messageTimes: new Map([['message-love-mei', parentTime]]),
    telephoneParents: new Map([['tel-message-love-mei-24-0517', 'message-love-mei']]),
  }) === parentTime + CALL_DELAY_MS,
);
check(
  'fallback orders messages by 1-based group index',
  messageReleaseTime('message-story-a', { ...dateContext, groupIndex: 1 }) ===
    SANDBOX_LAUNCH_TIME + CALL_DELAY_MS &&
    messageReleaseTime('message-story-b', { ...dateContext, groupIndex: 3 }) ===
      SANDBOX_LAUNCH_TIME + 3 * CALL_DELAY_MS &&
    SANDBOX_LAUNCH_TIME + CALL_DELAY_MS < SANDBOX_LAUNCH_TIME + 3 * CALL_DELAY_MS,
);
check(
  'future dates are clamped to now',
  messageReleaseTime('message-card-future', {
    now: cardRelease,
    cardReleaseDates: new Map([['card-future', cardRelease + 1000]]),
  }) === cardRelease &&
    messageReleaseTime('message-hbd-ai-99-0101', { now: cardRelease }) === cardRelease,
);
check(
  'invalid date fragment falls through',
  parseDateInId('message-bad-22-1340') === null &&
    messageReleaseTime('message-bad-22-1340', { ...dateContext, groupIndex: 2 }) ===
      SANDBOX_LAUNCH_TIME + 2 * CALL_DELAY_MS,
);

// ---------------------------------------------------------------------------
// Sandbox Special Photography
// ---------------------------------------------------------------------------
const specialPhoto = sandboxSpecialPhotoShootingInfo();
check(
  'special photo shooting carries the sandbox campaign id',
  specialPhoto.SpecialPhotoShootingId === SANDBOX_SPECIAL_PHOTO_SHOOTING_ID,
);
check('special photo shooting is unlocked', specialPhoto.IsUnlocked === true);
check('special photo shooting has no unlock condition', specialPhoto.UnlockConditionId === '');

// ---------------------------------------------------------------------------
// Sandbox Photo Album ("Shelf")
// ---------------------------------------------------------------------------
const homeShelf = sandboxHomeShelfInfo();
check(
  'shelf album table has every album',
  SANDBOX_SHELF_ALBUMS.length === 61 &&
    new Set(SANDBOX_SHELF_ALBUMS.map((album) => album.AlbumId)).size ===
      SANDBOX_SHELF_ALBUMS.length,
);
check(
  'home shelf listing has every album',
  Array.isArray(homeShelf.AlbumInfos) && homeShelf.AlbumInfos.length === 61,
);
check('home shelf is permanent (EndTime 0)', Number(homeShelf.EndTime) === SANDBOX_SHELF_END_TIME);
check(
  'home shelf uses the play condition',
  homeShelf.UnlockConditionId === SANDBOX_SHELF_PLAY_CONDITION_ID,
);
const shelfButton = sandboxShelfButton();
check(
  'shelf button carries the play condition and priority',
  shelfButton.ConditionId === SANDBOX_SHELF_PLAY_CONDITION_ID && shelfButton.Priority === 100,
);
const shelfTop = sandboxShelfInfo();
check(
  'shelf top listing has every album',
  Array.isArray(shelfTop.AlbumInfos) && shelfTop.AlbumInfos.length === 61,
);
check('shelf top is permanent (EndTime 0)', Number(shelfTop.EndTime) === SANDBOX_SHELF_END_TIME);
check(
  'shelf top carries the four event missions',
  Array.isArray((shelfTop.EventMissionInfo as { UserMissions?: unknown[] }).UserMissions) &&
    (shelfTop.EventMissionInfo as { UserMissions?: unknown[] }).UserMissions!.length === 4,
);

// The served Condition master must match the permanent event: the shelf's own
// gates carry a real start and an open-ended Term, while the event shop chained
// to them keeps its real end. Reads the patched master from phaseA2 when it is
// present (patch_gacha_conditions.py); skipped without game data.
type ConditionSetting = { Term?: { NowAfter?: number; NowBefore?: number } };
const conditionJson = new URL('../../../../phaseA2/out/structured/Condition.json', import.meta.url);
const conditionRows = (
  fs.existsSync(conditionJson) ? JSON.parse(fs.readFileSync(conditionJson, 'utf8')) : []
) as Array<{ Id: string; Settings: ConditionSetting[] }>;
const conditionSettings = (id: string): ConditionSetting[] =>
  conditionRows.find((row) => row.Id === id)?.Settings ?? [];
if (conditionRows.length === 0) {
  console.log('skip  shelf condition checks (no phaseA2 master)');
} else {
  for (const id of ['cd-shelf-26-1002', SANDBOX_SHELF_PLAY_CONDITION_ID, SANDBOX_SHELF_STORY_CONDITION_ID]) {
    const settings = conditionSettings(id);
    check(
      `shelf condition ${id} is open-ended`,
      settings.length > 0 &&
        settings.every(
          (setting) =>
            (setting.Term?.NowBefore ?? 0) === 0 && setting.Term?.NowAfter === SANDBOX_SHELF_START,
        ),
    );
  }
  const eventShopSettings = conditionSettings('cd-shop_special-shop-26-1002-1020-1');
  check(
    'event shop condition keeps its real end time',
    eventShopSettings.length > 0 &&
      eventShopSettings.every(
        (setting) => setting.Term === undefined || setting.Term.NowBefore === 1792465199000,
      ),
  );

  // Photo mode venues (shootings, activities, expressions, contests) must use
  // the same official permanent form as the Photo Album: a real start and an
  // open-ended Term, so the client shows no remaining time.
  const photoTables = [
    'PhotoQuestMusic',
    'PhotoQuestStage',
    'PhotoActivity',
    'PhotoExpression',
    'PhotoContestActivity',
    'PhotoContestQuestMusic',
    'PhotoContestSection',
  ];
  const photoConditionIds = new Set<string>();
  for (const table of photoTables) {
    const file = new URL(`../../../../phaseA2/out/structured/${table}.json`, import.meta.url);
    if (!fs.existsSync(file)) continue;
    const rows = JSON.parse(fs.readFileSync(file, 'utf8')) as Array<{
      ViewConditionId?: string;
      UnlockConditionId?: string;
    }>;
    for (const row of rows) {
      if (row.ViewConditionId) photoConditionIds.add(row.ViewConditionId);
      if (row.UnlockConditionId) photoConditionIds.add(row.UnlockConditionId);
    }
  }
  const photoSettings = [...photoConditionIds].flatMap((id) => conditionSettings(id));
  check(
    'photo venue conditions are never far-future',
    photoSettings.every((setting) => setting.Term?.NowBefore !== 4398046511103),
  );
  check(
    'photo venue conditions have not ended',
    photoSettings.every(
      (setting) =>
        setting.Term === undefined ||
        (setting.Term.NowBefore ?? 0) === 0 ||
        setting.Term.NowBefore! > Date.now(),
    ),
  );
  const shootingMv002Settings = conditionSettings('cd-photo-shooting-mv-002');
  check(
    'photo venue cd-photo-shooting-mv-002 is permanent from its real start',
    shootingMv002Settings.length > 0 &&
      shootingMv002Settings.every(
        (setting) =>
          setting.Term?.NowAfter === 1675177200000 && (setting.Term.NowBefore ?? 0) === 0,
      ),
  );

  // Story gacha banners use the same official permanent form as the photo
  // venues: a real start and an open-ended Term.
  const birthday250505Settings = conditionSettings('cd-time-gacha-birthday-25-0505');
  check(
    'gacha banner cd-time-gacha-birthday-25-0505 is permanent from its real start',
    birthday250505Settings.length > 0 &&
      birthday250505Settings.every(
        (setting) =>
          setting.Term?.NowAfter === 1746370800000 && (setting.Term.NowBefore ?? 0) === 0,
      ),
  );
  const memorialGachaLimitedSettings = conditionSettings('cd-time-gacha-limited-26-1030-01');
  check(
    'memorial gacha banner cd-time-gacha-limited-26-1030-01 is permanent from its real start',
    memorialGachaLimitedSettings.length > 0 &&
      memorialGachaLimitedSettings.every(
        (setting) =>
          setting.Term?.NowAfter === 1793350800000 && (setting.Term.NowBefore ?? 0) === 0,
      ),
  );
}
check(
  'shelf templates start with the captured pair (6 + 4 slots)',
  SANDBOX_SHELF_TEMPLATES[0]!.TemplateId === SANDBOX_SHELF_DEFAULT_TEMPLATE_ID &&
    SANDBOX_SHELF_TEMPLATES[0]!.SlotNumbers.length === 6 &&
    SANDBOX_SHELF_TEMPLATES[1]!.TemplateId === 'shelf-tempate-default-001' &&
    SANDBOX_SHELF_TEMPLATES[1]!.SlotNumbers.length === 4,
);
check(
  'shelf templates offer every event frame and both defaults',
  SANDBOX_SHELF_TEMPLATES.length === 39 &&
    new Set(SANDBOX_SHELF_TEMPLATES.map((template) => template.TemplateId)).size === 39 &&
    SANDBOX_SHELF_TEMPLATES.every((template) =>
      template.TemplateType === 1
        ? template.SlotNumbers.length === 6
        : template.TemplateType === 2 && template.SlotNumbers.length === 4,
    ),
);
check(
  'shelf default template is the event template',
  SANDBOX_SHELF_DEFAULT_TEMPLATE_ID === 'shelf-tempate-shelf-24-0103-001',
);
const shelfEpisodeRows = [1, 2, 3].map((episode) => ({
  Id: `st-shelf-25-0225-001-${String(episode).padStart(3, '0')}`,
  AdvAssetIds: ['x'],
}));
const shelfEpisodes = sandboxShelfEpisodeInfos('shelf-album_shelf-25-0225-001', shelfEpisodeRows);
check(
  'shelf episodes follow the album episode count and story ids',
  shelfEpisodes.length === 3 &&
    shelfEpisodes.map((episode) => episode.StoryId).join(',') ===
      'st-shelf-25-0225-001-001,st-shelf-25-0225-001-002,st-shelf-25-0225-001-003',
);
const afterStoryRows = [1, 2, 3, 4, 5, 6].map((episode) => ({
  Id: `st-eve-2610-dice-${String(episode).padStart(3, '0')}`,
  AdvAssetIds: ['x'],
}));
const afterStoryEpisodes = sandboxShelfEpisodeInfos(
  'shelf-album_shelf-26-1030-001',
  afterStoryRows,
);
check(
  'after story album lists its event story ids directly',
  afterStoryEpisodes.length === 6 &&
    afterStoryEpisodes.map((episode) => episode.StoryId).join(',') ===
      'st-eve-2610-dice-001,st-eve-2610-dice-002,st-eve-2610-dice-003,st-eve-2610-dice-004,st-eve-2610-dice-005,st-eve-2610-dice-006',
);
check(
  'shelf album banners are unique',
  new Set(SANDBOX_SHELF_ALBUMS.map((album) => album.AssetId)).size ===
    SANDBOX_SHELF_ALBUMS.length,
);
check(
  'every album frame is an offered template',
  SANDBOX_SHELF_ALBUMS.every(
    (album) =>
      album.TemplateId === undefined ||
      SANDBOX_SHELF_TEMPLATES.some((template) => template.TemplateId === album.TemplateId),
  ),
);
check(
  'albums start on their own event frame',
  sandboxShelfAlbumTemplateId('shelf-album_shelf-26-1030-001') ===
    'shelf-tempate-shelf-26-1030-001' &&
    sandboxShelfAlbumTemplateId('shelf-album_shelf-26-0820-005') ===
      'shelf-tempate-shelf-25-0728-001',
);
check(
  'albums older than the first frame start on the default frame',
  sandboxShelfAlbumTemplateId('shelf-album_shelf-25-0825-001') ===
    SANDBOX_SHELF_DEFAULT_TEMPLATE_ID,
);
check(
  'shelf album names are unique',
  new Set(SANDBOX_SHELF_ALBUMS.map((album) => album.Name)).size ===
    SANDBOX_SHELF_ALBUMS.length,
);

// ---------------------------------------------------------------------------
// Album page subject: the develop request carries no subject, so it must be the
// idol most present among the photos placed in the page's slots.
// ---------------------------------------------------------------------------
const shelfPhoto = (AssetId: string, MainCharacterId: string) => ({
  AssetId,
  MainCharacterId,
});
const shelfPage = (
  templateId: string,
  slots: Record<string, string>,
  photos: Array<{ AssetId: string; MainCharacterId: string }>,
) => ({ templateId, slots: { [templateId]: slots }, photos });

const majorityPage = shelfPage(
  'tpl-a',
  { '1': 'a1', '2': 'a2', '3': 'b1' },
  [shelfPhoto('a1', 'char-a'), shelfPhoto('a2', 'char-a'), shelfPhoto('b1', 'char-b')],
);
check('page subject picks the majority character', shelfPageSubject(majorityPage) === 'char-a');

const tiePage = shelfPage(
  'tpl-a',
  { '3': 'b1', '1': 'a1' },
  [shelfPhoto('a1', 'char-a'), shelfPhoto('b1', 'char-b')],
);
check(
  'page subject tie goes to the character in the lowest slot',
  shelfPageSubject(tiePage) === 'char-a',
);

const lateTiePage = shelfPage(
  'tpl-a',
  { '1': 'a1', '2': 'b1', '3': 'b2', '4': 'a2' },
  [shelfPhoto('a1', 'char-a'), shelfPhoto('b1', 'char-b'), shelfPhoto('b2', 'char-b'), shelfPhoto('a2', 'char-a')],
);
check(
  'page subject tie goes to the lowest slot even when the other reaches the count first',
  shelfPageSubject(lateTiePage) === 'char-a',
);

const otherTemplatePage = {
  templateId: 'tpl-a',
  slots: {
    'tpl-a': { '1': 'a1' },
    'tpl-b': { '1': 'b1', '2': 'b2', '3': 'b3' },
  },
  photos: [shelfPhoto('a1', 'char-a'), shelfPhoto('b1', 'char-b')],
};
check(
  'page subject ignores slots of other templates',
  shelfPageSubject(otherTemplatePage) === 'char-a',
);

const unknownSlotPage = shelfPage(
  'tpl-a',
  { '1': 'missing', '2': 'empty', '3': 'a1' },
  [shelfPhoto('empty', ''), shelfPhoto('a1', 'char-a')],
);
check(
  'page subject skips unknown and empty subjects',
  shelfPageSubject(unknownSlotPage) === 'char-a',
);

const emptyPage = shelfPage('tpl-a', {}, []);
check('page subject is empty with no placed photos', shelfPageSubject(emptyPage) === '');

const cropTpl = 'shelf-tempate-shelf-24-0103-001';
const cropSlots = (sandboxShelfTemplateInfos(
  { [cropTpl]: { '3': 'asset-3', '5': 'asset-5' } },
  { [cropTpl]: { '3': 42, '4': 7 } },
).find((t) => t.TemplateId === cropTpl)?.SlotInfos ?? []) as Array<Record<string, unknown>>;
check(
  'slot crop offset returned for filled slots only',
  cropSlots[2]?.PositionX === 42 &&
    cropSlots[3]?.PositionX === undefined &&
    cropSlots[4]?.AssetId === 'asset-5' &&
    cropSlots[4]?.PositionX === undefined,
);

// ---------------------------------------------------------------------------
// Sandbox title-screen variants
// ---------------------------------------------------------------------------
const titleVariants: TitleVariant[] = ['23-0624', '24-0624', '25-0624', '26-0624'].map(
  (assetId) => ({
    assetId,
    id: `title-anniversary-01-${assetId}-01`,
    fileName: assetId.replace('-', '') + 'f'.repeat(56),
    fileSize: 12288 + assetId.length,
  }),
);

const rotation = createTitleRotation();
const firstTitle = rotation.current(titleVariants);
check('title rotation starts on the stock title', firstTitle?.assetId === '26-0624');
check('title rotation stays put without a step', rotation.current(titleVariants) === firstTitle);
check(
  'title rotation steps in order and wraps',
  ['23-0624', '24-0624', '25-0624', '26-0624', '23-0624'].every(
    (assetId) => rotation.next(titleVariants)?.assetId === assetId,
  ),
);
check('title rotation keeps the stepped title', rotation.current(titleVariants)?.assetId === '23-0624');
check('title rotation returns null with no variants', createTitleRotation().next([]) === null);

const titleVersionA = titleMasterVersion('base', titleVariants[0]!);
check(
  'title master version is deterministic and a sha256 hex',
  titleVersionA === titleMasterVersion('base', titleVariants[0]!) &&
    /^[0-9a-f]{64}$/.test(titleVersionA),
);
check(
  'title master version differs between variants and from the base',
  titleVersionA !== titleMasterVersion('base', titleVariants[1]!) && titleVersionA !== 'base',
);

const titlePath = titleVariantBlobPath(
  'TitleBackground',
  titleVariants[0]!.fileName,
  titleVariants,
);
check(
  'title blob path matches a variant file',
  titlePath !== null && titlePath.endsWith(titleVariants[0]!.fileName),
);
check(
  'title blob path rejects other table types',
  titleVariantBlobPath('Card', titleVariants[0]!.fileName, titleVariants) === null,
);
check(
  'title blob path rejects unknown files',
  titleVariantBlobPath('TitleBackground', 'deadbeef', titleVariants) === null,
);

check(
  'shelf albums play their own event track',
  sandboxShelfAlbum('shelf-album_shelf-26-0918-001')?.BgmAssetId ===
    'sud_bgm_general_event-shelf-tri-007' &&
    sandboxShelfAlbum('shelf-album_shelf-22-1128-001')?.BgmAssetId ===
      'sud_music_bgm_moon-007-inst' &&
    sandboxShelfAlbum('shelf-album_shelf-26-1002-001')?.BgmAssetId ===
      'sud_bgm_general_event-shelf-moon-008',
);

check(
  'showcase constants match the sandbox policy',
  SANDBOX_SHOWCASE_TOY_AMOUNT === 99 && SANDBOX_SHOWCASE_CASE_COUNT === 5,
);
const noShowcases = withSandboxShowcaseSlots([], SANDBOX_SHOWCASE_CASE_COUNT, (n) => ({
  __msg: 'test',
  Number: n,
}) as Decoded);
check(
  'empty showcase list fills five default slots',
  noShowcases.length === 5 && noShowcases.every((s, i) => Number(s.Number) === i + 1),
);
const savedSecond = withSandboxShowcaseSlots(
  [{ __msg: 'test', Number: 2, ShowcaseFrameId: 'frame-003' }],
  SANDBOX_SHOWCASE_CASE_COUNT,
  (n) => ({ __msg: 'test', Number: n }) as Decoded,
);
check(
  'saved showcase keeps its place among defaults',
  savedSecond.length === 5 &&
    Number(savedSecond[1]?.Number) === 2 &&
    String(savedSecond[1]?.ShowcaseFrameId) === 'frame-003' &&
    savedSecond.filter((s) => s.ShowcaseFrameId === 'frame-003').length === 1,
);
const savedSeventh = withSandboxShowcaseSlots(
  [{ __msg: 'test', Number: 7 }],
  SANDBOX_SHOWCASE_CASE_COUNT,
  (n) => ({ __msg: 'test', Number: n }) as Decoded,
);
check(
  'a saved slot above the case count is kept and sorted last',
  savedSeventh.length === 6 && Number(savedSeventh[5]?.Number) === 7,
);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exitCode = 1;
