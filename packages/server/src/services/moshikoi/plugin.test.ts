// Moshikoi event plugin tests. No database: the plugin's import source is the
// checked-in catalog/routes JSON, and the registry is never initialised here, so
// `loveConfig`/`loveRoutes` use the file path.
//
//   node --test src/services/moshikoi/plugin.test.ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { firstEpisodeId, loveConfig, loveRoutes, supportedLoveIds } from './catalog.ts';
import { moshikoiPlugin, type MoshikoiDraft } from './plugin.ts';

test('every checked-in catalog imports, validates and compiles to the file runtime', async () => {
  const ids = supportedLoveIds();
  assert.equal(ids.length, 6);
  for (const id of ids) {
    const draft = await moshikoiPlugin.importFromMaster(id);
    assert.equal(draft.id, id);
    assert.equal(draft.catalog.loveId, id);
    assert.equal(draft.routes.loveId, id);
    assert.ok(draft.title.length > 0, `${id} has a title`);

    const issues = moshikoiPlugin.validate(draft);
    assert.deepEqual(
      issues.filter((issue) => issue.severity === 'error'),
      [],
      `${id} validates`,
    );

    const runtime = moshikoiPlugin.compile(draft);
    assert.deepEqual(runtime.config, loveConfig(id), `${id} config matches the file loader`);
    assert.deepEqual(runtime.routes, loveRoutes(id), `${id} routes match the file loader`);
  }
});

test('validate reports a dangling next reference as a route error', async () => {
  const loveId = 'love-23-0514';
  const draft: MoshikoiDraft = structuredClone(await moshikoiPlugin.importFromMaster(loveId));
  const episodes = draft.routes.episodes as Record<string, { next: string }>;
  const episode = episodes[firstEpisodeId(loveId)];
  assert.ok(episode, 'first episode exists');
  episode.next = `${firstEpisodeId(loveId).slice(0, -3)}999`;

  const issues = moshikoiPlugin.validate(draft);
  const errors = issues.filter((issue) => issue.severity === 'error');
  assert.equal(errors.length, 1, JSON.stringify(issues));
  assert.equal(errors[0]?.path, 'routes');
  assert.match(errors[0]?.message ?? '', /invalid next love episode/);
});

test('validate reports a missing required catalog field at catalog.<field>', async () => {
  const draft: MoshikoiDraft = structuredClone(
    await moshikoiPlugin.importFromMaster('love-24-1114'),
  );
  delete draft.catalog.name;

  const issues = moshikoiPlugin.validate(draft);
  const errors = issues.filter((issue) => issue.severity === 'error');
  assert.equal(errors.length, 1, JSON.stringify(issues));
  assert.equal(errors[0]?.path, 'catalog.name');
  assert.match(errors[0]?.message ?? '', /invalid catalog/);
});

test('stateImpact warns about episodes and endings dropped from the draft', async () => {
  const loveId = 'love-23-1114';
  const draft = await moshikoiPlugin.importFromMaster(loveId);
  const published: MoshikoiDraft = structuredClone(draft);

  const episodes = published.routes.episodes as Record<string, unknown>;
  const removedEpisodeId = `${firstEpisodeId(loveId).slice(0, -3)}999`;
  episodes[removedEpisodeId] = structuredClone(episodes[firstEpisodeId(loveId)]);

  const endings = published.routes.endings as { id: string }[];
  const removedEnding = endings[0];
  assert.ok(removedEnding, 'the route map has an ending');
  draft.routes.endings = endings.slice(1);

  const impacts = moshikoiPlugin.stateImpact(published, draft);
  const episodeImpact = impacts.find((impact) => impact.code === 'moshikoi-episode-removed');
  assert.ok(episodeImpact, JSON.stringify(impacts));
  assert.equal(episodeImpact.severity, 'warn');
  assert.equal(episodeImpact.requiresPlayerCheck, false);

  const endingImpact = impacts.find((impact) => impact.code === 'moshikoi-ending-removed');
  assert.ok(endingImpact, JSON.stringify(impacts));
  assert.equal(endingImpact.severity, 'warn');
  assert.equal(endingImpact.requiresPlayerCheck, false);
});

test('a permanent moshikoi draft has no schedule', async () => {
  assert.equal(moshikoiPlugin.lifecycle, 'permanent');
  const draft = await moshikoiPlugin.importFromMaster('love-26-0313');
  assert.equal(moshikoiPlugin.draftSchedule(draft), undefined);
});
