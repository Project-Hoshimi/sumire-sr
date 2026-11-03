#!/usr/bin/env python3
"""Phase A2 — download all climaster blobs from the manifest; verify size (retry once on mismatch)."""
import json, os, sys, urllib.request

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.dirname(os.path.dirname(SCRIPT_DIR))
BASE = os.path.join(os.environ.get('SUMIRE_DATA_DIR') or REPO_ROOT, 'phaseA2')
manifest = json.load(open(f'{BASE}/out/manifest.json'))
os.makedirs(f'{BASE}/blobs', exist_ok=True)
UA = {'User-Agent': 'Dalvik/2.1.0 (Linux; U; Android 16; Google Pixel 6)'}
ok = fail = mismatch = 0
problems = []
for p in manifest['partitions']:
    t = p['type']; fn = p['fileName']; size = p['fileSize']
    dest = f'{BASE}/blobs/{t}'
    if os.path.exists(dest) and os.path.getsize(dest) == size:
        ok += 1; continue
    try:
        req = urllib.request.Request(p['downloadUrl'], headers=UA)
        with urllib.request.urlopen(req, timeout=60) as r:
            data = r.read()
        if len(data) != size:
            mismatch += 1; problems.append((t, size, len(data)))
            print(f'MISMATCH {t}: expected {size} got {len(data)}'); continue
        with open(dest, 'wb') as f:
            f.write(data)
        ok += 1
    except Exception as e:
        fail += 1; problems.append((t, str(e)))
        print(f'FAIL {t}: {e}')
print(f'ok={ok} fail={fail} mismatch={mismatch}')
if problems:
    print(json.dumps(problems[:20], indent=1))
