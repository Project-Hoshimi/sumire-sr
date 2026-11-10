import { eq } from 'drizzle-orm';
import { db } from '../db/client.ts';
import type { Executor } from '../db/tx.ts';
import { players } from '../db/schema.ts';
import { getArea, getCondition, listConditions } from '../master/index.ts';
import { getItemAmount } from './inventory.ts';
import { listElements } from './playerState.ts';
import type { Decoded } from '@sumire-sr/protocol/runtime/proto.ts';

/**
 * Subset port of Solis `viber.CommerceConditionEvaluator`
 * (commerce_conditions.go). Implements the setting kinds that quest areas,
 * quests, stories, the message/telephone narrative gates and the photo
 * catalogue reference: satisfyCondition, notSatisfyCondition, term,
 * managerLevel, clearQuest, clearMission, clearArea, readStory,
 * finishedMessage, reliability, obtainCharacter, obtainEmblem, tutorialStep,
 * itemAmount and satisfyConditions. Any other setting kind is indeterminate,
 * which — as in Solis — never counts as satisfied.
 */

const INDETERMINATE = 0;
const UNSATISFIED = 1;
const SATISFIED = 2;
type State = typeof INDETERMINATE | typeof UNSATISFIED | typeof SATISFIED;

const SUPPORTED_SETTINGS = new Set([
  'SatisfyCondition',
  'NotSatisfyCondition',
  'Term',
  'ManagerLevel',
  'ClearQuest',
  'ClearMission',
  'ClearArea',
  'ReadStory',
  'FinishedMessage',
  'Reliability',
  'ObtainCharacter',
  'ObtainEmblem',
  'TutorialStep',
  'ItemAmount',
  'SatisfyConditions',
]);

type Row = Record<string, unknown>;

export class ConditionEvaluator {
  private readonly playerId: string;
  private readonly now: number;
  private readonly exec: Executor;
  private readonly conditions = new Map<string, Row | null>();
  private readonly results = new Map<string, State>();
  private readonly evaluating = new Set<string>();
  private managerLevel: number | null = null;
  private areas: Map<string, Decoded> | null = null;
  private quests: Map<string, Decoded> | null = null;
  private missions: Map<string, Decoded> | null = null;
  private stories: Map<string, Decoded> | null = null;
  private messages: Map<string, Decoded> | null = null;
  private characters: Map<string, Decoded> | null = null;
  private emblems: Map<string, Decoded> | null = null;
  private tutorials: Map<string, Decoded> | null = null;

  constructor(playerId: string, now: number, exec: Executor = db) {
    this.playerId = playerId;
    this.now = now;
    this.exec = exec;
  }

  /** Solis `PrimeConditionIDs`: batch-load condition rows. */
  async prime(ids: string[]): Promise<void> {
    const missing = [...new Set(ids.filter((id) => id !== '' && !this.conditions.has(id)))];
    for (const row of await listConditions(missing)) this.conditions.set(String(row.Id), row as Row);
  }

  async satisfied(conditionId: string | null | undefined): Promise<boolean> {
    return (await this.evaluate(conditionId ?? '')) === SATISFIED;
  }

  /**
   * The master condition row for `id`, cached and lazily loaded. The narrative
   * reconciler walks unlock-condition dependencies through this accessor.
   */
  async conditionRow(id: string): Promise<Row | null> {
    if (id === '') return null;
    const cached = this.conditions.get(id);
    if (cached !== undefined) return cached;
    const row = ((await getCondition(id)) as Row | null) ?? null;
    this.conditions.set(id, row);
    return row;
  }

  private async evaluate(id: string): Promise<State> {
    if (id === '') return SATISFIED;
    const cached = this.results.get(id);
    if (cached !== undefined) return cached;
    if (this.evaluating.has(id)) return INDETERMINATE;
    const condition = await this.conditionRow(id);
    if (!condition) {
      this.results.set(id, INDETERMINATE);
      return INDETERMINATE;
    }
    this.evaluating.add(id);
    try {
      const settings = Array.isArray(condition.Settings) ? (condition.Settings as Row[]) : [];
      // Empty master conditions are unconditional.
      if (settings.length === 0) {
        this.results.set(id, SATISFIED);
        return SATISFIED;
      }
      let result: State = UNSATISFIED;
      for (const setting of settings) {
        const state = await this.evaluateSetting(setting);
        if (state === SATISFIED) {
          this.results.set(id, SATISFIED);
          return SATISFIED;
        }
        if (state === INDETERMINATE) result = INDETERMINATE;
      }
      this.results.set(id, result);
      return result;
    } finally {
      this.evaluating.delete(id);
    }
  }

  private async evaluateSetting(setting: Row): Promise<State> {
    if (Array.isArray(setting.__unknown) && setting.__unknown.length > 0) return INDETERMINATE;
    let result: State = SATISFIED;
    let hasKnownField = false;
    const merge = (next: State) => {
      if (result === UNSATISFIED || next === SATISFIED) return;
      result = next === UNSATISFIED ? UNSATISFIED : INDETERMINATE;
    };
    const value = (key: string) => (setting[key] && typeof setting[key] === 'object' ? (setting[key] as Row) : null);
    const n = (v: unknown) => Number(v ?? 0);

    const satisfy = value('SatisfyCondition');
    if (satisfy) {
      hasKnownField = true;
      if (!satisfy.ConditionId) return INDETERMINATE;
      merge(await this.evaluate(String(satisfy.ConditionId)));
    }
    const notSatisfy = value('NotSatisfyCondition');
    if (notSatisfy) {
      hasKnownField = true;
      if (!notSatisfy.ConditionId) return INDETERMINATE;
      const state = await this.evaluate(String(notSatisfy.ConditionId));
      merge(state === SATISFIED ? UNSATISFIED : state === UNSATISFIED ? SATISFIED : INDETERMINATE);
    }
    const term = value('Term');
    if (term) {
      hasKnownField = true;
      const after = n(term.NowAfter);
      const before = n(term.NowBefore);
      if (after <= 0 && before <= 0) return INDETERMINATE;
      if ((after > 0 && this.now < after) || (before > 0 && this.now > before)) merge(UNSATISFIED);
    }
    const manager = value('ManagerLevel');
    if (manager) {
      hasKnownField = true;
      const gte = n(manager.LevelGte);
      const lte = n(manager.LevelLte);
      if (gte <= 0 && lte <= 0) return INDETERMINATE;
      const level = await this.loadManagerLevel();
      if ((gte > 0 && level < gte) || (lte > 0 && level > lte)) merge(UNSATISFIED);
    }
    const clearQuest = value('ClearQuest');
    if (clearQuest) {
      hasKnownField = true;
      if (!clearQuest.QuestId) return INDETERMINATE;
      const quest = (await this.loadQuests()).get(String(clearQuest.QuestId));
      if (!quest || n(quest.LastClearedTime) <= 0) merge(UNSATISFIED);
    }
    const clearMission = value('ClearMission');
    if (clearMission) {
      hasKnownField = true;
      if (!clearMission.MissionId || n(clearMission.Threshold) <= 0) return INDETERMINATE;
      const mission = (await this.loadMissions()).get(String(clearMission.MissionId));
      if (!mission || n(mission.Progress) < n(clearMission.Threshold)) merge(UNSATISFIED);
    }
    const clearArea = value('ClearArea');
    if (clearArea) {
      hasKnownField = true;
      if (!clearArea.AreaId) return INDETERMINATE;
      merge(await this.hasClearedArea(String(clearArea.AreaId)));
    }
    const readStory = value('ReadStory');
    if (readStory) {
      hasKnownField = true;
      if (!readStory.StoryId) return INDETERMINATE;
      const story = (await this.loadStories()).get(String(readStory.StoryId));
      if (!story || n(story.StatusType) !== 2) merge(UNSATISFIED);
    }
    const finishedMessage = value('FinishedMessage');
    if (finishedMessage) {
      hasKnownField = true;
      if (!finishedMessage.MessageId) return INDETERMINATE;
      const message = (await this.loadMessages()).get(String(finishedMessage.MessageId));
      if (!message || n(message.MessageStatusType) !== 4) merge(UNSATISFIED);
    }
    const reliability = value('Reliability');
    if (reliability) {
      hasKnownField = true;
      if (!reliability.CharacterId || n(reliability.ReliabilityGte) <= 0) return INDETERMINATE;
      const character = (await this.loadCharacters()).get(String(reliability.CharacterId));
      if (!character || n(character.Reliability) < n(reliability.ReliabilityGte)) merge(UNSATISFIED);
    }
    const obtainCharacter = value('ObtainCharacter');
    if (obtainCharacter) {
      hasKnownField = true;
      if (!obtainCharacter.CharacterId) return INDETERMINATE;
      if (!(await this.loadCharacters()).has(String(obtainCharacter.CharacterId))) merge(UNSATISFIED);
    }
    const obtainEmblem = value('ObtainEmblem');
    if (obtainEmblem) {
      hasKnownField = true;
      if (!obtainEmblem.EmblemId) return INDETERMINATE;
      if (!(await this.loadEmblems()).has(String(obtainEmblem.EmblemId))) merge(UNSATISFIED);
    }
    const tutorialStep = value('TutorialStep');
    if (tutorialStep) {
      hasKnownField = true;
      const type = n(tutorialStep.TutorialType);
      if (type <= 0) return INDETERMINATE;
      const gte = n(tutorialStep.StepGte);
      const lte = n(tutorialStep.StepLte);
      const tutorial = (await this.loadTutorials()).get(String(type));
      if (!tutorial) {
        merge(UNSATISFIED);
      } else {
        const step = n(tutorial.Step);
        if ((gte > 0 && step < gte) || (lte > 0 && step > lte)) merge(UNSATISFIED);
      }
    }
    const itemAmount = value('ItemAmount');
    if (itemAmount) {
      hasKnownField = true;
      if (!itemAmount.ItemId) return INDETERMINATE;
      const amount = await getItemAmount(this.playerId, String(itemAmount.ItemId), this.exec);
      if (amount < n(itemAmount.AmountGte)) merge(UNSATISFIED);
    }
    const satisfyConditions = value('SatisfyConditions');
    if (satisfyConditions) {
      hasKnownField = true;
      const conditions = Array.isArray(satisfyConditions.Conditions)
        ? (satisfyConditions.Conditions as Row[])
        : [];
      if (conditions.length === 0) return INDETERMINATE;
      let state: State = SATISFIED;
      for (const condition of conditions) {
        if (!condition.ConditionId) return INDETERMINATE;
        const next = await this.evaluate(String(condition.ConditionId));
        if (next === UNSATISFIED) {
          state = UNSATISFIED;
          break;
        }
        if (next === INDETERMINATE) state = INDETERMINATE;
      }
      merge(state);
    }
    for (const key of Object.keys(setting)) {
      if (key.startsWith('__')) continue;
      if (setting[key] != null && !SUPPORTED_SETTINGS.has(key)) merge(INDETERMINATE);
    }
    return hasKnownField ? result : INDETERMINATE;
  }

  private async hasClearedArea(areaId: string): Promise<State> {
    const area = (await this.loadAreas()).get(areaId);
    if (!area) return UNSATISFIED;
    const master = await getArea(areaId);
    if (!master) return INDETERMINATE;
    const questIds = Array.isArray(master.QuestIds) ? master.QuestIds : [];
    if (questIds.length === 0) return Number(area.LastClearedTime ?? 0) > 0 ? SATISFIED : UNSATISFIED;
    return Number(area.ClearQuestCount ?? 0) < questIds.length ? UNSATISFIED : SATISFIED;
  }

  // Manager level lives on the players row (addManagerExp updates it there).
  private async loadManagerLevel(): Promise<number> {
    if (this.managerLevel === null) {
      const [row] = await this.exec.select({ level: players.level }).from(players).where(eq(players.id, this.playerId));
      this.managerLevel = Number(row?.level ?? 0);
    }
    return this.managerLevel;
  }

  private async loadAreas() {
    this.areas ??= await this.keyed('Areas', 'AreaId');
    return this.areas;
  }

  private async loadQuests() {
    this.quests ??= await this.keyed('Quests', 'QuestId');
    return this.quests;
  }

  private async loadMissions() {
    this.missions ??= await this.keyed('Missions', 'MissionId');
    return this.missions;
  }

  private async loadStories() {
    this.stories ??= await this.keyed('Stories', 'StoryId');
    return this.stories;
  }

  private async loadMessages() {
    this.messages ??= await this.keyed('Messages', 'MessageId');
    return this.messages;
  }

  private async loadCharacters() {
    this.characters ??= await this.keyed('Characters', 'CharacterId');
    return this.characters;
  }

  private async loadEmblems() {
    this.emblems ??= await this.keyed('Emblems', 'EmblemId');
    return this.emblems;
  }

  private async loadTutorials() {
    this.tutorials ??= await this.keyed('Tutorials', 'TutorialType');
    return this.tutorials;
  }

  private async keyed(kind: string, key: string): Promise<Map<string, Decoded>> {
    return new Map((await listElements(this.playerId, kind, this.exec)).map((row) => [String(row[key]), row]));
  }
}
