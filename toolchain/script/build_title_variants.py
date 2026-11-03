#!/usr/bin/env python3
"""Phase A2 — build one TitleBackground master variant per anniversary asset.

The client shows the title background with the highest priority whose
StartTime..EndTime window contains now, so a single-row table is enough to pick
the login screen. This copies the harvested TitleBackground blob four times,
rewrites each copy to hold exactly one row for one asset id (23-0624, 24-0624,
25-0624, 26-0624) and stores the resulting SQLCipher files under
`phaseA2/blobs_title/<sha256>`, indexed by `phaseA2/out/title_variants.json`.
The sandbox profile then serves a random variant from that list on each login.

Requires: sqlcipher3 (Python).
"""
import hashlib
import json
import os
import shutil
import tempfile

import sqlcipher3.dbapi2 as dbi

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.dirname(os.path.dirname(SCRIPT_DIR))
BASE = os.path.join(os.environ.get('SUMIRE_DATA_DIR') or REPO_ROOT, 'phaseA2')
TABLE = 'TitleBackground'
MANIFEST = f'{BASE}/out/manifest.json'
VARIANTS_JSON = f'{BASE}/out/title_variants.json'
VARIANTS_DIR = f'{BASE}/blobs_title'

ASSET_IDS = ['23-0624', '24-0624', '25-0624', '26-0624']
START_TIME = 1609459200000
END_TIME = 4102444800000
PRIORITY = 1


def varint(value):
    """Encode a non-negative integer as a protobuf base-128 varint."""
    out = bytearray()
    while True:
        byte = value & 0x7F
        value >>= 7
        out.append(byte | 0x80 if value else byte)
        if not value:
            return bytes(out)


def field_str(number, text):
    raw = text.encode()
    return varint(number << 3 | 2) + varint(len(raw)) + raw


def field_varint(number, value):
    return varint(number << 3 | 0) + varint(value)


def encode_title_background(row_id, asset_id):
    """Encode Solis.Common.Proto.Master.TitleBackground fields 1,2,3,6,7,8."""
    return (
        field_str(1, row_id)
        + field_str(2, asset_id)
        + field_varint(3, 1)
        + field_varint(6, START_TIME)
        + field_varint(7, END_TIME)
        + field_varint(8, PRIORITY)
    )


def decode_id(data):
    """Read field 1 (the Id string) back out of an encoded TitleBackground."""
    pos = 0
    while pos < len(data):
        key = 0
        shift = 0
        while True:
            byte = data[pos]
            pos += 1
            key |= (byte & 0x7F) << shift
            shift += 7
            if not (byte & 0x80):
                break
        number, wire = key >> 3, key & 7
        if wire == 0:
            while data[pos] & 0x80:
                pos += 1
            pos += 1
        elif wire == 2:
            length = 0
            shift = 0
            while True:
                byte = data[pos]
                pos += 1
                length |= (byte & 0x7F) << shift
                shift += 7
                if not (byte & 0x80):
                    break
            value = data[pos:pos + length]
            pos += length
            if number == 1:
                return value.decode()
        else:
            raise ValueError(f'unsupported wire type {wire} for field {number}')
    raise ValueError('TitleBackground row has no Id field')


def open_variant(path, crypto_key):
    con = dbi.connect(path)
    con.execute(f"PRAGMA key = \"x'{crypto_key}'\"")
    return con


manifest = json.load(open(MANIFEST))
part = next(p for p in manifest['partitions'] if p['type'] == TABLE)
source_blob = f'{BASE}/blobs/{TABLE}'

os.makedirs(VARIANTS_DIR, exist_ok=True)
variants = []

for asset_id in ASSET_IDS:
    row_id = f'title-anniversary-01-{asset_id}-01'
    data = encode_title_background(row_id, asset_id)

    fd, tmp = tempfile.mkstemp(prefix='_title_variant_', suffix='.db', dir=BASE)
    os.close(fd)
    shutil.copy2(source_blob, tmp)

    con = open_variant(tmp, part['cryptoKey'])
    con.execute(f'DELETE FROM {TABLE}')
    con.execute(f'INSERT INTO {TABLE} (Id, data) VALUES (?, ?)', (row_id, data))
    con.commit()
    con.close()

    blob = open(tmp, 'rb').read()
    file_name = hashlib.sha256(blob).hexdigest()
    target = os.path.join(VARIANTS_DIR, file_name)
    os.replace(tmp, target)
    variants.append({
        'assetId': asset_id,
        'id': row_id,
        'fileName': file_name,
        'fileSize': len(blob),
    })
    print(f'{asset_id}: {row_id} -> {file_name} ({len(blob)} bytes)')

with open(VARIANTS_JSON, 'w') as f:
    f.write(json.dumps(variants, indent=1))

for variant in variants:
    path = os.path.join(VARIANTS_DIR, variant['fileName'])
    con = open_variant(path, part['cryptoKey'])
    rows = con.execute(f'SELECT Id, data FROM {TABLE}').fetchall()
    con.close()
    assert len(rows) == 1, f"{variant['fileName']}: expected 1 row, got {len(rows)}"
    assert rows[0][0] == variant['id'], f"{variant['fileName']}: Id {rows[0][0]!r} != {variant['id']!r}"
    assert decode_id(bytes(rows[0][1])) == variant['id'], (
        f"{variant['fileName']}: decoded Id does not match {variant['id']!r}"
    )
    print(f"verified {variant['assetId']}: {variant['id']}")
