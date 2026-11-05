#!/bin/bash
# Run every scenario for both builds, alternating Electron and Tauri run by
# run so slow drift in background load hits both equally.
#   scripts/bench/run-all.sh <electron bench .app> <tauri .app> <config.json> <work dir> [runs] [drive runs]
set -u
E="$1"; T="$2"; CFG="$3"; WORK="$4"; RUNS="${5:-5}"; DRUNS="${6:-3}"
HERE="$(cd "$(dirname "$0")" && pwd)"
mkdir -p "$WORK/results"
bench() { # app bundle scenario idx
  node "$HERE/bench.mjs" --app "$1" --bundle "$2" --scenario "$3" --config "$CFG" \
    --work "$WORK/runs/$1-$3-$4" --runs 1 --out "$WORK/results/$1-$3-$4.json" 2>&1 | tail -1 | cut -c1-400
}
# Warm SMB/page cache for every input, then one discarded launch per app.
python3 -I - "$CFG" <<'PY'
import json, sys
c = json.load(open(sys.argv[1]))
files = list(c['seiFiles']) + list(c['exportData']['segments'][0]['files'].values()) + [c['file']]
for f in files:
    with open(f, 'rb') as h:
        while h.read(8 << 20):
            pass
print('warmed', len(files), 'files')
PY
bench electron "$E" idle warmup; bench tauri "$T" idle warmup
for i in $(seq 1 "$RUNS"); do
  for s in idle workflow; do bench electron "$E" $s $i; bench tauri "$T" $s $i; done
done
for i in $(seq 1 "$DRUNS"); do bench electron "$E" drives $i; bench tauri "$T" drives $i; done
echo ALL DONE
