#!/usr/bin/env python3
"""Phase A2 — shared helpers for reading and patching the SQLCipher master blobs.

`phaseA2/blobs/<Table>` is a SQLCipher DB holding one table whose columns are the
protobuf primary-key fields plus a `data` BLOB (the encoded row). The key can be
a single `Id` TEXT column (most tables) or the proto's own key fields
(`LevelKey`, `CardId` + `DisplayType`, ...) for messages that have no `Id` field.

Helpers:
  load_manifest()            manifest.json + tables.json
  read_table()               columns, stored keys and base64 data of a blob
  encode_rows()              camelCase rows -> encoded rows via patch_ipr_rows.ts
  decode_rows()              base64 rows -> decoded objects via the same helper
  diff_paths()               field paths where two decoded rows differ
  finish_table()             refresh manifest/tables sha, size and version
  refresh()                  rebuild out/rows + out/structured (master_refresh.py)

This module is imported by `sync_ipr.py`; the older `patch_*.py` scripts carry
their own copies of the same few functions.
"""
import base64
import hashlib
import json
import os
import subprocess
import sys

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.dirname(os.path.dirname(SCRIPT_DIR))
BASE = os.path.join(os.environ.get('SUMIRE_DATA_DIR') or REPO_ROOT, 'phaseA2')

MANIFEST = f'{BASE}/out/manifest.json'
TABLES_JSON = f'{BASE}/out/tables.json'
HELPER = f'{BASE}/script/patch_ipr_rows.ts'

import sqlcipher3.dbapi2 as dbi


def load_manifest():
    """Return (manifest, tables) as loaded from out/manifest.json + out/tables.json."""
    return json.load(open(MANIFEST)), json.load(open(TABLES_JSON))


def partition(manifest, table):
    """The manifest partition entry for `table`, or None when absent."""
    return next((p for p in manifest['partitions'] if p['type'] == table), None)


def blob_path(table):
    return f'{BASE}/blobs/{table}'


def open_table(table, manifest):
    """Open the SQLCipher blob for `table` with the manifest's key."""
    part = partition(manifest, table)
    con = dbi.connect(blob_path(table))
    con.execute(f"PRAGMA key = \"x'{part['cryptoKey']}'\"")
    return con


def read_table(table, manifest):
    """Return (key_columns, declared_types, rows), rows as [(key_tuple, data_bytes)]."""
    con = open_table(table, manifest)
    info = [(d[1], d[2]) for d in con.execute(f'PRAGMA table_info({table})')]
    rows = [(tuple(r[:len(info) - 1]), r[-1]) for r in con.execute(f'SELECT * FROM {table}')]
    con.close()
    return [c for c, _ in info[:-1]], [t for _, t in info[:-1]], rows


def column_affinity(declared_type):
    """SQLite column affinity of a declared type (see datatype3.html, 3.1)."""
    d = (declared_type or '').upper()
    if 'INT' in d:
        return 'INTEGER'
    if 'CHAR' in d or 'CLOB' in d or 'TEXT' in d:
        return 'TEXT'
    if d == '' or 'BLOB' in d:
        return 'BLOB'
    if 'REAL' in d or 'FLOA' in d or 'DOUB' in d:
        return 'REAL'
    return 'NUMERIC'


def lower_first(name):
    """`LevelKey` -> `levelKey`, matching the IPR camelCase field names."""
    return name[:1].lower() + name[1:]


def encode_rows(table, rows, tmp_in, tmp_out, key_cols=None):
    """Encode camelCase IPR rows, return (encoded rows in input order, dropped map).

    `key_cols` (PascalCase) must be given for messages without an `Id` field; the
    encoded rows then carry `keys` alongside `Id`.
    """
    json.dump(rows, open(tmp_in, 'w'))
    cmd = ['node', HELPER, table, tmp_in, tmp_out]
    if key_cols:
        cmd += ['--key-cols', ','.join(key_cols)]
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        raise RuntimeError(f'{table}: patch_ipr_rows.ts failed: {proc.stderr.strip()[-500:]}')
    encoded = json.load(open(tmp_out))
    if len(encoded) != len(rows):
        raise RuntimeError(f'{table}: helper returned {len(encoded)} rows for {len(rows)}')

    dropped = {}
    for line in proc.stdout.splitlines():
        if 'dropped paths:' in line:
            summary = line.split('dropped paths:', 1)[1].strip()
            if summary and summary != 'none':
                for item in summary.split(', '):
                    path, _, count = item.rpartition(' x')
                    dropped[path] = int(count)
    return encoded, dropped


def decode_rows(table, rows, tmp_in, tmp_out):
    """Decode [{Id, data}] via the node helper, return [{Id, decoded}]."""
    json.dump(rows, open(tmp_in, 'w'))
    subprocess.run(['node', HELPER, table, tmp_in, tmp_out, '--decode'],
                   check=True, capture_output=True, text=True)
    return json.load(open(tmp_out))


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


def finish_table(table, manifest, tables):
    """Refresh the manifest/tables entries for `table`; False when unchanged."""
    blob = blob_path(table)
    part = partition(manifest, table)
    with open(blob, 'rb') as f:
        new_sha = hashlib.sha256(f.read()).hexdigest()
    new_size = os.path.getsize(blob)
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


def write_manifest(manifest, tables):
    json.dump(manifest, open(MANIFEST, 'w'), indent=1)
    json.dump(tables, open(TABLES_JSON, 'w'), indent=1)


def refresh():
    """Rebuild out/rows and out/structured from the current blobs + manifest."""
    if SCRIPT_DIR not in sys.path:
        sys.path.insert(0, SCRIPT_DIR)
    import master_refresh

    master_refresh.refresh()
