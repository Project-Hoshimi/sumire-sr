#!/usr/bin/env python3
"""Phase A2 — let every photo pose work with every outfit and Pose area.

The client hides a pose when the idol's outfit or hair lists its pose type in
`ImpossiblePhotoPoseTypes` (most outfits forbid Lying, some also Sitting), or
when the Pose area lists it in `PhotoExpression.ImpossiblePhotoPoseIds`. With
every outfit allowed in every area, a Lying position then has no usable pose.
This empties those lists in the served SQLCipher masters and refreshes the
manifest version so the client re-syncs.

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
TABLES = {
    'Costume': ['ImpossiblePhotoPoseTypes'],
    'Hair': ['ImpossiblePhotoPoseTypes'],
    'PhotoExpression': ['ImpossiblePhotoPoseIds'],
}

MANIFEST = f'{BASE}/out/manifest.json'
TABLES_JSON = f'{BASE}/out/tables.json'
TMP_IN = f'{BASE}/out/_patch_poses_in.json'
TMP_OUT = f'{BASE}/out/_patch_poses_out.json'

import sqlcipher3.dbapi2 as dbi

manifest = json.load(open(MANIFEST))
tables = json.load(open(TABLES_JSON))


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


changed = False

for table, fields in TABLES.items():
    blob = f'{BASE}/blobs/{table}'
    part = next(p for p in manifest['partitions'] if p['type'] == table)

    backup = f'/tmp/{table}.blob.bak'
    if not os.path.exists(backup):
        shutil.copy2(blob, backup)
        print('backed up original blob ->', backup)

    con = dbi.connect(blob)
    con.execute(f"PRAGMA key = \"x'{part['cryptoKey']}'\"")
    rows = [
        {'Id': r[0], 'data': base64.b64encode(r[1]).decode()}
        for r in con.execute(f'SELECT Id, data FROM {table}')
    ]
    json.dump(rows, open(TMP_IN, 'w'))
    subprocess.run(
        ['node', f'{BASE}/script/patch_photo_poses.ts', table, json.dumps(fields), TMP_IN, TMP_OUT],
        check=True,
    )
    written = 0
    for r in json.load(open(TMP_OUT)):
        new_data = base64.b64decode(r['data'])
        if write_row(
            con,
            f'SELECT data FROM {table} WHERE Id = ?',
            (r['Id'],),
            f'UPDATE {table} SET data = ? WHERE Id = ?',
            (new_data, r['Id']),
            new_data,
        ):
            written += 1
    if written:
        con.commit()
    con.close()
    print(f'{table}: {written} rows written')
    changed = finish_table(table) or changed

write_if_changed(MANIFEST, manifest, changed)
write_if_changed(TABLES_JSON, tables, changed)
os.remove(TMP_IN)
os.remove(TMP_OUT)
print('manifest version =', manifest['version'])
if changed:
    sys.path.insert(0, SCRIPT_DIR)
    import master_refresh

    master_refresh.refresh()
