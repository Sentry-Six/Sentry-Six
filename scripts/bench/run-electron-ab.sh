#!/bin/bash
# Electron before/after benchmark: the same scenarios as run-all.sh, for two
# Electron bench apps (make-electron-bench-app.cjs), alternating run by run.
#   scripts/bench/run-electron-ab.sh <before bench .app> <after bench .app> <config.json> <work dir> [runs] [drive runs] [cold gap s] [first round]
# [first round] resumes an interrupted run: rounds before it keep their results.
#
# Day-switch and folder-open timings on an SMB share depend on whether macOS
# still caches that directory listing: a listing is cached for roughly 35-70 s
# after the share last enumerated it (cold: ~0.1 ms per entry; warm: tens of
# ms). The Electron-vs-Tauri runs alternated apps without a pause, so the
# second app usually hit a warm cache. Here every workflow run waits
# COLD_GAP seconds first, so both builds always list cold folders.
set -u
A="$1"; B="$2"; CFG="$3"; WORK="$4"; RUNS="${5:-5}"; DRUNS="${6:-3}"; COLD_GAP="${7:-90}"; FIRST="${8:-1}"
HERE="$(cd "$(dirname "$0")" && pwd)"
mkdir -p "$WORK/results"
bench() { # label bundle scenario idx
  node "$HERE/bench.mjs" --app electron --label "$1" --bundle "$2" --scenario "$3" --config "$CFG" \
    --work "$WORK/runs/$1-$3-$4" --runs 1 --out "$WORK/results/$1-$3-$4.json" 2>&1 | tail -1 | cut -c1-400
}
# Warm the page cache for every file input (not directory listings), then one
# discarded launch per app.
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
bench before "$A" idle warmup; bench after "$B" idle warmup
for i in $(seq "$FIRST" "$RUNS"); do
  # Alternate which build goes first.
  if [ $((i % 2)) -eq 1 ]; then first=before; fa="$A"; second=after; sa="$B"; else first=after; fa="$B"; second=before; sa="$A"; fi
  bench "$first" "$fa" idle "$i"; bench "$second" "$sa" idle "$i"
  sleep "$COLD_GAP"; bench "$first" "$fa" workflow "$i"
  sleep "$COLD_GAP"; bench "$second" "$sa" workflow "$i"
done
for i in $(seq 1 "$DRUNS"); do bench before "$A" drives "$i"; bench after "$B" drives "$i"; done
echo ALL DONE
