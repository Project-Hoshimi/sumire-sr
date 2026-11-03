#!/usr/bin/env python3
"""Phase A2 — give the base Satomi character (char-stm) the stage costume her
numbered variants have.

`char-stm1` owns the フィーリングハート idol costume (`cos-stm1-idol-02`) plus its
hair (`hair-stm1-idol-02`), but the base `char-stm` only has her casual outfit.
This clones the numbered variant's Costume and Hair rows under base-Satomi ids,
repointing `CharacterId`, `DefaultHairId`, `WearableCostumeIds` and
`FittingCostumeId` at char-stm / the new costume while copying every other
column verbatim, then appends the new costume to `char-stm`'s `CostumeIds`
(leaving her default casual costume and live costume untouched). Rows are only
written when their encoded bytes actually change, so re-running is a no-op; the
manifest version is refreshed whenever a blob changes so the client re-syncs.

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
HELPER = f'{BASE}/script/patch_staff_group.ts'

COSTUME_TABLE = 'Costume'
HAIR_TABLE = 'Hair'
CHARACTER_TABLE = 'Character'

TEMPLATE_COSTUME_ID = 'cos-stm1-idol-02'
NEW_COSTUME_ID = 'cos-stm-idol-02'
# The stm-idol-02 SD asset is missing from the client's asset database, so the
# SD (chibi) fields point at Satomi's existing casual SD asset instead.
SD_CASUAL_ASSET_ID = 'stm-casl-00'
# Called on the template row; every other column is copied verbatim.
COSTUME_OVERRIDES = {
    'Id': NEW_COSTUME_ID,
    'CharacterId': 'char-stm',
    'DefaultHairId': 'hair-stm-idol-02',
    'SdAssetId': SD_CASUAL_ASSET_ID,
}

TEMPLATE_HAIR_ID = 'hair-stm1-idol-02'
NEW_HAIR_ID = 'hair-stm-idol-02'
HAIR_OVERRIDES = {
    'Id': NEW_HAIR_ID,
    'CharacterId': 'char-stm',
    'WearableCostumeIds': [NEW_COSTUME_ID],
    'FittingCostumeId': NEW_COSTUME_ID,
    'SdHairAssetId': SD_CASUAL_ASSET_ID,
}

CHARACTER_ID = 'char-stm'

MANIFEST = f'{BASE}/out/manifest.json'
TABLES_JSON = f'{BASE}/out/tables.json'
TMP_IN = f'{BASE}/out/_patch_stm_idol_in.json'
TMP_OUT = f'{BASE}/out/_patch_stm_idol_out.json'

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


def run_helper(table, rows, overrides, decode=False):
    """Run the shared proto helper on one table's [{Id, data}] rows."""
    json.dump(rows, open(TMP_IN, 'w'))
    cmd = ['node', HELPER, table, json.dumps(overrides), TMP_IN, TMP_OUT]
    if decode:
        cmd.append('--decode')
    subprocess.run(cmd, check=True)
    return json.load(open(TMP_OUT))


def patch_row(table, row, overrides):
    """Decode `row`, merge `overrides`, return the re-encoded bytes."""
    out = run_helper(table, [row], overrides)
    return base64.b64decode(out[0]['data'])


def decode_row(table, row):
    """Decode `row` ([{Id, data}]) and return its decoded fields."""
    return run_helper(table, [row], {}, decode=True)[0]['decoded']


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


def fetch_row(con, table, row_id):
    row = con.execute(
        f'SELECT Id, data FROM {table} WHERE Id = ?', (row_id,)
    ).fetchone()
    if row is None:
        raise SystemExit(f'{table}: row {row_id} not found')
    return {'Id': row[0], 'data': base64.b64encode(row[1]).decode()}


def clone_row(table, template_id, new_id, overrides):
    """Clone `template_id` as `new_id` with `overrides`; write when changed."""
    con = open_table(table)
    template = fetch_row(con, table, template_id)
    desired = patch_row(table, template, overrides)
    current = con.execute(
        f'SELECT data FROM {table} WHERE Id = ?', (new_id,)
    ).fetchone()
    if current is None or current[0] != desired:
        con.execute(
            f'INSERT OR REPLACE INTO {table} (Id, data) VALUES (?, ?)',
            (new_id, desired),
        )
        con.commit()
        print(f'{table}: wrote {new_id}')
    else:
        print(f'{table}: {new_id} already up to date')
    print(f'{table} rows:', con.execute(f'SELECT COUNT(*) FROM {table}').fetchone()[0])
    con.close()
    return finish_table(table)


def update_row(table, row_id, overrides):
    """Patch an existing `row_id` in place; write only when bytes change."""
    con = open_table(table)
    current = fetch_row(con, table, row_id)
    desired = patch_row(table, current, overrides)
    stored = con.execute(
        f'SELECT data FROM {table} WHERE Id = ?', (row_id,)
    ).fetchone()
    if stored is None or stored[0] != desired:
        con.execute(
            f'UPDATE {table} SET data = ? WHERE Id = ?', (desired, row_id)
        )
        con.commit()
        print(f'{table}: updated {row_id}')
    else:
        print(f'{table}: {row_id} already up to date')
    print(f'{table} rows:', con.execute(f'SELECT COUNT(*) FROM {table}').fetchone()[0])
    con.close()
    return finish_table(table)


changed = False

# 1. Repoint the official numbered-variant rows at the casual SD chibi in place;
#    the stm-idol-02 SD asset is missing from the client's asset database. Only
#    the SD column changes, every other column is preserved.
changed = update_row(
    COSTUME_TABLE, TEMPLATE_COSTUME_ID, {'SdAssetId': SD_CASUAL_ASSET_ID}
) or changed
changed = update_row(
    HAIR_TABLE, TEMPLATE_HAIR_ID, {'SdHairAssetId': SD_CASUAL_ASSET_ID}
) or changed

# 2. Clone the numbered variant's idol costume for the base character.
changed = clone_row(
    COSTUME_TABLE, TEMPLATE_COSTUME_ID, NEW_COSTUME_ID, COSTUME_OVERRIDES
) or changed

# 3. Clone the matching hair, wired to the new costume.
changed = clone_row(
    HAIR_TABLE, TEMPLATE_HAIR_ID, NEW_HAIR_ID, HAIR_OVERRIDES
) or changed

# 4. Append the new costume to char-stm's costume list; keep existing order and
#    leave her default/live costumes and every other column untouched.
con = open_table(CHARACTER_TABLE)
character = fetch_row(con, CHARACTER_TABLE, CHARACTER_ID)
costume_ids = list(decode_row(CHARACTER_TABLE, character).get('CostumeIds') or [])
if NEW_COSTUME_ID not in costume_ids:
    costume_ids.append(NEW_COSTUME_ID)
desired = patch_row(CHARACTER_TABLE, character, {'CostumeIds': costume_ids})
current = con.execute(
    f'SELECT data FROM {CHARACTER_TABLE} WHERE Id = ?', (CHARACTER_ID,)
).fetchone()
if current is None or current[0] != desired:
    con.execute(
        f'UPDATE {CHARACTER_TABLE} SET data = ? WHERE Id = ?',
        (desired, CHARACTER_ID),
    )
    con.commit()
    print(f'{CHARACTER_TABLE}: updated {CHARACTER_ID}')
else:
    print(f'{CHARACTER_TABLE}: {CHARACTER_ID} already up to date')
print(f'{CHARACTER_TABLE} rows:', con.execute(f'SELECT COUNT(*) FROM {CHARACTER_TABLE}').fetchone()[0])
con.close()
changed = finish_table(CHARACTER_TABLE) or changed

if changed:
    json.dump(manifest, open(MANIFEST, 'w'), indent=1)
    json.dump(tables, open(TABLES_JSON, 'w'), indent=1)
os.remove(TMP_IN)
os.remove(TMP_OUT)
print('manifest version =', manifest['version'])
if changed:
    sys.path.insert(0, SCRIPT_DIR)
    import master_refresh

    master_refresh.refresh()
