// Pure birthday logic tests. No database or master data is required.
//
//   node --test src/services/birthday.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  BIRTHDAY_CODES,
  BIRTHDAY_CODES_LIST,
  advAssetIdOf,
  birthdayIdOf,
  birthdayPeriod,
  codeOfBirthdayId,
  decorationIdOf,
  homeInfo,
  isValidBirthDate,
  nextAdv,
  receivableIds,
  reconcileState,
  reminder,
  reminderYear,
  selectParticipants,
  unwatchedIds,
  type BirthdayState,
} from './birthdayLogic.ts';

const DAY_MS = 24 * 60 * 60 * 1000;

// 2026-11-07 00:00 JST
const ACTIVE_NOW = Date.UTC(2026, 10, 6, 15, 0, 0, 0);
// 2026-11-06 23:59:59.999 JST
const BEFORE_WINDOW = Date.UTC(2026, 10, 6, 14, 59, 59, 999);
// 2026-11-13 23:59:59.999 JST
const LAST_IN_WINDOW = Date.UTC(2026, 10, 13, 14, 59, 59, 999);
// 2026-11-14 00:00 JST
const AFTER_WINDOW = Date.UTC(2026, 10, 13, 15, 0, 0, 0);

const smr = birthdayIdOf('smr');
const yu = birthdayIdOf('yu');
const rui = birthdayIdOf('rui');
const participants = ['char-smr', 'char-yu', 'char-rui'];

function activeState(): BirthdayState {
  return reconcileState(null, 11, 7, participants, ACTIVE_NOW, () => 0).state;
}

test('birthday window is 7 days starting at 00:00 JST', () => {
  assert.equal(birthdayPeriod(11, 7, BEFORE_WINDOW).active, false);
  assert.equal(birthdayPeriod(11, 7, ACTIVE_NOW).active, true);
  assert.equal(birthdayPeriod(11, 7, LAST_IN_WINDOW).active, true);
  assert.equal(birthdayPeriod(11, 7, AFTER_WINDOW).active, false);
  const p = birthdayPeriod(11, 7, ACTIVE_NOW);
  assert.equal(p.startMs, ACTIVE_NOW);
  assert.equal(p.endMs, ACTIVE_NOW + 7 * DAY_MS);
  assert.equal(p.year, 2026);
});

test('birthday window handles the new-year boundary', () => {
  // 2027-01-03 00:00 JST belongs to the 12/30/2026 window.
  const now = Date.UTC(2027, 0, 2, 15, 0, 0, 0);
  const p = birthdayPeriod(12, 30, now);
  assert.equal(p.active, true);
  assert.equal(p.year, 2026);
});

test('Feb 29 collapses to Feb 28 in non-leap years', () => {
  assert.equal(isValidBirthDate(2, 29), true);
  assert.equal(isValidBirthDate(2, 30), false);
  assert.equal(isValidBirthDate(4, 31), false);
  assert.equal(isValidBirthDate(0, 1), false);
  assert.equal(isValidBirthDate(13, 1), false);
  assert.equal(isValidBirthDate(1, 0), false);

  const nonLeap = birthdayPeriod(2, 29, Date.UTC(2027, 1, 27, 15, 0, 0, 0));
  assert.equal(nonLeap.active, true);
  assert.equal(nonLeap.startMs, Date.UTC(2027, 1, 27, 15, 0, 0, 0)); // 2/28 00:00 JST
  assert.equal(nonLeap.endMs, Date.UTC(2027, 2, 6, 15, 0, 0, 0)); // 3/7 00:00 JST

  const leap = birthdayPeriod(2, 29, Date.UTC(2028, 1, 28, 15, 0, 0, 0));
  assert.equal(leap.active, true);
  assert.equal(leap.startMs, Date.UTC(2028, 1, 28, 15, 0, 0, 0)); // 2/29 00:00 JST
  assert.equal(leap.endMs, Date.UTC(2028, 2, 6, 15, 0, 0, 0));
});

test('reminderYear opens the week before the next birthday', () => {
  const exactlySevenDays = Date.UTC(2026, 9, 30, 15, 0, 0, 0); // 2026-10-31 00:00 JST
  assert.equal(reminderYear(11, 7, exactlySevenDays), 2026);
  assert.equal(reminderYear(11, 7, exactlySevenDays - 1), 0);
  assert.equal(reminderYear(11, 7, ACTIVE_NOW), 0);

  // 1/2 birthday: the reminder window crosses into the previous year.
  const newYear = Date.UTC(2026, 11, 27, 15, 0, 0, 0); // 2026-12-28 00:00 JST
  assert.equal(reminderYear(1, 2, newYear), 2027);
});

test('selectParticipants keeps favourites first and fills to three', () => {
  const three = selectParticipants(participants, () => 0);
  assert.deepEqual(three, [smr, yu, rui]);

  const four = selectParticipants(['char-smr', 'char-yu', 'char-rui', 'char-ai'], () => 0);
  assert.deepEqual(four, [smr, yu, rui]);

  const duplicates = selectParticipants(['char-smr', 'char-smr', 'char-nope', 'char-yu'], () => 0);
  assert.equal(duplicates[0], smr);
  assert.equal(duplicates[1], yu);
  assert.equal(duplicates.length, 3);
  assert.equal(new Set(duplicates).size, 3);

  for (const favourites of [[], ['char-smr']]) {
    const picked = selectParticipants(favourites, () => 0.25);
    assert.equal(picked.length, 3);
    assert.equal(new Set(picked).size, 3);
    if (favourites.length === 1) assert.equal(picked[0], smr);
  }

  assert.deepEqual(
    selectParticipants([], () => 0.42),
    selectParticipants([], () => 0.42),
  );
});

test('reconcileState creates, keeps and resets the event year', () => {
  const created = reconcileState(null, 11, 7, participants, ACTIVE_NOW, () => 0);
  assert.equal(created.changed, true);
  assert.equal(created.state.eventYear, 2026);
  assert.deepEqual(created.state.birthdayIds, [smr, yu, rui]);
  assert.deepEqual(created.state.watchedIds, []);
  assert.deepEqual(created.state.claimedIds, []);
  assert.equal(created.state.remindedYear, 0);

  const inactive = reconcileState(null, 11, 7, participants, BEFORE_WINDOW, () => 0);
  assert.equal(inactive.changed, false);
  assert.equal(inactive.state.eventYear, 0);
  assert.deepEqual(inactive.state.birthdayIds, []);

  const kept = reconcileState(created.state, 11, 7, [], ACTIVE_NOW + 2 * DAY_MS, () => 0);
  assert.equal(kept.changed, false);
  assert.equal(kept.state, created.state);

  const old: BirthdayState = {
    ...created.state,
    watchedIds: [smr],
    claimedIds: [yu],
    remindedYear: 2025,
  };
  const nextYear = Date.UTC(2027, 10, 6, 15, 0, 0, 0); // 2027-11-07 00:00 JST
  const reset = reconcileState(old, 11, 7, ['char-ai'], nextYear, () => 0);
  assert.equal(reset.changed, true);
  assert.equal(reset.state.eventYear, 2027);
  assert.deepEqual(reset.state.watchedIds, []);
  assert.deepEqual(reset.state.claimedIds, []);
  assert.equal(reset.state.remindedYear, 2025);
  assert.equal(reset.state.birthdayIds[0], birthdayIdOf('ai'));
  assert.equal(reset.state.birthdayIds.length, 3);

  const again = reconcileState(reset.state, 11, 7, [], nextYear + 1000, () => 0);
  assert.equal(again.changed, false);
  assert.equal(again.state, reset.state);
});

test('participant views follow the watched sequence', () => {
  const base = activeState();

  assert.deepEqual(unwatchedIds(base, 11, 7, ACTIVE_NOW), [smr, yu, rui]);
  assert.deepEqual(receivableIds(base, 11, 7, ACTIVE_NOW), []);
  assert.deepEqual(nextAdv(base, 11, 7, ACTIVE_NOW), {
    BirthdayId: smr,
    AdvAssetId: 'userhbd_01_smr',
  });

  const afterSmr: BirthdayState = { ...base, watchedIds: [smr] };
  assert.deepEqual(unwatchedIds(afterSmr, 11, 7, ACTIVE_NOW), [yu, rui]);
  assert.deepEqual(receivableIds(afterSmr, 11, 7, ACTIVE_NOW), [smr]);
  assert.deepEqual(nextAdv(afterSmr, 11, 7, ACTIVE_NOW), {
    BirthdayId: yu,
    AdvAssetId: 'userhbd_01_yu',
  });

  const afterYu: BirthdayState = { ...base, watchedIds: [smr, yu] };
  assert.deepEqual(unwatchedIds(afterYu, 11, 7, ACTIVE_NOW), [rui]);
  assert.deepEqual(receivableIds(afterYu, 11, 7, ACTIVE_NOW), [smr, yu]);

  const allWatched: BirthdayState = { ...base, watchedIds: [smr, yu, rui] };
  assert.deepEqual(unwatchedIds(allWatched, 11, 7, ACTIVE_NOW), []);
  assert.deepEqual(receivableIds(allWatched, 11, 7, ACTIVE_NOW), [smr, yu, rui]);
  assert.equal(nextAdv(allWatched, 11, 7, ACTIVE_NOW), undefined);

  const partlyClaimed: BirthdayState = { ...allWatched, claimedIds: [smr] };
  assert.deepEqual(receivableIds(partlyClaimed, 11, 7, ACTIVE_NOW), [yu, rui]);

  const allClaimed: BirthdayState = { ...allWatched, claimedIds: [smr, yu, rui] };
  assert.deepEqual(receivableIds(allClaimed, 11, 7, ACTIVE_NOW), []);
  assert.deepEqual(unwatchedIds(allClaimed, 11, 7, ACTIVE_NOW), []);
});

test('views are empty outside the active event window', () => {
  const state = activeState();
  for (const now of [BEFORE_WINDOW, AFTER_WINDOW]) {
    assert.deepEqual(unwatchedIds(state, 11, 7, now), []);
    assert.deepEqual(receivableIds(state, 11, 7, now), []);
    assert.equal(nextAdv(state, 11, 7, now), undefined);
    assert.equal(homeInfo(state, 11, 7, now), undefined);
  }
});

test('homeInfo tracks the remaining flags', () => {
  const base = activeState();
  assert.deepEqual(homeInfo(base, 11, 7, ACTIVE_NOW), {
    BannerAssetId: 'img_banner_l_user-birthday',
    Order: 1000,
    IsRemainingUnwatched: true,
    IsRemainingReceivableReward: false,
  });

  const afterSmr: BirthdayState = { ...base, watchedIds: [smr] };
  assert.equal(homeInfo(afterSmr, 11, 7, ACTIVE_NOW)?.IsRemainingUnwatched, true);
  assert.equal(homeInfo(afterSmr, 11, 7, ACTIVE_NOW)?.IsRemainingReceivableReward, true);

  const allWatched: BirthdayState = { ...base, watchedIds: [smr, yu, rui] };
  assert.equal(homeInfo(allWatched, 11, 7, ACTIVE_NOW)?.IsRemainingUnwatched, false);
  assert.equal(homeInfo(allWatched, 11, 7, ACTIVE_NOW)?.IsRemainingReceivableReward, true);

  const allClaimed: BirthdayState = {
    ...allWatched,
    claimedIds: [smr, yu, rui],
  };
  assert.equal(homeInfo(allClaimed, 11, 7, ACTIVE_NOW)?.IsRemainingUnwatched, false);
  assert.equal(homeInfo(allClaimed, 11, 7, ACTIVE_NOW)?.IsRemainingReceivableReward, false);
});

test('reminder is shown in the reminder week and suppressed once dismissed', () => {
  const state = activeState();
  const reminderWindow = Date.UTC(2026, 9, 30, 15, 0, 0, 0); // 2026-10-31 00:00 JST

  const shown = reminder(state, 11, 7, reminderWindow);
  assert.deepEqual(shown, {
    AssetId: 'user-birthday-advance-notice',
    Description: 'ご案内',
    LinkTitle: '注力アイドルを設定する',
    LinkType: 109,
  });

  assert.equal(reminder({ ...state, remindedYear: 2026 }, 11, 7, reminderWindow), undefined);
  assert.equal(reminder(state, 11, 7, ACTIVE_NOW), undefined);
});

test('catalogue has 20 codes and derives ids and texts', () => {
  assert.equal(BIRTHDAY_CODES_LIST.length, 20);
  assert.equal(birthdayIdOf('smr'), 'birthday-01-smr-01');
  assert.equal(advAssetIdOf('smr'), 'userhbd_01_smr');
  assert.equal(decorationIdOf('smr'), 'deco-user-birthday-smr-01');
  assert.equal(BIRTHDAY_CODES.smr, 'お兄ちゃん\nおめでと～！');
  assert.equal(codeOfBirthdayId('birthday-01-smr-01'), 'smr');
  assert.equal(codeOfBirthdayId('nope'), null);
});
