#!/usr/bin/env python3
"""Phase A2 — import the official "メモリアル ガチャ" banners of 2026-10-30
into the Gacha, GachaButton and Condition master blobs.

The rows come from the official master dump vendored at
`phaseA2/import/ipr_gacha_memorial_2610.json` (github MalitsPlus/ipr-master-diff,
commit de005499a8, masterVersion e289d1d8cae557e8caece6cfd0fe6667e116a6c7c3aa246748e45cdf238c8465):
the 7 memorial banners with their 21 GachaButton rows and 6 time Conditions.
The fixture also carries the sandbox-only banner `gacha-sandbox-collab-memorial`
and its 3 buttons, cloned from `gacha-limited-26-1030-01` for the collab
memorial (not present in the official dump). The same applies to the
sandbox-only `gacha-sandbox-premium-memorial` and its 3 buttons, cloned from
the collab row for the プレミアムガチャ pool.
They are camelCase protobuf-JSON rows (`id`, `assetId`, `pickupCardIds[]`,
`settings[].term.nowAfter`, ...) with 64-bit integers as decimal strings;
`script/patch_ipr_rows.ts` maps them onto our registered shapes and encodes
them, and can decode rows back for verification.

The import is split into two phases:

  1. Verify first. The fixture's `verify` rows already exist in our blobs (same
     Ids). Each is re-encoded and compared byte-for-byte with the stored row; if
     the bytes differ, both sides are decoded and the decoded objects compared,
     and any remaining field-path difference aborts the run before anything is
     written. This proves the conversion is faithful to the official encoding
     before new rows are introduced.
  2. Import. Every row under `rows` is inserted when its Id is missing, updated
     only when its encoded bytes differ, and skipped when identical.

Only when a blob actually changed is the manifest/tables entry refreshed and
`master_refresh.refresh()` run to rebuild `out/rows` + `out/structured`, so a
second run writes nothing and leaves the tree clean.

Requires: sqlcipher3 (Python), node (proto encode/decode helper).
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

FIXTURE = f'{BASE}/import/ipr_gacha_memorial_2610.json'
HELPER = f'{BASE}/script/patch_ipr_rows.ts'
MANIFEST = f'{BASE}/out/manifest.json'
TABLES_JSON = f'{BASE}/out/tables.json'
TMP_IN = f'{BASE}/out/_patch_gacha_memorial_2610_in.json'
TMP_OUT = f'{BASE}/out/_patch_gacha_memorial_2610_out.json'

import sqlcipher3.dbapi2 as dbi

fixture = json.load(open(FIXTURE))
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


def encode_rows(table, rows):
    """Encode camelCase fixture rows via the node helper, return {Id: bytes}."""
    json.dump(rows, open(TMP_IN, 'w'))
    subprocess.run(['node', HELPER, table, TMP_IN, TMP_OUT], check=True)
    return {r['Id']: base64.b64decode(r['data']) for r in json.load(open(TMP_OUT))}


def decode_rows(table, rows):
    """Decode base64 proto rows via the node helper, return [{Id, decoded}]."""
    json.dump(rows, open(TMP_IN, 'w'))
    subprocess.run(['node', HELPER, table, TMP_IN, TMP_OUT, '--decode'], check=True)
    return json.load(open(TMP_OUT))


def fetch_rows(table, ids):
    """Read the stored rows with the given Ids as [{Id, data}]."""
    con = open_table(table)
    rows = [
        {'Id': r[0], 'data': base64.b64encode(r[1]).decode()}
        for r in con.execute(
            f'SELECT Id, data FROM {table} WHERE Id IN ({",".join("?" * len(ids))})',
            ids,
        )
    ]
    con.close()
    return rows


def diff_paths(a, b, path=''):
    """Field paths whose decoded values differ (used only when bytes differ)."""
    if type(a) is not type(b) and not (
        isinstance(a, (int, float)) and isinstance(b, (int, float))
    ):
        return [f'{path}: {a!r} != {b!r}']
    if isinstance(a, dict):
        diffs = []
        for k in sorted(set(a) | set(b)):
            if k == '__msg':
                continue
            p = f'{path}.{k}' if path else k
            if k not in a:
                diffs.append(f'{p}: missing in stored row')
            elif k not in b:
                diffs.append(f'{p}: missing in encoded row')
            else:
                diffs += diff_paths(a[k], b[k], p)
        return diffs
    if isinstance(a, list):
        diffs = []
        if len(a) != len(b):
            diffs.append(f'{path}: length {len(a)} != {len(b)}')
        for i, (x, y) in enumerate(zip(a, b)):
            diffs += diff_paths(x, y, f'{path}[{i}]')
        return diffs
    if a != b:
        return [f'{path}: {a!r} != {b!r}']
    return []


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


changed = False

# 1. Verify the fixture against rows already in the blobs. Any real mismatch
#    (bytes differ AND the decoded objects differ) aborts before a single write.
for table, rows in fixture['verify'].items():
    ids = [r['id'] for r in rows]
    stored = {r['Id']: base64.b64decode(r['data']) for r in fetch_rows(table, ids)}
    missing = set(ids) - set(stored)
    if missing:
        raise SystemExit(f'{table} verify: rows missing from blob: {sorted(missing)}')
    encoded = encode_rows(table, rows)

    byte_same = 0
    needs_decode = []
    for rid in ids:
        if stored[rid] == encoded[rid]:
            byte_same += 1
        else:
            needs_decode.append(rid)

    decoded_same = byte_same
    bad = []
    if needs_decode:
        stored_dec = {
            r['Id']: r['decoded']
            for r in decode_rows(
                table,
                [{'Id': rid, 'data': base64.b64encode(stored[rid]).decode()} for rid in needs_decode],
            )
        }
        encoded_dec = {
            r['Id']: r['decoded']
            for r in decode_rows(
                table,
                [{'Id': rid, 'data': base64.b64encode(encoded[rid]).decode()} for rid in needs_decode],
            )
        }
        for rid in needs_decode:
            diffs = diff_paths(stored_dec[rid], encoded_dec[rid])
            if diffs:
                bad.append((rid, diffs))
            else:
                decoded_same += 1

    print(f'{table} verify: {byte_same}/{len(rows)} byte-identical, {decoded_same}/{len(rows)} decoded-equal')
    if bad:
        for rid, diffs in bad:
            print(f'{table} verify MISMATCH {rid}:')
            for line in diffs[:20]:
                print('  ', line)
        raise SystemExit(1)

# 2. Import: insert missing rows, update rows whose bytes changed, skip the rest.
for table, rows in fixture['rows'].items():
    desired = encode_rows(table, rows)
    con = open_table(table)
    inserted = updated = skipped = 0
    for rid, data in desired.items():
        current = con.execute(f'SELECT data FROM {table} WHERE Id = ?', (rid,)).fetchone()
        if current is None:
            con.execute(f'INSERT INTO {table} (Id, data) VALUES (?, ?)', (rid, data))
            inserted += 1
        elif current[0] == data:
            skipped += 1
        else:
            con.execute(f'UPDATE {table} SET data = ? WHERE Id = ?', (data, rid))
            updated += 1
    if inserted or updated:
        con.commit()
    print(f'{table}: wrote {inserted + updated} rows (inserted {inserted}, updated {updated}), skipped {skipped}')
    print(f'{table} rows:', con.execute(f'SELECT COUNT(*) FROM {table}').fetchone()[0])
    con.close()
    changed = finish_table(table) or changed

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
