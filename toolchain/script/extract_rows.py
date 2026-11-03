#!/usr/bin/env python3
"""Phase A2 — decrypt each climaster blob (SQLCipher) and dump table rows.
Intermediate: out/rows/<Type>.jsonl  (columns + base64 data blob) + out/tables.json (schema info)."""
import sqlcipher3.dbapi2 as dbi, json, os, base64, sys

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.dirname(os.path.dirname(SCRIPT_DIR))
BASE = os.path.join(os.environ.get('SUMIRE_DATA_DIR') or REPO_ROOT, 'phaseA2')
manifest = json.load(open(f'{BASE}/out/manifest.json'))
os.makedirs(f'{BASE}/out/rows', exist_ok=True)
pkey = {p['type']: p for p in manifest['partitions']}
tables = {}

summary = []
for p in manifest['partitions']:
    t = p['type']; path = f'{BASE}/blobs/{t}'
    con = dbi.connect(path)
    con.execute(f"PRAGMA key = \"x'{p['cryptoKey']}'\"")
    tabs = [r[0] for r in con.execute("SELECT name FROM sqlite_master WHERE type='table'")]
    outpath = f'{BASE}/out/rows/{t}.jsonl'
    n = 0
    with open(outpath, 'w') as fo:
        for name in tabs:
            cols = [d[1] for d in con.execute(f'PRAGMA table_info({name})')]
            tables[name] = {'columns': cols, 'fileSize': p['fileSize']}
            data_col = 'data'
            pk_cols = [c for c in cols if c != data_col]
            for row in con.execute(f'SELECT * FROM {name}'):
                rec = {'key': row[:len(pk_cols)] if pk_cols else [], 'data': base64.b64encode(row[-1]).decode()}
                fo.write(json.dumps(rec) + '\n')
                n += 1
    summary.append((t, name if tabs else None, n))

with open(f'{BASE}/out/tables.json', 'w') as f:
    json.dump(tables, f, indent=1)
print(f'extracted {len(summary)} partitions, {sum(s[2] for s in summary)} rows total')

missing = [t for t in manifest['partitions'] if [m for m in open(f'{BASE}/out/rows/{t["type"]}.jsonl')] == [] and t['fileSize'] > 4096]
print('empty-but-large partitions:', [m['type'] for m in missing][:30])
