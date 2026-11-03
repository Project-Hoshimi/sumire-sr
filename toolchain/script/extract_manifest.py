#!/usr/bin/env python3
"""Phase A2 — extract full Master:Get manifest into out/manifest.json"""
import json, sys, os

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.dirname(os.path.dirname(SCRIPT_DIR))
BASE = os.path.join(os.environ.get('SUMIRE_DATA_DIR') or REPO_ROOT, 'phaseA2')

def rv(buf, i):
    v = 0; s = 0
    while True:
        b = buf[i]; i += 1
        v |= (b & 0x7f) << s
        if not (b & 0x80): return v, i
        s += 7

def rl(buf, i):
    L, i = rv(buf, i)
    return buf[i:i + L], i + L

def fields(buf):
    i = 0; out = []
    while i < len(buf):
        tag, i = rv(buf, i); f = tag >> 3; wt = tag & 7
        if wt == 0:
            v, i = rv(buf, i); out.append((f, 0, v)); continue
        if wt == 2:
            v, i = rl(buf, i); out.append((f, 2, v)); continue
        if wt == 5:
            out.append((f, 5, buf[i:i+4])); i += 4; continue
        raise ValueError(f'wiretype {wt} at {i}')
    return out

def main():
    src = sys.argv[1] if len(sys.argv) > 1 else os.path.join(BASE, 'raw', '00004.resp-plain.Master:Get.bin')
    raw = open(src, 'rb').read()
    outer = fields(raw)
    tag = next(v for f, wt, v in outer if f == 1)
    fs = fields(tag)
    version = next(v for f, wt, v in fs if f == 1).decode()
    packs = [v for f, wt, v in fs if f == 2]
    manifest = {'version': version, 'partitions': []}
    for p in packs:
        pf = {f: (v.decode() if wt == 2 else v) for f, wt, v in fields(p)}
        manifest['partitions'].append({
            'type': pf[1], 'fileName': pf[2], 'fileSize': pf[3],
            'cryptoKey': pf[4], 'downloadUrl': pf[5],
        })
    os.makedirs(os.path.join(BASE, 'out'), exist_ok=True)
    with open(os.path.join(BASE, 'out', 'manifest.json'), 'w') as f:
        json.dump(manifest, f, indent=1)
    total = sum(p['fileSize'] for p in manifest['partitions'])
    print(f'version={version} partitions={len(packs)} total_bytes={total} ({total/1024/1024:.1f} MiB)')

if __name__ == '__main__':
    main()
