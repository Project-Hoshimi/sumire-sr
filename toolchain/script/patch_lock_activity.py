#!/usr/bin/env python3
"""Phase A2 — lock the features the sandbox does not implement.

Fan Event, Promotion and Refresh are client-local screens: the client opens
them without any RPC, so the server cannot answer a tap with the
"not implemented" dialog. Their entry points are gated by `FunctionLock` types
1-3 (ActivityFanEvent, ActivityPromotion, ActivityRefresh), which the client
evaluates from the master data. This adds a condition that never opens
(`Term.NowAfter` far in the future) whose description reads "Not implemented",
points those three locks at it, and refreshes the manifest version so the
client re-syncs.

The same condition also locks the other unimplemented home features, so their
buttons show as locked with "Not implemented" (their entry RPCs are refused in
`fastify-api/src/profiles/sandbox/blockedRpcs.ts` as a backstop): accessory
crafting and limit break, Lv Assist, Union, Renewal, friend invitation,
Manager Training and Roulette.

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
HELPER = f'{BASE}/script/patch_lock_activity.ts'
CONDITION_ID = 'cd-sumire-not-implemented'
DESCRIPTION = 'Not implemented'
# FunctionLockType: ActivityFanEvent 1, ActivityPromotion 2, ActivityRefresh 3,
# AccessoryEnhance 10, CardSupport 11 (Lv Assist), Guild 12 (Union),
# CardReset 15 (Renewal), AccessoryLimitBreak 19, Invite 21, InviteHost 23,
# Exercise 27 (Manager Training), Roulette 36.
LOCK_TYPES = (1, 2, 3, 10, 11, 12, 15, 19, 21, 23, 27, 36)

MANIFEST = f'{BASE}/out/manifest.json'
TABLES_JSON = f'{BASE}/out/tables.json'
TMP_IN = f'{BASE}/out/_patch_lock_in.json'
TMP_OUT = f'{BASE}/out/_patch_lock_out.json'

import sqlcipher3.dbapi2 as dbi

manifest = json.load(open(MANIFEST))
tables = json.load(open(TABLES_JSON))


def open_table(table):
    blob = f'{BASE}/blobs/{table}'
    backup = f'/tmp/{table}.blob.bak'
    if not os.path.exists(backup):
        shutil.copy2(blob, backup)
        print('backed up original blob ->', backup)
    part = next(p for p in manifest['partitions'] if p['type'] == table)
    con = dbi.connect(blob)
    con.execute(f"PRAGMA key = \"x'{part['cryptoKey']}'\"")
    return con


def refresh(table):
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


changed = False

subprocess.run(['node', HELPER, 'new', CONDITION_ID, DESCRIPTION, TMP_OUT], check=True)
encoded = json.load(open(TMP_OUT))
for table in ('Condition', 'ConditionDescription'):
    con = open_table(table)
    new_data = base64.b64decode(encoded[table])
    written = 1 if write_row(
        con,
        f'SELECT data FROM {table} WHERE Id = ?',
        (CONDITION_ID,),
        f'INSERT OR REPLACE INTO {table} (Id, data) VALUES (?, ?)',
        (CONDITION_ID, new_data),
        new_data,
    ) else 0
    if written:
        con.commit()
    con.close()
    print(f'{table}: {written} rows written')
    changed = refresh(table) or changed

con = open_table('FunctionLock')
marks = ','.join('?' * len(LOCK_TYPES))
rows = [
    {'Id': r[0], 'data': base64.b64encode(r[1]).decode()}
    for r in con.execute(f'SELECT Type, data FROM FunctionLock WHERE Type IN ({marks})', LOCK_TYPES)
]
json.dump(rows, open(TMP_IN, 'w'))
subprocess.run(['node', HELPER, 'relock', CONDITION_ID, TMP_IN, TMP_OUT], check=True)
written = 0
for r in json.load(open(TMP_OUT)):
    new_data = base64.b64decode(r['data'])
    if write_row(
        con,
        'SELECT data FROM FunctionLock WHERE Type = ?',
        (r['Id'],),
        'UPDATE FunctionLock SET data = ? WHERE Type = ?',
        (new_data, r['Id']),
        new_data,
    ):
        written += 1
if written:
    con.commit()
con.close()
print(f'FunctionLock: {written} rows written')
changed = refresh('FunctionLock') or changed

write_if_changed(MANIFEST, manifest, changed)
write_if_changed(TABLES_JSON, tables, changed)
os.remove(TMP_IN)
os.remove(TMP_OUT)
print('manifest version =', manifest['version'])
if changed:
    sys.path.insert(0, SCRIPT_DIR)
    import master_refresh

    master_refresh.refresh()
