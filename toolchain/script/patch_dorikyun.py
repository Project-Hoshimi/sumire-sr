#!/usr/bin/env python3
"""Phase A2 — add the Dorikyun duo, Lemon (`char-lmn`) and Lime (`char-lim`).

The official master has no rows for the two staff characters even though the
client's asset catalog ships their 3D bundles (`mdl_chr_lmn-*`, `mdl_chr_lim-*`).
This synthesizes every row they need by cloning Satomi's first idol variant
(`char-stm1`, `cos-stm1-casl-00`, `cos-stm1-idol-02`, `hair-stm1-casl-00`,
`hair-stm1-idol-02`) and overriding only the identifiers, names, colors and
costume wiring:

  * `Character`  `char-lmn` / `char-lim` (in the スタッフ group, default idol look)
  * `Costume`    `cos-<code>-casl-00` / `cos-<code>-idol-00`
  * `Hair`       `hair-<code>-casl-00` / `hair-<code>-idol-00`
  * `CharacterCostumeGroup` default-look rows, mirroring `char-stm1`

Neither character has SD (`spi_sd_*`) assets, so the costumes and hairs borrow
Satomi's casual chibi model (`stm-casl-00`) for those fields. (`stm-idol-02` SD
is not present in the client's asset database — see the SD comment below.) Every
other column is copied verbatim from the template.

`Character.AssetId` is set to a per-character donor rather than to `lmn` /
`lim`. The client derives per-character voice, thumbnail and home idle-pose
asset names from it (`sud_vo_cmn_<AssetId>_photo-start`,
`img_chr_thumb_sd_<AssetId>`, `mot_all_chr_<AssetId>_idle-001_pose`) and
Lemon/Lime ship none of those, so Lemon borrows Rio's `rio` and Lime borrows
Aoi's `aoi`. The 3D model is unaffected: it is resolved from the Costume/Hair
rows (`BodyAssetId`, `HairAssetId`/`FaceAssetId`), which keep the `lmn-*` /
`lim-*` ids.

Rows are only written when their encoded bytes actually change, so re-running
is a no-op; the manifest version is refreshed whenever a blob changes so the
client re-syncs.

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

CHARACTER_TABLE = 'Character'
COSTUME_TABLE = 'Costume'
HAIR_TABLE = 'Hair'
COSTUME_GROUP_TABLE = 'CharacterCostumeGroup'
COSTUME_GROUP_ID = 'costume-group-home-lesson-00'

# Clone templates: Satomi's first idol variant.
TEMPLATE_CHARACTER_ID = 'char-stm1'
TEMPLATE_COSTUME_ID = {'casl': 'cos-stm1-casl-00', 'idol': 'cos-stm1-idol-02'}
TEMPLATE_HAIR_ID = {'casl': 'hair-stm1-casl-00', 'idol': 'hair-stm1-idol-02'}

# Per-character fields overridden on the cloned Character row.
CHARACTERS = {
    'lmn': {'Name': 'レモン', 'EnName': 'LEMON', 'Color': 'F2D33C', 'GachaMovieName': 'LEMON'},
    'lim': {'Name': 'ライム', 'EnName': 'LIME', 'Color': '8CC63F', 'GachaMovieName': 'LIME'},
}

# AssetId donor per character: Lemon borrows Rio's, Lime borrows Aoi's.
ASSET_ID_DONORS = {'lmn': 'rio', 'lim': 'aoi'}

CASUAL_NAME = 'ベーシックスタイル'
IDOL_NAME = 'ドリキュン衣装'

MANIFEST = f'{BASE}/out/manifest.json'
TABLES_JSON = f'{BASE}/out/tables.json'
TMP_IN = f'{BASE}/out/_patch_dorikyun_in.json'
TMP_OUT = f'{BASE}/out/_patch_dorikyun_out.json'

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


def run_helper(table, rows, overrides):
    """Run the shared proto helper on one table's [{Id, data}] rows."""
    json.dump(rows, open(TMP_IN, 'w'))
    subprocess.run(
        ['node', HELPER, table, json.dumps(overrides), TMP_IN, TMP_OUT],
        check=True,
    )
    return json.load(open(TMP_OUT))


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


def fetch_template(con, table, key_columns, key_values):
    """Read a template row as the helper's [{Id, data}] input shape."""
    columns = ', '.join(key_columns)
    where = ' AND '.join(f'{c} = ?' for c in key_columns)
    row = con.execute(f'SELECT {columns}, data FROM {table} WHERE {where}', key_values).fetchone()
    if row is None:
        raise SystemExit(f'{table}: template row {key_values} not found')
    # Composite-key tables have no Id column; the helper only uses this value
    # as its output key, so any stable label works.
    return {'Id': '|'.join(key_values), 'data': base64.b64encode(row[-1]).decode()}


def write_row(con, table, key_columns, key_values, data):
    """Insert or update one row only when the stored bytes differ."""
    where = ' AND '.join(f'{c} = ?' for c in key_columns)
    row = con.execute(f'SELECT data FROM {table} WHERE {where}', key_values).fetchone()
    if row is not None and bytes(row[0]) == data:
        return False
    columns = ', '.join(key_columns)
    placeholders = ', '.join('?' * (len(key_columns) + 1))
    con.execute(
        f'INSERT OR REPLACE INTO {table} ({columns}, data) VALUES ({placeholders})',
        (*key_values, data),
    )
    return True


def patch_table(table, key_columns, entries):
    """Clone each `(new_key, template_key, overrides)` entry; False when unchanged."""
    con = open_table(table)
    written = 0
    for new_key, template_key, overrides in entries:
        template = fetch_template(con, table, key_columns, template_key)
        data = base64.b64decode(run_helper(table, [template], overrides)[0]['data'])
        label = new_key[0] if len(new_key) == 1 else '/'.join(new_key)
        if write_row(con, table, key_columns, new_key, data):
            written += 1
            print(f'{table}: wrote {label}')
        else:
            print(f'{table}: {label} already up to date')
    if written:
        con.commit()
    print(f'{table} rows:', con.execute(f'SELECT COUNT(*) FROM {table}').fetchone()[0])
    con.close()
    return finish_table(table)


def costume_overrides(code, style):
    return {
        'Id': f'cos-{code}-{style}-00',
        'CharacterId': f'char-{code}',
        'BodyAssetId': f'{code}-{style}-00',
        'MotifAssetId': f'{style}-00',
        'Name': CASUAL_NAME if style == 'casl' else IDOL_NAME,
        'DefaultHairId': f'hair-{code}-{style}-00',
        # No SD asset ships for Lemon/Lime; borrow Satomi's casual chibi. The
        # stm-idol-02 SD asset is missing from the client's asset database, so
        # use stm-casl-00 for both styles.
        'SdAssetId': 'stm-casl-00',
    }


def hair_overrides(code, style):
    costume_id = f'cos-{code}-{style}-00'
    return {
        'Id': f'hair-{code}-{style}-00',
        'HairAssetId': f'{code}-base-00',
        'FaceAssetId': f'{code}-base-00',
        # No SD hair ships for Lemon/Lime; borrow Satomi's casual chibi. The
        # stm-idol-02 SD asset is missing from the client's asset database, so
        # use stm-casl-00 for both styles.
        'SdHairAssetId': 'stm-casl-00',
        'CharacterId': f'char-{code}',
        'WearableCostumeIds': [costume_id],
        'FittingCostumeId': costume_id,
        'Name': CASUAL_NAME if style == 'casl' else IDOL_NAME,
    }


def character_overrides(code, fields):
    return {
        'Id': f'char-{code}',
        # AssetId keys per-character voice, thumbnail and idle-pose assets
        # (`sud_vo_cmn_<AssetId>_photo-start`, `img_chr_thumb_sd_<AssetId>`,
        # `mot_all_chr_<AssetId>_idle-001_pose`). Lemon/Lime ship none of those,
        # so Lemon borrows Rio's `rio` and Lime borrows Aoi's `aoi`. The 3D
        # model comes from the Costume/Hair rows (BodyAssetId,
        # HairAssetId/FaceAssetId), which stay lmn-*/lim-*.
        'AssetId': ASSET_ID_DONORS[code],
        'CharacterGroupId': 'character_group_staff',
        'Name': fields['Name'],
        'EnName': fields['EnName'],
        'FirstName': '',
        'Cv': '-',
        'Color': fields['Color'],
        'GachaMovieName': fields['GachaMovieName'],
        'CostumeIds': [f'cos-{code}-casl-00', f'cos-{code}-idol-00'],
        'DefaultCostumeId': f'cos-{code}-idol-00',
        'DefaultLiveCostumeId': f'cos-{code}-idol-00',
    }


changed = False

# 1. Costumes and hairs for both characters.
costume_entries = []
hair_entries = []
for code in CHARACTERS:
    for style in ('casl', 'idol'):
        costume_entries.append(
            ((f'cos-{code}-{style}-00',), (TEMPLATE_COSTUME_ID[style],), costume_overrides(code, style))
        )
        hair_entries.append(
            ((f'hair-{code}-{style}-00',), (TEMPLATE_HAIR_ID[style],), hair_overrides(code, style))
        )
changed = patch_table(COSTUME_TABLE, ('Id',), costume_entries) or changed
changed = patch_table(HAIR_TABLE, ('Id',), hair_entries) or changed

# 2. The characters themselves, cloned from char-stm1.
changed = patch_table(
    CHARACTER_TABLE,
    ('Id',),
    [
        ((f'char-{code}',), (TEMPLATE_CHARACTER_ID,), character_overrides(code, fields))
        for code, fields in CHARACTERS.items()
    ],
) or changed

# 3. Default-look rows in the home lesson costume group, the same way char-stm1
#    appears there (its default idol costume).
changed = patch_table(
    COSTUME_GROUP_TABLE,
    ('GroupId', 'CostumeId'),
    [
        (
            (COSTUME_GROUP_ID, f'cos-{code}-idol-00'),
            (COSTUME_GROUP_ID, 'cos-stm1-idol-02'),
            {
                'GroupId': COSTUME_GROUP_ID,
                'CostumeId': f'cos-{code}-idol-00',
            },
        )
        for code in CHARACTERS
    ],
) or changed

write_if_changed(MANIFEST, manifest, changed)
write_if_changed(TABLES_JSON, tables, changed)
os.remove(TMP_IN)
os.remove(TMP_OUT)
print('manifest version =', manifest['version'])
if changed:
    sys.path.insert(0, SCRIPT_DIR)
    import master_refresh

    master_refresh.refresh()
