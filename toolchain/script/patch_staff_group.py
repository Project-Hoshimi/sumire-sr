#!/usr/bin/env python3
"""Phase A2 — put Satomi, Kohei and the Dorikyun duo into a staff character
group so the photo character picker lists them.

The picker only offers characters that belong to a `CharacterGroup`, and every
existing group is an idol unit. This clones `character_group_5` (Mana, the last
single-character group) as `character_group_staff` — Name `スタッフ`,
CharacterType 2 (Npc), Order 10 after the collab groups — keeping the template's
AssetId and colors so the client never looks up a missing asset, but replaces
its Mappings with the staff members (Satomi `char-stm`, idol Satomi `char-stm1`,
Kohei `char-koh`, Lemon `char-lmn` and Lime `char-lim`, each described by that
Character row's ShortProfile, which is empty for all five), then points every
staff character at it. Rows are only written when their encoded bytes actually
change, so re-running is a no-op; the manifest version is refreshed whenever a
blob changes so the client re-syncs.

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

GROUP_TABLE = 'CharacterGroup'
CHARACTER_TABLE = 'Character'
TEMPLATE_GROUP_ID = 'character_group_5'
STAFF_GROUP_ID = 'character_group_staff'
# Called on the template row; every other column is copied verbatim.
STAFF_GROUP_OVERRIDES = {
    'Id': STAFF_GROUP_ID,
    'Name': 'スタッフ',
    'CharacterType': 2,  # CharacterType.Npc
    'Order': 10,         # after the collab groups (whose max Order is 9)
}
# Satomi (staff), Satomi (idol char-stm1), Kohei, then the Dorikyun duo.
STAFF_CHARACTER_IDS = ('char-stm', 'char-stm1', 'char-koh', 'char-lmn', 'char-lim')
# First member mapping order; later members follow consecutively.
STAFF_MAPPING_ORDER = 201
CHARACTER_OVERRIDES = {'CharacterGroupId': STAFF_GROUP_ID}
# TEST: borrow Miho's (`mhk`) assets for Kohei. The client builds per-character
# asset names from AssetId (`mot_all_chr_<AssetId>_idle-001_pose`,
# `sud_vo_cmn_<AssetId>_...`, `img_chr_thumb_sd_<AssetId>`) and ships no `koh`
# idle pose, so the outfit room freezes; Miho's idle pose, voice and thumbnail
# are used instead. His 3D model comes from his Costume/Hair rows and is
# untouched. Remove this entry to revert to `koh`.
PER_CHARACTER_OVERRIDES = {'char-koh': {'AssetId': 'mhk'}}

MANIFEST = f'{BASE}/out/manifest.json'
TABLES_JSON = f'{BASE}/out/tables.json'
TMP_IN = f'{BASE}/out/_patch_staff_in.json'
TMP_OUT = f'{BASE}/out/_patch_staff_out.json'

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


def patch_rows(table, rows, overrides):
    """Decode `rows` ([{Id, data}]), merge `overrides`, return {Id: bytes}."""
    json.dump(rows, open(TMP_IN, 'w'))
    subprocess.run(
        ['node', f'{BASE}/script/patch_staff_group.ts', table, json.dumps(overrides), TMP_IN, TMP_OUT],
        check=True,
    )
    return {r['Id']: base64.b64decode(r['data']) for r in json.load(open(TMP_OUT))}


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


def decode_rows(table, rows):
    """Decode base64 proto rows via the node helper, return [{Id, decoded}]."""
    json.dump(rows, open(TMP_IN, 'w'))
    subprocess.run(
        ['node', f'{BASE}/script/patch_staff_group.ts', table, '{}', TMP_IN, TMP_OUT, '--decode'],
        check=True,
    )
    return json.load(open(TMP_OUT))


changed = False

# 1. Read the staff characters. Their ShortProfile becomes the group mapping's
#    Description (empty when the Character row has none).
con = open_table(CHARACTER_TABLE)
staff_rows = [
    {'Id': r[0], 'data': base64.b64encode(r[1]).decode()}
    for r in con.execute(
        f'SELECT Id, data FROM {CHARACTER_TABLE} '
        f"WHERE Id IN ({','.join('?' * len(STAFF_CHARACTER_IDS))})",
        STAFF_CHARACTER_IDS,
    )
]
con.close()
missing = set(STAFF_CHARACTER_IDS) - {r['Id'] for r in staff_rows}
if missing:
    raise SystemExit(f'{CHARACTER_TABLE}: rows not found: {sorted(missing)}')
profiles = {
    r['Id']: r['decoded'].get('ShortProfile') or ''
    for r in decode_rows(CHARACTER_TABLE, staff_rows)
}

# 2. Clone the template group as the staff group, listing the staff members
#    (Satomi, idol Satomi char-stm1, Kohei, Lemon, Lime) instead of the
#    template's own.
mappings = [
    {
        'CharacterId': character_id,
        'Description': profiles[character_id],
        'Order': STAFF_MAPPING_ORDER + index,
    }
    for index, character_id in enumerate(STAFF_CHARACTER_IDS)
]
con = open_table(GROUP_TABLE)
template = con.execute(
    f'SELECT Id, data FROM {GROUP_TABLE} WHERE Id = ?', (TEMPLATE_GROUP_ID,)
).fetchone()
if template is None:
    raise SystemExit(f'{GROUP_TABLE}: template row {TEMPLATE_GROUP_ID} not found')
desired = patch_rows(
    GROUP_TABLE,
    [{'Id': template[0], 'data': base64.b64encode(template[1]).decode()}],
    {**STAFF_GROUP_OVERRIDES, 'Mappings': mappings},
)[STAFF_GROUP_ID]
current = con.execute(
    f'SELECT data FROM {GROUP_TABLE} WHERE Id = ?', (STAFF_GROUP_ID,)
).fetchone()
if current is None or current[0] != desired:
    con.execute(
        f'INSERT OR REPLACE INTO {GROUP_TABLE} (Id, data) VALUES (?, ?)',
        (STAFF_GROUP_ID, desired),
    )
    con.commit()
    print(f'{GROUP_TABLE}: wrote {STAFF_GROUP_ID}')
else:
    print(f'{GROUP_TABLE}: {STAFF_GROUP_ID} already up to date')
print(f'{GROUP_TABLE} rows:', con.execute(f'SELECT COUNT(*) FROM {GROUP_TABLE}').fetchone()[0])
con.close()
changed = finish_table(GROUP_TABLE) or changed

# 3. Point the staff characters at the new group, applying any per-character
#    overrides on top (see PER_CHARACTER_OVERRIDES).
con = open_table(CHARACTER_TABLE)
desired = {}
for row in staff_rows:
    overrides = {**CHARACTER_OVERRIDES, **PER_CHARACTER_OVERRIDES.get(row['Id'], {})}
    desired.update(patch_rows(CHARACTER_TABLE, [row], overrides))
updated = 0
for character_id, data in desired.items():
    current = con.execute(
        f'SELECT data FROM {CHARACTER_TABLE} WHERE Id = ?', (character_id,)
    ).fetchone()
    if current is not None and current[0] == data:
        continue
    con.execute(
        f'UPDATE {CHARACTER_TABLE} SET data = ? WHERE Id = ?', (data, character_id)
    )
    updated += 1
if updated:
    con.commit()
    print(f'{CHARACTER_TABLE}: updated {updated} of {len(desired)} staff rows')
else:
    print(f'{CHARACTER_TABLE}: staff rows already up to date')
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
