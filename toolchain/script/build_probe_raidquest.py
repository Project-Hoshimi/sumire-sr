#!/usr/bin/env python3
"""Phase A2 probe — build a `RaidQuest` master partition the client has no type for.

Opt-in probe for unknown-partition behaviour: the game client has no
`Solis.Common.Proto.Master.RaidQuest` protobuf type and no such partition in the
harvested manifest. Advertising one lets us watch what the client does with a
`MasterTagPack` it cannot decode (see `SUMIRE_MASTER_PROBE_RAIDQUEST` in
`fastify-api/src/services/master.ts`).

Rows come from the shard's master dump (`git -C /Users/david/ipr-master-diff show
HEAD:RaidQuest.json`, camelCase JSON). They are encoded as protobuf with the
`MarathonRaidQuest` / `MarathonRaidQuestDifficulty` message shapes from
`papi.proto` as the stand-in schema — `build_probe_raidquest.ts` maps the JSON
keys by name and encodes through the server's registry, reporting any key that
has no matching field.

The blob uses the same container the harvested master uses and the patch scripts
rewrite: a SQLCipher 4 database (page size 4096, `PRAGMA key = "x'<hex>'"` raw
key, i.e. no KDF) with one table named after the partition and a `data` BLOB per
row. Rather than reimplementing that crypto, this imports the sqlcipher binding
and the pragma both `extract_rows.py` and `build_title_variants.py` use.

Writes `phaseA2/blobs_probe/RaidQuest` and its manifest-shaped entry
`phaseA2/blobs_probe/RaidQuest.json`, then decrypts the blob back and asserts the
six rows round-trip byte for byte.

Requires: sqlcipher3 (Python), node, git.
"""
import base64
import hashlib
import json
import os
import secrets
import shutil
import subprocess
import sys
import tempfile

import sqlcipher3.dbapi2 as dbi

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.dirname(os.path.dirname(SCRIPT_DIR))
BASE = os.path.join(os.environ.get('SUMIRE_DATA_DIR') or REPO_ROOT, 'phaseA2')
PROBE_DIR = f'{BASE}/blobs_probe'
BLOB = f'{PROBE_DIR}/RaidQuest'
ENTRY = f'{PROBE_DIR}/RaidQuest.json'
HELPER = f'{SCRIPT_DIR}/build_probe_raidquest.ts'
SOURCE_REPO = '/Users/david/ipr-master-diff'
SOURCE_FILE = 'RaidQuest.json'
TABLE = 'RaidQuest'
# Harvested packs carry 60 hex chars (30 raw bytes) as the SQLCipher key.
KEY_BYTES = 30
EXPECTED_ROWS = 6


def read_rows():
    """Read the shard's RaidQuest rows (camelCase JSON) out of the dump repo."""
    raw = subprocess.run(
        ['git', '-C', SOURCE_REPO, 'show', f'HEAD:{SOURCE_FILE}'],
        check=True, capture_output=True,
    ).stdout
    rows = json.loads(raw)
    if len(rows) != EXPECTED_ROWS:
        print(f'warning: expected {EXPECTED_ROWS} rows, dump has {len(rows)}')
    return rows


def encode_rows(rows, workdir):
    """Encode rows via the registry-backed helper; returns (encoded rows, unmapped)."""
    src = os.path.join(workdir, '_raidquest_rows.json')
    dst = os.path.join(workdir, '_raidquest_encoded.json')
    with open(src, 'w') as f:
        json.dump(rows, f)
    subprocess.run(['node', HELPER, src, dst], check=True)
    result = json.load(open(dst))
    return result['rows'], result['unmapped']


def read_key():
    """Reuse the probe's existing key so re-runs only change the blob, not the entry."""
    try:
        existing = json.load(open(ENTRY))['cryptoKey']
        if isinstance(existing, str) and existing:
            return existing
    except (FileNotFoundError, KeyError, json.JSONDecodeError):
        pass
    return secrets.token_hex(KEY_BYTES)


def build_blob(encoded, crypto_key):
    """Write a fresh single-table SQLCipher database, same shape as a harvested pack."""
    os.makedirs(PROBE_DIR, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix='_probe_raidquest_', suffix='.db', dir=PROBE_DIR)
    os.close(fd)
    try:
        con = dbi.connect(tmp)
        con.execute(f"PRAGMA key = \"x'{crypto_key}'\"")
        # The harvested packs declare STRING/TEXT primary keys next to `data`.
        con.execute(f'CREATE TABLE {TABLE}(Id STRING, data BLOB, PRIMARY KEY(Id))')
        con.executemany(
            f'INSERT INTO {TABLE} (Id, data) VALUES (?, ?)',
            [(r['Id'], base64.b64decode(r['data'])) for r in encoded],
        )
        con.commit()
        con.close()
        shutil.move(tmp, BLOB)
    finally:
        if os.path.exists(tmp):
            os.remove(tmp)


def verify(encoded, crypto_key):
    """Decrypt the written blob with the pack key and check every row round-trips."""
    con = dbi.connect(BLOB)
    con.execute(f"PRAGMA key = \"x'{crypto_key}'\"")
    tables = [r[0] for r in con.execute("SELECT name FROM sqlite_master WHERE type='table'")]
    assert tables == [TABLE], f'{BLOB}: expected only table {TABLE}, got {tables}'
    rows = con.execute(f'SELECT Id, data FROM {TABLE}').fetchall()
    con.close()
    assert len(rows) == len(encoded) == EXPECTED_ROWS, (
        f'{BLOB}: expected {EXPECTED_ROWS} rows, decoded {len(rows)}'
    )
    for (row_id, data), expected in zip(rows, encoded):
        assert row_id == expected['Id'], f'{BLOB}: Id {row_id!r} != {expected["Id"]!r}'
        assert bytes(data) == base64.b64decode(expected['data']), f'{BLOB}: data mismatch for {row_id!r}'
    print(f'verified {len(rows)} rows round-trip (sqlcipher decrypt -> Id + proto bytes)')


rows = read_rows()
workdir = tempfile.mkdtemp(prefix='_probe_raidquest_')
try:
    encoded, unmapped = encode_rows(rows, workdir)
finally:
    shutil.rmtree(workdir, ignore_errors=True)

crypto_key = read_key()
build_blob(encoded, crypto_key)
verify(encoded, crypto_key)

blob = open(BLOB, 'rb').read()
sha = hashlib.sha256(blob).hexdigest()
entry = {
    'type': TABLE,
    'fileName': sha,
    'fileSize': len(blob),
    'cryptoKey': crypto_key,
    'downloadUrl': f'https://climaster.game-idolypride.jp/{TABLE}/{sha}',
}
with open(ENTRY, 'w') as f:
    f.write(json.dumps(entry, indent=1) + '\n')

print(f'{TABLE}: blob={BLOB} size={len(blob)} sha256={sha}')
print(f'{TABLE}: entry={ENTRY}')
for scope in ('quest', 'difficulty'):
    keys = unmapped[scope]
    print(f'unmapped {scope} keys: {", ".join(keys) if keys else "none"}')
