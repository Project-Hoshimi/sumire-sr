// Marathon owned live-bonus effects. Pure unit tests; no database.
//
//   node --test src/services/marathon/liveBonusEffect.test.ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { PhotoAbilityType } from '../../live/enums.ts';
import { maxActorSkills } from '../../live/engine.ts';
import type { LiveDeckCardSkill } from '../../live/types.ts';
import { BONUS_SKILL_MARATHON_INDEX_BASE, addBonusSkillPassives, addLiveDeckBonuses } from '../liveInput.ts';
import {
  marathonBonusEffects,
  marathonLiveAbilityLevel,
  marathonPassiveEffects,
} from './liveBonusEffect.ts';

test('marathonBonusEffects stacks each owned copy by Amount', () => {
  const effects = marathonBonusEffects([{ LiveBonusId: 'bonus-a', Amount: 3 }], (id) =>
    id === 'bonus-a' ? { type: 1, value: 5 } : undefined,
  );
  assert.deepEqual(effects, [{ type: 1, value: 15 }]);
});

test('marathonBonusEffects ignores zero and negative amounts', () => {
  const lookup = () => ({ type: 1, value: 5 });
  assert.deepEqual(
    marathonBonusEffects(
      [
        { LiveBonusId: 'bonus-a', Amount: 0 },
        { LiveBonusId: 'bonus-b', Amount: -2 },
      ],
      lookup,
    ),
    [],
  );
});

test('marathonLiveAbilityLevel selects the row with the requested Level', () => {
  const levels = [
    { Level: 1, Type: 1, Value: 3, SkillId: '' },
    { Level: 2, Type: 4, Value: 7, SkillId: '' },
  ];
  assert.deepEqual(marathonLiveAbilityLevel(levels, 2), {
    type: 4,
    value: 7,
    level: 2,
    skillId: '',
  });
  assert.equal(marathonLiveAbilityLevel(levels, 9), undefined);
  assert.equal(marathonLiveAbilityLevel(null, 1), undefined);
});

test('marathonLiveAbilityLevel keeps the passive skill id and level', () => {
  const levels = [
    { Level: 1, Type: 13, Value: 2, SkillId: 'skl-passive' },
    { Level: 2, Type: 13, Value: 4, SkillId: 'skl-passive' },
  ];
  assert.deepEqual(marathonLiveAbilityLevel(levels, 2), {
    type: 13,
    value: 4,
    level: 2,
    skillId: 'skl-passive',
  });
});

test('level selection reaches the effect value', () => {
  const levels = [
    { Level: 1, Type: 1, Value: 3 },
    { Level: 2, Type: 4, Value: 7 },
  ];
  const lookup = (id: string) => (id === 'bonus-a' ? marathonLiveAbilityLevel(levels, 2) : undefined);
  assert.deepEqual(marathonBonusEffects([{ LiveBonusId: 'bonus-a', Amount: 2 }], lookup), [
    { type: 4, value: 14 },
  ]);
});

test('marathonBonusEffects merges effects of the same type by summing', () => {
  const lookup = (id: string) => {
    if (id === 'bonus-a') return { type: 3, value: 4 };
    if (id === 'bonus-b') return { type: 3, value: 6 };
    return undefined;
  };
  assert.deepEqual(
    marathonBonusEffects(
      [
        { LiveBonusId: 'bonus-a', Amount: 2 },
        { LiveBonusId: 'bonus-b', Amount: 1 },
      ],
      lookup,
    ),
    [{ type: 3, value: 14 }],
  );
});

test('marathonBonusEffects ignores unknown ids', () => {
  assert.deepEqual(marathonBonusEffects([{ LiveBonusId: 'bonus-missing', Amount: 1 }], () => undefined), []);
});

// Passive skills (type 13) are not card bonus-map entries: they go through
// `marathonPassiveEffects` into the owned-ability passive list instead.
test('marathonBonusEffects excludes passive skills', () => {
  const lookup = (id: string) =>
    id === 'bonus-passive'
      ? { type: 13, value: 3, level: 1, skillId: 'skl-passive' }
      : { type: 1, value: 2 };
  assert.deepEqual(
    marathonBonusEffects(
      [
        { LiveBonusId: 'bonus-passive', Amount: 4 },
        { LiveBonusId: 'bonus-dance', Amount: 1 },
      ],
      lookup,
    ),
    [{ type: 1, value: 2 }],
  );
});

test('marathonPassiveEffects resolves type-13 rows with the live ability id', () => {
  const levels = [{ Level: 2, Type: 13, Value: 4, SkillId: 'skl-passive' }];
  const lookup = (id: string) =>
    id === 'bonus-passive'
      ? { ...marathonLiveAbilityLevel(levels, 2)!, liveAbilityId: 'lba-passive' }
      : undefined;
  assert.deepEqual(marathonPassiveEffects([{ LiveBonusId: 'bonus-passive', Amount: 1 }], lookup), [
    {
      skillId: 'skl-passive',
      skillLevel: 4,
      amount: 1,
      liveAbilityId: 'lba-passive',
      liveAbilityLevel: 2,
    },
  ]);
});

test('marathonPassiveEffects stacks copies and merges identical rows', () => {
  const lookup = (id: string) =>
    id === 'bonus-a' || id === 'bonus-b'
      ? { type: 13, value: 4, level: 2, skillId: 'skl-passive', liveAbilityId: 'lba-passive' }
      : undefined;
  assert.deepEqual(
    marathonPassiveEffects(
      [
        { LiveBonusId: 'bonus-a', Amount: 2 },
        { LiveBonusId: 'bonus-b', Amount: 3 },
      ],
      lookup,
    ),
    [
      {
        skillId: 'skl-passive',
        skillLevel: 4,
        amount: 5,
        liveAbilityId: 'lba-passive',
        liveAbilityLevel: 2,
      },
    ],
  );
});

test('marathonPassiveEffects ignores non-passive, unknown and empty rows', () => {
  assert.deepEqual(
    marathonPassiveEffects([{ LiveBonusId: 'bonus-dance', Amount: 2 }], () => ({
      type: 1,
      value: 5,
      level: 1,
      skillId: '',
    })),
    [],
  );
  assert.deepEqual(marathonPassiveEffects([{ LiveBonusId: 'bonus-missing', Amount: 1 }], () => undefined), []);
  assert.deepEqual(
    marathonPassiveEffects([{ LiveBonusId: 'bonus-empty', Amount: 1 }], () => ({
      type: 13,
      value: 3,
      level: 1,
      skillId: '',
    })),
    [],
  );
});

// `prepareLiveInput` copies this map into every player deck card, so adding the
// effect once here reaches every deck card before `applyLiveCardStats`.
test('addLiveDeckBonuses adds a parameter effect to the deck bonus map', () => {
  const bonus = new Map<number, number>();
  const { applied, skipped } = addLiveDeckBonuses(bonus, [{ type: 1, value: 4 }]);
  assert.equal(applied, 1);
  assert.deepEqual(skipped, []);
  assert.equal(bonus.get(PhotoAbilityType.DanceAdd), 4);
});

test('addLiveDeckBonuses accumulates onto existing card bonuses', () => {
  const bonus = new Map<number, number>([[PhotoAbilityType.DanceAdd, 2]]);
  addLiveDeckBonuses(bonus, [{ type: 1, value: 4 }]);
  assert.equal(bonus.get(PhotoAbilityType.DanceAdd), 6);
});

test('addLiveDeckBonuses skips unsupported types once each', () => {
  const bonus = new Map<number, number>();
  const { applied, skipped } = addLiveDeckBonuses(bonus, [
    { type: 13, value: 5 }, // PassiveSkill
    { type: 25, value: 2 }, // AccessoryParameterUp
    { type: 26, value: 1 }, // PhotoLevelUp
    { type: 99, value: 7 }, // unknown
    { type: 3, value: 9 }, // VocalAdd
  ]);
  assert.equal(applied, 1);
  assert.deepEqual(skipped, [13, 25, 26, 99]);
  assert.deepEqual([...bonus], [[PhotoAbilityType.VocalAdd, 9]]);
});

test('addLiveDeckBonuses handles an empty effect list', () => {
  const bonus = new Map<number, number>([[PhotoAbilityType.VocalAdd, 1]]);
  const { applied, skipped } = addLiveDeckBonuses(bonus, []);
  assert.equal(applied, 0);
  assert.deepEqual(skipped, []);
  assert.deepEqual([...bonus], [[PhotoAbilityType.VocalAdd, 1]]);
});

// Matches `POSSESSION.Quest` in liveInput.ts; the engine treats synthetic
// BonusSkills actors identically for every possession type.
const QUEST_POSSESSION = 4;

// Marathon passives are deck-level event bonuses: `prepareLiveInput` appends
// them to the player's `UserDeck.BonusSkills`, one entry per owned copy, starting
// at 4001 so they never collide with the quest bonus range (3001 + i).
test('addBonusSkillPassives appends one BonusSkills entry per owned copy', () => {
  const skills: LiveDeckCardSkill[] = [];
  const { applied, skipped } = addBonusSkillPassives(skills, [
    {
      skillId: 'skl-passive',
      skillLevel: 4,
      amount: 3,
      liveAbilityId: 'lba-passive',
      liveAbilityLevel: 2,
    },
  ]);
  assert.equal(applied, 3);
  assert.equal(skipped, 0);
  assert.deepEqual(skills, [
    {
      Index: 4001,
      SkillId: 'skl-passive',
      SkillLevel: 4,
      PossessionType: QUEST_POSSESSION,
      LiveAbilityId: 'lba-passive',
      LiveAbilityLevel: 2,
    },
    {
      Index: 4002,
      SkillId: 'skl-passive',
      SkillLevel: 4,
      PossessionType: QUEST_POSSESSION,
      LiveAbilityId: 'lba-passive',
      LiveAbilityLevel: 2,
    },
    {
      Index: 4003,
      SkillId: 'skl-passive',
      SkillLevel: 4,
      PossessionType: QUEST_POSSESSION,
      LiveAbilityId: 'lba-passive',
      LiveAbilityLevel: 2,
    },
  ]);
});

test('addBonusSkillPassives keeps quest bonus skills and appends after them', () => {
  const skills: LiveDeckCardSkill[] = [
    {
      Index: 3001,
      SkillId: 'skl-quest',
      SkillLevel: 1,
      PossessionType: QUEST_POSSESSION,
      LiveAbilityId: 'lba-quest',
      LiveAbilityLevel: 1,
    },
  ];
  addBonusSkillPassives(skills, [
    { skillId: 'skl-marathon', skillLevel: 2, amount: 2, liveAbilityId: 'lba-marathon', liveAbilityLevel: 1 },
  ]);
  assert.deepEqual(skills.map((ref) => ref.Index), [3001, 4001, 4002]);
  assert.deepEqual(skills.map((ref) => ref.SkillId), ['skl-quest', 'skl-marathon', 'skl-marathon']);
});

test('addBonusSkillPassives skips indices already in the list', () => {
  const skills: LiveDeckCardSkill[] = [
    { Index: 4001, SkillId: 'skl-existing', SkillLevel: 1, PossessionType: QUEST_POSSESSION },
  ];
  const { applied } = addBonusSkillPassives(skills, [
    { skillId: 'skl-marathon', skillLevel: 2, amount: 2 },
  ]);
  assert.equal(applied, 2);
  assert.deepEqual(skills.map((ref) => ref.Index), [4001, 4002, 4003]);
});

test('addBonusSkillPassives skips empty ids, non-positive levels and zero amounts', () => {
  const skills: LiveDeckCardSkill[] = [];
  const { applied, skipped } = addBonusSkillPassives(skills, [
    { skillId: '', skillLevel: 2, amount: 1 },
    { skillId: 'skl-passive', skillLevel: 0, amount: 1 },
    { skillId: 'skl-passive', skillLevel: 2, amount: 0 },
  ]);
  assert.equal(applied, 0);
  assert.equal(skipped, 3);
  assert.deepEqual(skills, []);
});

test('addBonusSkillPassives handles an empty effect list', () => {
  const skills: LiveDeckCardSkill[] = [];
  assert.deepEqual(addBonusSkillPassives(skills, []), { applied: 0, skipped: 0, dropped: 0 });
  assert.deepEqual(skills, []);
});

// The engine registers all of `UserDeck.BonusSkills` as one synthetic actor and
// throws 'too many live skills' above `maxActorSkills`, so the helper must stop
// appending at the cap instead of letting the live fail.
test('addBonusSkillPassives stops at the engine actor skill cap and reports dropped copies', () => {
  const existing = maxActorSkills - 1;
  const skills: LiveDeckCardSkill[] = Array.from({ length: existing }, (_, i) => ({
    Index: 3001 + i,
    SkillId: 'skl-quest',
    SkillLevel: 1,
    PossessionType: QUEST_POSSESSION,
  }));
  const { applied, skipped, dropped } = addBonusSkillPassives(skills, [
    { skillId: 'skl-a', skillLevel: 1, amount: 2 },
    { skillId: 'skl-b', skillLevel: 1, amount: 3 },
  ]);
  assert.equal(applied, 1);
  assert.equal(skipped, 0);
  assert.equal(dropped, 4);
  assert.equal(skills.length, maxActorSkills);
  assert.deepEqual(
    skills.slice(existing).map((ref) => ref.Index),
    [BONUS_SKILL_MARATHON_INDEX_BASE],
  );
  assert.deepEqual(
    skills.slice(existing).map((ref) => ref.SkillId),
    ['skl-a'],
  );
});

test('addBonusSkillPassives drops every copy when the list already meets the cap', () => {
  const skills: LiveDeckCardSkill[] = Array.from({ length: maxActorSkills }, (_, i) => ({
    Index: 3001 + i,
    SkillId: 'skl-quest',
    SkillLevel: 1,
    PossessionType: QUEST_POSSESSION,
  }));
  const { applied, skipped, dropped } = addBonusSkillPassives(skills, [
    { skillId: 'skl-a', skillLevel: 1, amount: 2 },
  ]);
  assert.equal(applied, 0);
  assert.equal(skipped, 0);
  assert.equal(dropped, 2);
  assert.equal(skills.length, maxActorSkills);
});
