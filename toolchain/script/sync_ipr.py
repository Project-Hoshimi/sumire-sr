#!/usr/bin/env python3
"""Phase A2 — add-only sync of the official IPR master dump into our blobs.

The official dump (github MalitsPlus/ipr-master-diff) holds one `<Table>.json` per
master table with camelCase protobuf-JSON rows. This script inserts the rows we do
not have yet into the matching `phaseA2/blobs/<Table>` SQLCipher blob, one table at
a time, and never updates or deletes an existing row.

The row key is whatever the blob's primary key is:
  - tables whose IPR rows have `id` -> the blob's `Id` column;
  - tables without `id` (their message has no `Id` field) -> the blob's own key
    columns (`LevelKey`, `CardId` + `DisplayType`, `HomeTalkId`, ...), each mapped
    from the same lowerFirst field of the IPR row. If a key column has no IPR field,
    has duplicate values, the table is skipped and reported.

Before inserting, every table is sanity-checked: up to 20 rows that exist on both
sides are re-encoded and compared with the stored bytes (and, when the bytes were
just ordered differently, the decoded objects). Tables where every sampled row
mismatches are not inserted into.

Changed tables get their manifest/tables sha, size and version refreshed
(`finish_table`) and `master_refresh.refresh()` runs once at the end, so
out/rows + out/structured follow the blobs. A second run inserts nothing and
leaves the tree clean.

The run report lands in `phaseA2/import/ipr_sync_<commit>.json`.

Usage:
  python3 phaseA2/script/sync_ipr.py --ipr-dir /Users/david/ipr-master-diff
  python3 phaseA2/script/sync_ipr.py --ipr-dir <dir> --tables Card,Costume --dry-run

Requires: sqlcipher3 (Python), node (proto encode/decode helper).
"""
import argparse
import base64
import json
import os
import re
import subprocess
import sys

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, SCRIPT_DIR)
import master_blob
from master_blob import BASE, diff_paths

MANIFEST = f'{BASE}/out/manifest.json'
IMPORT_DIR = f'{BASE}/import'
TMP_IN = f'{BASE}/out/_sync_ipr_in.json'
TMP_OUT = f'{BASE}/out/_sync_ipr_out.json'
SAMPLE_SIZE = 20
INT_RE = re.compile(r'^[+-]?\d+$')
REAL_RE = re.compile(r'^[+-]?(\d+\.\d*|\.\d+|\d+)([eE][+-]?\d+)?$')


def ipr_source(ipr_dir):
    """Read the checkout's HEAD commit and master version from the IPR dir."""
    def git(*args):
        return subprocess.run(['git', '-C', ipr_dir, *args], check=True,
                              capture_output=True, text=True).stdout.strip()

    commit = git('rev-parse', 'HEAD')
    version_path = os.path.join(ipr_dir, '!version.txt')
    if not os.path.exists(version_path):
        raise SystemExit(f'{ipr_dir}: !version.txt not found')
    master_version = open(version_path).read().strip()
    return {
        'repo': 'github.com/MalitsPlus/ipr-master-diff',
        'commit': commit,
        'commitShort': commit[:7],
        'masterVersion': master_version,
    }


def normalise(value, affinity):
    """Map an IPR value onto the representation SQLite stores in a key column.

    Columns are declared with proto-ish types (`Id STRING`, `Level INT32`, ...), so
    the stored value is what SQLite's column affinity makes of it: numeric-looking
    text in a NUMERIC/INTEGER column lands as an integer (`'-001'` -> `-1`), text
    stays text. Matching IPR keys against stored keys has to use the same rule.
    """
    if isinstance(value, bool):
        return int(value)
    if affinity == 'BLOB':
        return value
    # 1.0 -> 1, so a float with an integral value matches the stored integer key
    # (and the text form of it: "1", not "1.0").
    if isinstance(value, float) and value.is_integer():
        value = int(value)
    if affinity == 'TEXT':
        return value if isinstance(value, str) else str(value)
    if isinstance(value, (int, float)):
        return value
    if isinstance(value, str):
        text = value.strip()
        numeric = affinity in ('INTEGER', 'NUMERIC')
        if INT_RE.match(text):
            return int(text)
        if REAL_RE.match(text):
            number = float(text)
            return int(number) if numeric and number.is_integer() else number
    return value


def key_affinities(declared_types):
    """Per-column SQLite affinity from the blob schema."""
    return [master_blob.column_affinity(t) for t in declared_types]


def key_string(key):
    """Stable text form of a key tuple, used for sorting and reporting."""
    return repr(key)


def sample_keys(keys):
    """Up to SAMPLE_SIZE keys spread evenly over the sorted key list."""
    ordered = sorted(keys, key=key_string)
    if len(ordered) <= SAMPLE_SIZE:
        return ordered
    step = len(ordered) / SAMPLE_SIZE
    return [ordered[min(int(i * step), len(ordered) - 1)] for i in range(SAMPLE_SIZE)]


def sync_table(table, ipr_rows, manifest, tables, dry_run):
    """Insert the IPR rows missing from `table`. Returns (inserted keys, stats, skip)."""
    part = master_blob.partition(manifest, table)
    if part is None:
        return None, None, 'no manifest partition (blob would have to be created)'

    columns, declared_types, rows = master_blob.read_table(table, manifest)
    stored = dict(rows)
    affinities = key_affinities(declared_types)
    fields = [master_blob.lower_first(c) for c in columns]

    # 1. Resolve the key of every IPR row from the blob's key columns. A field has
    #    to be present in *all* rows: a row without it would otherwise raise
    #    KeyError below (absent fields are not defaulted to the proto zero value).
    missing_fields = set()
    for f in fields:
        if not all(f in r for r in ipr_rows):
            missing_fields.add(f)
    if missing_fields:
        return None, None, (
            f'key fields absent from IPR rows: {sorted(missing_fields)} '
            f'(blob key columns {columns})'
        )

    keys = []
    for r in ipr_rows:
        keys.append(tuple(normalise(r[f], a) for f, a in zip(fields, affinities)))
    if len(set(keys)) != len(keys):
        return None, None, (
            f'duplicate keys from {columns}: {len(keys)} rows, '
            f'{len(set(keys))} distinct'
        )

    stored_set = set(stored)
    # A non-empty table where not a single IPR key matches means our key
    # normalisation is wrong, not that the whole table is new: refuse to insert.
    if stored and not any(k in stored_set for k in keys):
        return None, None, 'no key overlap; key normalisation suspect'

    missing_idx = [i for i, k in enumerate(keys) if k not in stored_set]

    # 2. Encode every IPR row once: needed for the rows to insert, and it gives the
    #    converter's dropped-key summary plus the sample for the sanity check.
    encoded, dropped = master_blob.encode_rows(
        table, ipr_rows, TMP_IN, TMP_OUT, key_cols=None if columns == ['Id'] else columns
    )

    # 3. Sanity check against rows that exist on both sides.
    both = [i for i, k in enumerate(keys) if k in stored_set]
    index_of = {k: i for i, k in enumerate(keys)}
    sample = sorted(index_of[k] for k in sample_keys([keys[i] for i in both]))
    byte_same = []
    byte_diff = []
    for i in sample:
        data = base64.b64decode(encoded[i]['data'])
        if stored[keys[i]] == data:
            byte_same.append(i)
        else:
            byte_diff.append(i)

    mismatched = []
    if byte_diff:
        stored_rows = [{'Id': key_string(keys[i]), 'data': base64.b64encode(stored[keys[i]]).decode()}
                       for i in byte_diff]
        enc_rows = [{'Id': key_string(keys[i]), 'data': encoded[i]['data']} for i in byte_diff]
        stored_dec = {r['Id']: r['decoded'] for r in
                      master_blob.decode_rows(table, stored_rows, TMP_IN, TMP_OUT)}
        enc_dec = {r['Id']: r['decoded'] for r in
                   master_blob.decode_rows(table, enc_rows, TMP_IN, TMP_OUT)}
        for i in byte_diff:
            rid = key_string(keys[i])
            if diff_paths(stored_dec[rid], enc_dec[rid]):
                mismatched.append(i)

    stats = {
        'iprRows': len(ipr_rows),
        'storedRows': len(stored),
        'sampled': len(sample),
        'byteIdentical': len(byte_same),
        'decodedEqual': len(byte_same) + (len(byte_diff) - len(mismatched)),
        'mismatched': len(mismatched),
        'dropped': dropped,
    }
    if len(sample) >= 1 and len(mismatched) == len(sample):
        stats['missing'] = len(missing_idx)
        return None, stats, (
            f'all {len(sample)} sampled rows re-encode to different bytes and '
            f'different decoded values than the stored rows'
        )
    stats['missing'] = len(missing_idx)

    if not missing_idx:
        return [], stats, None

    if dry_run:
        return [keys[i] for i in missing_idx], stats, None

    con = master_blob.open_table(table, manifest)
    placeholders = ','.join('?' * (len(columns) + 1))
    col_list = ','.join(f'"{c}"' for c in columns)
    written, conflicts = [], []
    for i in missing_idx:
        try:
            con.execute(
                f'INSERT INTO {table} ({col_list}, data) VALUES ({placeholders})',
                (*keys[i], base64.b64decode(encoded[i]['data'])),
            )
        except master_blob.dbi.IntegrityError:
            # The stored key is only "missing" under our normalisation, not under
            # SQLite's comparison rules: leave the existing row alone (add-only).
            conflicts.append(keys[i])
            continue
        written.append(keys[i])
    con.commit()
    con.close()
    if conflicts:
        stats['conflicts'] = [report_keys([c])[0] for c in conflicts]
        print(f'  {len(conflicts)} keys already present under SQLite comparison, '
              f'not inserted: {stats["conflicts"][:5]}'
              f"{' ...' if len(conflicts) > 5 else ''}")
    return written, stats, None


def report_keys(keys):
    """Report form of a key: the value for a single column, else the tuple list."""
    if not keys:
        return []
    if all(len(k) == 1 for k in keys):
        return [k[0] for k in keys]
    return [list(k) for k in keys]


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument('--ipr-dir', required=True, help='ipr-master-diff checkout')
    ap.add_argument('--tables', help='comma-separated table filter')
    ap.add_argument('--dry-run', action='store_true',
                    help='do everything except writing blobs/manifest/out')
    args = ap.parse_args()

    ipr_dir = os.path.abspath(args.ipr_dir)
    if not os.path.isdir(ipr_dir):
        raise SystemExit(f'{ipr_dir}: not a directory')
    source = ipr_source(ipr_dir)
    print(f"source: {source['repo']} {source['commitShort']} "
          f"masterVersion {source['masterVersion']}")

    manifest, tables = master_blob.load_manifest()
    manifest_types = {p['type'] for p in manifest['partitions']}

    wanted = None
    if args.tables:
        wanted = {t.strip() for t in args.tables.split(',') if t.strip()}

    ipr_tables = sorted(
        f[:-5] for f in os.listdir(ipr_dir)
        if f.endswith('.json') and f != '!version.txt'
    )
    if wanted is not None:
        ipr_tables = [t for t in ipr_tables if t in wanted]

    inserted = {}
    skipped = {}
    before_after = {}
    refreshed = []
    committed_tables = set()

    try:
        for table in ipr_tables:
            with open(os.path.join(ipr_dir, f'{table}.json')) as f:
                ipr_rows = json.load(f)
            if not ipr_rows:
                skipped[table] = 'no rows in the IPR dump'
                continue
            if table not in manifest_types or not os.path.exists(master_blob.blob_path(table)):
                skipped[table] = 'no blob/manifest partition here (not created: add-only sync)'
                continue

            try:
                keys, stats, skip = sync_table(table, ipr_rows, manifest, tables, args.dry_run)
            except (RuntimeError, subprocess.CalledProcessError,
                    master_blob.dbi.DatabaseError) as err:
                # One bad table (converter refusal, helper crash, SQLCipher error)
                # must not abort the run: record it and keep going.
                skipped[table] = f'{type(err).__name__}: {err}'
                continue

            if skip is not None:
                skipped[table] = skip
                if stats:
                    print(f"Skipped {table}: {skip} "
                          f"(ipr {stats['iprRows']}, stored {stats['storedRows']}, "
                          f"sampled {stats['sampled']}, byte-identical {stats['byteIdentical']}, "
                          f"decoded-equal {stats['decodedEqual']}, mismatched {stats['mismatched']})")
                else:
                    print(f'Skipped {table}: {skip}')
                continue

            dropped = ', '.join(f'{k} x{v}' for k, v in sorted(stats['dropped'].items())) or 'none'
            print(f"{table}: ipr {stats['iprRows']}, stored {stats['storedRows']}, "
                  f"missing {stats['missing']}, sampled {stats['sampled']} "
                  f"(byte-identical {stats['byteIdentical']}, "
                  f"decoded-equal {stats['decodedEqual']}, mismatched {stats['mismatched']}); "
                  f"dropped paths: {dropped}")

            if keys:
                inserted[table] = report_keys(keys)
                before_after[table] = (stats['storedRows'], stats['storedRows'] + len(keys))
                verb = 'would insert' if args.dry_run else 'inserted'
                print(f'  {verb} {len(keys)} rows')
                if not args.dry_run:
                    # sync_table committed this blob's rows; only these tables
                    # need their manifest/tables entry refreshed.
                    committed_tables.add(table)
    finally:
        # 4. Refresh the manifest/tables entries of the blobs this run wrote.
        #    Then rebuild the decoded output once. Done in `finally` so a crash
        #    mid-loop still repairs a blob committed earlier in this run.
        if not args.dry_run:
            for table in sorted(committed_tables):
                try:
                    if master_blob.finish_table(table, manifest, tables):
                        refreshed.append(table)
                except (master_blob.dbi.DatabaseError, OSError, KeyError) as err:
                    skipped[table] = f'manifest refresh failed: {err}'
            if refreshed:
                master_blob.write_manifest(manifest, tables)
                print('manifest version =', manifest['version'])
                master_blob.refresh()

    if args.dry_run:
        if inserted:
            print(f"[dry-run] {len(inserted)} tables, "
                  f"{sum(len(v) for v in inserted.values())} rows would be inserted")
        else:
            print('no rows inserted; nothing changed')
    elif not inserted and not refreshed:
        print('no rows inserted; nothing changed')

    # 5. Run report.
    report_path = f"{IMPORT_DIR}/ipr_sync_{source['commitShort']}.json"
    if inserted and not args.dry_run:
        os.makedirs(IMPORT_DIR, exist_ok=True)
        json.dump({'source': source, 'inserted': inserted, 'skipped': skipped},
                  open(report_path, 'w'), indent=1)
        print('report written ->', report_path)
    elif os.path.exists(report_path):
        print('report unchanged ->', report_path)
    else:
        print('[dry-run] report would be written ->', report_path)

    if before_after:
        print('row counts: ' + ', '.join(f'{t} {b} -> {a}' for t, (b, a) in before_after.items()))
    if skipped:
        print('skipped: ' + ', '.join(sorted(skipped)))

    for tmp in (TMP_IN, TMP_OUT):
        if os.path.exists(tmp):
            os.remove(tmp)
    return 0


if __name__ == '__main__':
    sys.exit(main())
