#!/usr/bin/env python3
"""Phase A2 — make the story-relevant gacha banners and the photo mode
shootings always viewable.

The client hides a gacha banner unless its `ViewConditionId` condition's
`Term.NowBefore` is in the future. The listed banners (the Memorial banners)
would therefore disappear once their official window ends. This
rewrites ONLY those condition rows in the served `Condition` SQLCipher master to
the official permanent format (real start, `NowBefore` 0) so every banner shows
with no remaining time, then refreshes the manifest version so the client
re-syncs.

Photo mode works the same way: a photo shooting row (quest music/stage, the
Pose/Work activities, expressions, contest entries) whose
view/unlock condition (directly or through a SatisfyCondition) carries an
expired `Term.NowBefore` shows a closed shooting with 0 time remaining. Photo
shootings and the Photo Album event's view/play/story conditions use the same
official permanent format, so they show with no remaining time.

Requires: sqlcipher3 (Python), npx tsx (proto decode/encode helper).
"""
import base64
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import time

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.dirname(os.path.dirname(SCRIPT_DIR))
BASE = os.path.join(os.environ.get('SUMIRE_DATA_DIR') or REPO_ROOT, 'phaseA2')
ACTIVE_GACHA_IDS = {
    # Memorial banners (2026-10-30) + sandbox collab/excursion/premium memorials
    'gacha-birthday-26-1030-01',
    'gacha-fes-26-1030-01',
    'gacha-limited-26-1030-01',
    'gacha-limited-26-1030-02',
    'gacha-link-26-1030-01',
    'gacha-normal-26-1030-01',
    'gacha-sandbox-collab-memorial',
    'gacha-sandbox-excursion-memorial',
    'gacha-sandbox-premium-memorial',
}
# The Photo Album event's view/play/story gates. These use the official
# permanent format (real start, NowBefore 0) so the album shows with no
# remaining time.
# Matches SANDBOX_SHELF_START in fastify-api/src/profiles/sandbox/shelf.ts.
SHELF_START = 1790910000000
SHELF_PERMANENT_CONDITIONS = {
    'cd-shelf-26-1002': SHELF_START,
    'cd-shelf-26-1002-play': SHELF_START,
    'cd-shelf-26-1002-story': SHELF_START,
}
# Original start (earliest NowAfter) of every photo shooting condition that had
# expired, recovered from the pre-patch master (commit f251154); vendored
# because the patched master no longer shows them as expired.
PHOTO_PERMANENT_CONDITIONS = json.load(open(f'{BASE}/import/photo_permanent_conditions.json'))
# Original start of every story gacha banner's ViewConditionId, recovered from
# the initial import (commit cf4469e) and the 2026-10-30 memorial import.
GACHA_PERMANENT_CONDITIONS = json.load(open(f'{BASE}/import/gacha_permanent_conditions.json'))

BLOB = f'{BASE}/blobs/Condition'
MANIFEST = f'{BASE}/out/manifest.json'
TABLES = f'{BASE}/out/tables.json'
TMP_IN = f'{BASE}/out/_patch_conditions_in.json'
TMP_OUT = f'{BASE}/out/_patch_conditions_out.json'
TMP_PERM = f'{BASE}/out/_patch_conditions_perm.json'

import sqlcipher3.dbapi2 as dbi

manifest = json.load(open(MANIFEST))
tables = json.load(open(TABLES))
part = next(p for p in manifest['partitions'] if p['type'] == 'Condition')


def finish_table(table):
    """Refresh the manifest/tables entries for `table`; False when unchanged."""
    blob = f'{BASE}/blobs/{table}'
    part = next(p for p in manifest['partitions'] if p['type'] == table)
    new_size = os.path.getsize(blob)
    new_sha = hashlib.sha256(open(blob, 'rb').read()).hexdigest()
    if part['fileName'] == new_sha and part['fileSize'] == new_size:
        print(f'{table}: blob unchanged; sha={new_sha}')
        return False
    part['fileSize'] = new_size
    part['fileName'] = new_sha
    part['downloadUrl'] = f'https://climaster.game-idolypride.jp/{table}/{new_sha}'
    manifest['version'] = new_sha
    tables[table]['fileSize'] = new_size
    print(f'{table}: blob size={new_size}; sha={new_sha}')
    return True


def write_if_changed(path, obj, force):
    """Write JSON only when forced or when it differs from what is on disk."""
    text = json.dumps(obj, indent=1)
    try:
        with open(path) as f:
            current = f.read()
    except FileNotFoundError:
        current = None
    if force or current != text:
        with open(path, 'w') as f:
            f.write(text)


def write_row(con, select_sql, select_params, exec_sql, exec_params, new_data):
    """Execute `exec_sql` only when the stored bytes differ; True when executed."""
    row = con.execute(select_sql, select_params).fetchone()
    if row is not None and bytes(row[0]) == new_data:
        return False
    con.execute(exec_sql, exec_params)
    return True

gachas = json.load(open(f'{BASE}/out/structured/Gacha.json'))
gacha_targets = sorted(
    g['ViewConditionId'] for g in gachas
    if g.get('Id') in ACTIVE_GACHA_IDS and g.get('ViewConditionId')
)

# Photo shootings: conditions whose own or nested Term has already ended.
conditions = {c['Id']: c for c in json.load(open(f'{BASE}/out/structured/Condition.json'))}
now_ms = int(time.time() * 1000)


def expired(cid, seen=()):
    if cid in seen or cid not in conditions:
        return False
    text = json.dumps(conditions[cid].get('Settings'))
    if any(int(t) < now_ms for t in re.findall(r'"NowBefore": (\d+)', text)):
        return True
    nested = re.findall(r'"ConditionId": "([^"]+)"', text)
    return any(expired(n, seen + (cid,)) for n in nested)


PHOTO_TABLES = (
    'PhotoQuestMusic',
    'PhotoQuestStage',
    'PhotoActivity',
    'PhotoExpression',
    'PhotoContestActivity',
    'PhotoContestQuestMusic',
    'PhotoContestSection',
)
photo_conditions = {
    row[key]
    for table in PHOTO_TABLES
    for row in json.load(open(f'{BASE}/out/structured/{table}.json'))
    for key in ('ViewConditionId', 'UnlockConditionId')
    if row.get(key)
}


def earliest_start(cid):
    """Smallest non-zero NowAfter in the condition's own Settings Terms (0 if none)."""
    starts = [
        setting['Term']['NowAfter']
        for setting in conditions[cid].get('Settings') or []
        if (setting.get('Term') or {}).get('NowAfter')
    ]
    return min(starts) if starts else 0


photo_targets = sorted(c for c in photo_conditions if expired(c))
# Every target — gacha banners, photo shootings (fixture + newly expired) and the
# Photo Album — uses the official permanent form (real start, NowBefore 0).
permanent = {
    **{c: GACHA_PERMANENT_CONDITIONS.get(c) or earliest_start(c) for c in gacha_targets},
    **PHOTO_PERMANENT_CONDITIONS,
    **{c: earliest_start(c) for c in photo_targets if c not in PHOTO_PERMANENT_CONDITIONS},
    **SHELF_PERMANENT_CONDITIONS,
}
targets = sorted(set(gacha_targets) | set(permanent))
print(f'target conditions ({len(targets)}, {len(photo_targets)} photo):', ', '.join(targets))

backup = '/tmp/Condition.blob.bak'
if not os.path.exists(backup):
    shutil.copy2(BLOB, backup)
    print('backed up original blob ->', backup)

con = dbi.connect(BLOB)
con.execute(f"PRAGMA key = \"x'{part['cryptoKey']}'\"")
con.execute('SELECT count(*) FROM Condition').fetchone()  # validates key

rows = []
for cid in targets:
    r = con.execute('SELECT Id, data FROM Condition WHERE Id = ?', (cid,)).fetchone()
    if not r:
        raise SystemExit(f'missing condition row: {cid}')
    rows.append({'Id': r[0], 'data': base64.b64encode(r[1]).decode()})

json.dump(rows, open(TMP_IN, 'w'))
json.dump(permanent, open(TMP_PERM, 'w'))
subprocess.run(
    ['node', f'{BASE}/script/patch_conditions.ts', TMP_IN, TMP_OUT, TMP_PERM], check=True
)
patched = json.load(open(TMP_OUT))

written = 0
for r in patched:
    new_data = base64.b64decode(r['data'])
    if write_row(
        con,
        'SELECT data FROM Condition WHERE Id = ?',
        (r['Id'],),
        'UPDATE Condition SET data = ? WHERE Id = ?',
        (new_data, r['Id']),
        new_data,
    ):
        written += 1
if written:
    con.commit()
con.close()
print(f'Condition: {written} rows written')
changed = finish_table('Condition')

write_if_changed(MANIFEST, manifest, changed)
write_if_changed(TABLES, tables, changed)

os.remove(TMP_IN)
os.remove(TMP_OUT)
os.remove(TMP_PERM)

print(f'patched {len(patched)} rows; blob size={os.path.getsize(BLOB)}; version={manifest["version"]}')
if changed:
    sys.path.insert(0, SCRIPT_DIR)
    import master_refresh

    master_refresh.refresh()
