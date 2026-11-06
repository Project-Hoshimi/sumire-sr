// MoshiKoi catalog loader and route engine tests. Pure unit tests: the JSON
// data ships with the server and no database or game master data is required.
//
//   node --test src/services/moshikoi/moshikoi.test.ts
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MoshikoiError,
  episodeIdPrefix,
  firstEpisodeId,
  loveConfig,
  loveRoutes,
  supportedLoveIds,
} from './catalog.ts';
import {
  allEndingsUnlocked,
  branchInfos,
  choiceInfos,
  favorability,
  resolve,
  routeConditionsMatch,
  routePoints,
  selectChoices,
  type LoveStorySelection,
} from './routes.ts';

const LOVE_ID = 'love-23-0514';
const EP = (n: string) => `${episodeIdPrefix(LOVE_ID)}${n}`;

function selection(episode: string, groupIndex: number, index: number): LoveStorySelection {
  return { storyEpisodeId: episode, groupIndex, index };
}

test('every catalog and route file loads and validates', () => {
  assert.deepEqual(supportedLoveIds(), [
    'love-23-0514',
    'love-23-1114',
    'love-24-0517',
    'love-24-1114',
    'love-extra-25-0426',
    'love-26-0313',
  ]);

  for (const loveId of supportedLoveIds()) {
    const config = loveConfig(loveId);
    assert.equal(config.loveId, loveId);
    assert.ok(config.name.length > 0);
    assert.ok(config.storyReadItemId.length > 0);

    const routes = loveRoutes(loveId);
    assert.equal(routes.loveId, loveId);
    assert.ok(routes.episodes[firstEpisodeId(loveId)], `${loveId} has a first episode`);
    assert.ok(routes.endings.length > 0, `${loveId} has endings`);
  }
});

test('catalog defaults match solis', () => {
  const standard = loveConfig(LOVE_ID);
  assert.equal(standard.baseType, 1);
  assert.equal(standard.assetId, LOVE_ID);
  assert.equal(standard.expAssetId, `exp-${LOVE_ID}`);
  assert.equal(standard.simpleName, 'もし恋');

  const extra = loveConfig('love-extra-25-0426');
  assert.equal(extra.baseType, 2);
  assert.equal(extra.presentItemId, '');
  assert.equal(extra.assetId, 'love-25-0426');
  assert.equal(extra.mainCharacters.length, 4);
});

test('love-23-0514 choice path resolves to the next episode', () => {
  const routes = loveRoutes(LOVE_ID);
  const first = selectChoices(routes, EP('001'), [
    { groupIndex: 1, index: 2, isValid: true },
    { groupIndex: 2, index: 1, isValid: true },
  ]);
  assert.deepEqual(first, [selection(EP('001'), 1, 2), selection(EP('001'), 2, 1)]);

  const result = resolve(routes, EP('001'), first);
  assert.deepEqual(result, { nextEpisodeId: EP('002'), endingId: '' });
  assert.equal(favorability(routes, first), 35);
});

test('love-23-0514 choice path resolves to a specific ending', () => {
  const routes = loveRoutes(LOVE_ID);
  const first = selectChoices(routes, EP('001'), [
    { groupIndex: 1, index: 1, isValid: true },
    { groupIndex: 2, index: 2, isValid: true },
  ]);
  assert.deepEqual(resolve(routes, EP('001'), first), {
    nextEpisodeId: '',
    endingId: 'love-end-love-23-0514-001-bad',
  });
  assert.equal(favorability(routes, first), -35);

  // TRUE end: episode 7's happy outcome needs all earlier flags; the ending
  // episode then selects happy-002.
  const happySelections: LoveStorySelection[] = [
    selection(EP('003'), 1, 1),
    selection(EP('004'), 1, 1),
    selection(EP('004'), 2, 2),
    selection(EP('005'), 2, 2),
    selection(EP('006'), 1, 2),
    selection(EP('006'), 2, 2),
    selection(EP('006'), 3, 1),
    selection(EP('007'), 1, 2),
    selection(EP('007'), 2, 1),
  ];
  assert.deepEqual(resolve(routes, EP('007'), happySelections), {
    nextEpisodeId: EP('008-happy'),
    endingId: '',
  });

  const final = selectChoices(routes, EP('008-happy'), [
    { groupIndex: 1, index: 2, isValid: true },
  ]);
  assert.deepEqual(resolve(routes, EP('008-happy'), final), {
    nextEpisodeId: '',
    endingId: 'love-end-love-23-0514-008-happy-002',
  });
});

test('love-23-0514 rejects invalid and unreachable selections', () => {
  const routes = loveRoutes(LOVE_ID);

  assert.throws(
    () => selectChoices(routes, 'love-event-story-unknown-001', []),
    (error: unknown) =>
      error instanceof MoshikoiError && error.code === 'unknown-love-story-episode',
  );
  assert.throws(
    () => selectChoices(routes, EP('001'), [{ groupIndex: 1, index: 3, isValid: true }]),
    (error: unknown) => error instanceof MoshikoiError && error.code === 'invalid-story-choice',
  );
  assert.throws(
    () => selectChoices(routes, EP('001'), [null]),
    (error: unknown) => error instanceof MoshikoiError && error.code === 'missing-story-choice',
  );
  assert.throws(
    () =>
      selectChoices(routes, EP('001'), [
        { groupIndex: 1, index: 1, isValid: true },
        { groupIndex: 1, index: 2, isValid: true },
      ]),
    (error: unknown) =>
      error instanceof MoshikoiError && error.code === 'multiple-active-choices-for-one-group',
  );
  // Episode 7 group 2 exists only when group 1 choice 2 was selected.
  assert.throws(
    () =>
      selectChoices(routes, EP('007'), [
        { groupIndex: 1, index: 1, isValid: true },
        { groupIndex: 2, index: 1, isValid: true },
      ]),
    (error: unknown) =>
      error instanceof MoshikoiError && error.code === 'missing-or-unreachable-story-choice',
  );
  // History entries with isValid=false are ignored and do not count as choices.
  assert.deepEqual(
    selectChoices(routes, EP('001'), [
      { groupIndex: 1, index: 1, isValid: false },
      { groupIndex: 1, index: 2, isValid: true },
      { groupIndex: 2, index: 1, isValid: true },
    ]),
    [selection(EP('001'), 1, 2), selection(EP('001'), 2, 1)],
  );
});

test('choice infos expose hint levels and past selections', () => {
  const routes = loveRoutes(LOVE_ID);

  const plain = choiceInfos(routes, EP('001'), [], 0);
  assert.equal(plain.length, 2);
  assert.deepEqual(
    plain.map((group) => group.GroupIndex),
    [1, 2],
  );
  assert.equal(plain[0]!.ExistsObtainableFavorabilityDifference, false);
  assert.deepEqual(
    plain[0]!.StoryChoiceInfos.map((choice) => choice.Index),
    [1, 2],
  );
  assert.equal(
    plain[0]!.StoryChoiceInfos.every((choice) => choice.IsBestObtainableFavorability === false),
    true,
  );

  const hinted = choiceInfos(routes, EP('001'), [selection(EP('001'), 1, 1)], 2);
  assert.equal(hinted[0]!.ExistsObtainableFavorabilityDifference, true);
  assert.deepEqual(
    hinted[0]!.StoryChoiceInfos.map((choice) => choice.IsBestObtainableFavorability),
    [false, true],
  );
  assert.deepEqual(
    hinted[0]!.StoryChoiceInfos.map((choice) => choice.IsPastSelected),
    [true, false],
  );
  assert.equal(hinted[0]!.__msg, 'Solis.Common.Proto.Api.LoveStoryChoiceGroupInfo');
  assert.equal(hinted[0]!.StoryChoiceInfos[0]!.__msg, 'Solis.Common.Proto.Api.LoveStoryChoiceInfo');

  // Group 2's best choice is 1 (see the route data).
  assert.deepEqual(
    hinted[1]!.StoryChoiceInfos.map((choice) => choice.IsBestObtainableFavorability),
    [true, false],
  );
});

test('branch infos follow the episode-7 branch conditions', () => {
  const routes = loveRoutes(LOVE_ID);
  const matched = branchInfos(routes, EP('007'), [selection(EP('006'), 2, 2)]);
  assert.deepEqual(matched, [
    { __msg: 'Solis.Common.Proto.Api.LoveAdvBranchInfo', GroupIndex: 1, Index: 1 },
  ]);

  const unmatched = branchInfos(routes, EP('007'), [selection(EP('006'), 2, 1)]);
  assert.deepEqual(unmatched, [
    { __msg: 'Solis.Common.Proto.Api.LoveAdvBranchInfo', GroupIndex: 1, Index: 2 },
  ]);

  assert.deepEqual(branchInfos(routes, EP('001'), []), []);
});

test('allEndingsUnlocked requires every ending id and a non-empty list', () => {
  const routes = loveRoutes(LOVE_ID);
  const ids = routes.endings.map((ending) => ending.id);
  assert.equal(allEndingsUnlocked(routes, ids), true);
  assert.equal(allEndingsUnlocked(routes, ids.slice(1)), false);
  assert.equal(allEndingsUnlocked(routes, []), false);
});

test('route points drive min/max outcomes independently of favorability', () => {
  const routes = loveRoutes('love-26-0313');
  const prefix = episodeIdPrefix('love-26-0313');
  const ep = (n: string) => `${prefix}${n}`;

  assert.equal(routePoints(routes, [selection(ep('001'), 1, 2)]), 2);

  // Episode 7: maxPoints 1 -> happy, minPoints 11 -> bad, otherwise normal.
  const lowPoints = [selection(ep('007'), 1, 1), selection(ep('007'), 2, 1)];
  assert.deepEqual(resolve(routes, ep('007'), lowPoints), {
    nextEpisodeId: ep('008-happy'),
    endingId: '',
  });

  const highPoints = [
    selection(ep('001'), 1, 2),
    selection(ep('003'), 1, 1),
    selection(ep('003'), 2, 1),
    selection(ep('004'), 1, 1),
    selection(ep('005'), 1, 1),
    selection(ep('006'), 2, 2),
    selection(ep('006'), 3, 1),
    selection(ep('007'), 2, 2),
  ];
  assert.equal(routePoints(routes, highPoints), 14);
  assert.deepEqual(resolve(routes, ep('007'), highPoints), {
    nextEpisodeId: ep('008-bad'),
    endingId: '',
  });
});

test('route conditions treat an empty episode as the current episode', () => {
  assert.equal(routeConditionsMatch(EP('001'), [], []), true);
  assert.equal(
    routeConditionsMatch(EP('001'), [{ episode: '', group: 1, choice: 2 }], [
      selection(EP('001'), 1, 2),
    ]),
    true,
  );
  assert.equal(
    routeConditionsMatch(EP('001'), [{ episode: EP('002'), group: 1, choice: 2 }], [
      selection(EP('001'), 1, 2),
    ]),
    false,
  );
});
