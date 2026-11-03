#!/usr/bin/env python3
"""Phase A2 — open the six `st-eve-2610-dice` event story episodes now.

The client keeps an episode locked until every Setting of its unlock condition
is satisfied. For this event each `cd-event-dice-26-1030-story-0N-unlock` row
carries the intended progression gates (ManagerLevel LevelGte 20 / ClearArea
area-main-004) plus a release `Term.NowAfter` of 1796612399000 (2026-12-06),
four weeks after the event itself started. Since the server is meant to be
readable from the event's release time (1793350800000, 2026-10-30 09:00 UTC),
this script, in the served `Condition` SQLCipher master:

  * rewrites ONLY those `Term.NowAfter` values to 1793350800000 and refreshes
    the manifest version so the client re-syncs, and
  * removes the `ManagerLevel` and `ClearArea` sub-conditions from every
    Setting of the six rows, dropping a Setting that is left with no condition
    field at all (only `__msg`/`__unknown`). The sandbox player has not cleared
    main area 4 and has not reached level 20, so keeping the gates would leave
    the episodes unreadable even after the release term; removing them lets
    the story be read straight away.

Every other Setting and every other field of the six rows is preserved, and no
other Condition row is touched: the rows are decoded with
`script/patch_ipr_rows.ts` (which round-trips these rows byte-for-byte), only a
Setting whose `Term.NowAfter` equals 1796612399000 is rewritten (either that
value or the already-patched 1793350800000 is accepted; anything else aborts),
and the row is written back only when its encoded bytes differ. Both the
original gated rows and the already-patched rows are handled, so a second run
writes nothing and leaves the tree clean; `master_refresh.refresh()` is run
only when the blob actually changed.

Requires: sqlcipher3 (Python), node (proto decode/encode helper).
"""
import base64
import hashlib
import json
import os
import shutil
import subprocess
import sys

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.dirname(os.path.dirname(SCRIPT_DIR))
BASE = os.path.join(os.environ.get('SUMIRE_DATA_DIR') or REPO_ROOT, 'phaseA2')

HELPER = f'{BASE}/script/patch_ipr_rows.ts'
BLOB = f'{BASE}/blobs/Condition'
MANIFEST = f'{BASE}/out/manifest.json'
TABLES = f'{BASE}/out/tables.json'
TMP_DEC_IN = f'{BASE}/out/_patch_event_story_2610_unlock_dec_in.json'
TMP_DEC_OUT = f'{BASE}/out/_patch_event_story_2610_unlock_dec_out.json'
TMP_ENC_IN = f'{BASE}/out/_patch_event_story_2610_unlock_enc_in.json'
TMP_ENC_OUT = f'{BASE}/out/_patch_event_story_2610_unlock_enc_out.json'

# 2026-12-06 (what the official master ships) -> 2026-10-30 09:00 UTC (release).
OLD_NOW_AFTER = 1796612399000
NEW_NOW_AFTER = 1793350800000
IDS = [f'cd-event-dice-26-1030-story-0{i}-unlock' for i in range(1, 7)]

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


backup = '/tmp/Condition.blob.bak'
if not os.path.exists(backup):
    shutil.copy2(BLOB, backup)
    print('backed up original blob ->', backup)

con = dbi.connect(BLOB)
con.execute(f"PRAGMA key = \"x'{part['cryptoKey']}'\"")
con.execute('SELECT count(*) FROM Condition').fetchone()  # validates key

rows = []
for cid in IDS:
    r = con.execute('SELECT Id, data FROM Condition WHERE Id = ?', (cid,)).fetchone()
    if not r:
        con.close()
        raise SystemExit(f'missing condition row: {cid}')
    rows.append({'Id': r[0], 'data': base64.b64encode(r[1]).decode()})

# Decode the six rows, move the release term, and drop the progress gates.
json.dump(rows, open(TMP_DEC_IN, 'w'))
subprocess.run(['node', HELPER, 'Condition', TMP_DEC_IN, TMP_DEC_OUT, '--decode'], check=True)
decoded = json.load(open(TMP_DEC_OUT))

# Keys that carry no condition: a Setting holding only these is empty.
NON_CONDITION_FIELDS = ('__msg', '__unknown')
GATE_FIELDS = ('ManagerLevel', 'ClearArea')

patched_settings = 0
removed_gates = 0
dropped_settings = 0
for row in decoded:
    settings = row['decoded'].get('Settings', [])
    kept = []
    for setting in settings:
        for gate in GATE_FIELDS:
            if gate in setting:
                del setting[gate]
                removed_gates += 1
        if not any(key not in NON_CONDITION_FIELDS for key in setting):
            dropped_settings += 1
            continue
        term = setting.get('Term')
        if term:
            now_after = term.get('NowAfter')
            if now_after == OLD_NOW_AFTER:
                term['NowAfter'] = NEW_NOW_AFTER
                patched_settings += 1
            elif now_after != NEW_NOW_AFTER:
                con.close()
                raise SystemExit(f"{row['Id']}: unexpected Term.NowAfter {now_after}")
        kept.append(setting)
    if len(kept) != len(settings):
        row['decoded']['Settings'] = kept

print(
    f'found {patched_settings} release terms to move to {NEW_NOW_AFTER}; '
    f'removed {removed_gates} gates; dropped {dropped_settings} empty settings'
)

json.dump([row['decoded'] for row in decoded], open(TMP_ENC_IN, 'w'))
subprocess.run(['node', HELPER, 'Condition', TMP_ENC_IN, TMP_ENC_OUT], check=True)
encoded = {r['Id']: base64.b64decode(r['data']) for r in json.load(open(TMP_ENC_OUT))}

written = 0
for rid, new_data in encoded.items():
    current = con.execute('SELECT data FROM Condition WHERE Id = ?', (rid,)).fetchone()
    if current is not None and bytes(current[0]) == new_data:
        continue
    con.execute('UPDATE Condition SET data = ? WHERE Id = ?', (new_data, rid))
    written += 1
if written:
    con.commit()
con.close()
print(f'Condition: {written} rows written')

changed = finish_table('Condition')

write_if_changed(MANIFEST, manifest, changed)
write_if_changed(TABLES, tables, changed)

for path in (TMP_DEC_IN, TMP_DEC_OUT, TMP_ENC_IN, TMP_ENC_OUT):
    os.remove(path)

print(f'patched {len(encoded)} rows; blob size={os.path.getsize(BLOB)}; version={manifest["version"]}')
if changed:
    sys.path.insert(0, SCRIPT_DIR)
    import master_refresh

    master_refresh.refresh()
