#!/usr/bin/env python3
"""Phase A2 — refresh the decoded rows and structured JSON from the patched blobs.

The master patch scripts (`patch_*.py`) rewrite `phaseA2/blobs/<Table>` and
`phaseA2/out/manifest.json`, but the server seeds its DB from
`phaseA2/out/structured/<Type>.json`, which a two-step pipeline produces:

  1. `script/extract_rows.py`   blobs -> out/rows/<Type>.jsonl + out/tables.json
  2. `script/decode_master.ts`  rows  -> out/structured/<Type>.json + summaries

`refresh()` runs both, in order, and prints the next step. Child output is
piped through a filter that drops any line mentioning a key, so crypto key
material can never be echoed.

Requires: sqlcipher3 (Python, the one running this script), node.
"""
import os
import subprocess
import sys

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.dirname(os.path.dirname(SCRIPT_DIR))
BASE = os.path.join(os.environ.get('SUMIRE_DATA_DIR') or REPO_ROOT, 'phaseA2')

# (argv, cwd-relative script) run in order; the first step's interpreter is the
# one running this script, so the sqlcipher venv is carried through.
STEPS = (
    (sys.executable, os.path.join('script', 'extract_rows.py')),
    ('node', os.path.join('script', 'decode_master.ts')),
)

NEXT_STEP = 'structured JSON refreshed; next: (cd fastify-api && npm run db:seed-master)'


def run_step(argv):
    """Run `argv` in BASE, echoing its output except lines that mention a key."""
    proc = subprocess.Popen(
        argv,
        cwd=BASE,
        env=os.environ.copy(),
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        encoding='utf-8',
        errors='replace',
        bufsize=1,
    )
    try:
        for line in proc.stdout:
            if 'key' in line.lower():
                continue
            sys.stdout.write(line)
            sys.stdout.flush()
    finally:
        proc.stdout.close()
        code = proc.wait()
    if code != 0:
        raise subprocess.CalledProcessError(code, argv)


def refresh():
    """Rebuild out/rows and out/structured from the current blobs + manifest."""
    for argv in STEPS:
        run_step(argv)
    print(NEXT_STEP)


if __name__ == '__main__':
    refresh()
