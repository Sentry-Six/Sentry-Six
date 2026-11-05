#!/usr/bin/env node
// Summarize scripts/bench/run-all.sh results into a Markdown table (medians,
// with min–max) and a JSON blob.
//   node scripts/bench/summarize.mjs <work dir>/results [labelA,labelB] > table.md
// Labels default to electron,tauri (the builds' --label, else --app).
import fs from 'node:fs';
import path from 'node:path';

const dir = process.argv[2];
const LABELS = (process.argv[3] || 'electron,tauri').split(',');
const runs = {};
for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.json') && !f.includes('warmup'))) {
  const d = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
  for (const r of d.runs) (runs[`${d.label || d.app}/${d.scenario}`] ||= []).push(r);
}
const median = (xs) => {
  const v = xs.filter((x) => typeof x === 'number' && Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
};
const stat = (key, scenario, pick) => {
  const out = {};
  for (const app of LABELS) {
    const rs = (runs[`${app}/${scenario}`] || []).filter((r) => !r.error);
    const xs = rs.map(pick);
    out[app] = { median: median(xs), min: Math.min(...xs.filter(Number.isFinite)), max: Math.max(...xs.filter(Number.isFinite)), n: xs.length,
      errors: (runs[`${app}/${scenario}`] || []).filter((r) => r.error).length };
  }
  return { key, ...out };
};
const rows = [
  ['Cold start → first contentful paint (ms)', 'idle', (r) => r.fcpMs],
  ['Cold start → UI ready (ms)', 'idle', (r) => r.uiReadyMs],
  ['Memory, idle 15 s after ready (MB, all processes)', 'idle', (r) => r.memoryMB],
  ['Idle CPU over 60 s (% of one core, all processes)', 'idle', (r) => r.idleCpuPct],
  ['Peak memory during startup+idle (MB)', 'idle', (r) => r.peakMemoryMB],
  ['Open /Volumes/USB → newest day listed (ms)', 'workflow', (r) => r.folderOpen?.ms],
  ['Switch to 2026-10-28 (5,682 files) → clips listed (ms)', 'workflow', (r) => r.dateBig?.ms],
  ['Switch to 2026-10-16 (incl. SavedClips event) (ms)', 'workflow', (r) => r.dateEvent?.ms],
  ['Open SavedClips event → 6 videos loaded (ms)', 'workflow', (r) => r.eventLoaded?.ms],
  ['Press play → all 6 advancing (ms)', 'workflow', (r) => r.playback?.ms],
  ['Telemetry (SEI) for one 60 s driving clip (ms, median of 3 clips)', 'workflow', (r) => median((r.telemetry || []).map((t) => t.ms))],
  ['Export 30 s, 6 cameras, High, VideoToolbox (ms)', 'workflow', (r) => r.export?.ms],
  ['Memory after workflow (MB)', 'workflow', (r) => r.memoryAfterMB],
  ['Peak memory during workflow (MB)', 'workflow', (r) => r.peakMemoryMB],
  ['Load drive-data.json (1.08 GB) → drive list (ms)', 'drives', (r) => r.driveLoad?.ms],
  ['Open largest drive detail (ms)', 'drives', (r) => r.driveDetail?.ms],
  ['Memory after drive-data load (MB)', 'drives', (r) => r.memoryAfterMB],
  ['Peak memory during drive-data load (MB)', 'drives', (r) => r.peakMemoryMB]
].map(([k, s, f]) => stat(k, s, f));

const fmt = (v) => (v == null || !Number.isFinite(v) ? '—' : v >= 100 ? Math.round(v).toLocaleString('en-US') : (+v.toFixed(2)).toString());
const ratio = (e, t) => (e && t ? (e / t >= 1 ? `${(e / t).toFixed(1)}× lower/faster` : `${(t / e).toFixed(1)}× higher/slower`) : '—');
console.log(`| Measure | ${LABELS[0]} (median, min–max) | ${LABELS[1]} (median, min–max) | ${LABELS[1]} vs ${LABELS[0]} |`);
console.log('|---|---|---|---|');
for (const r of rows) {
  const e = r[LABELS[0]], t = r[LABELS[1]];
  const cell = (x) => `${fmt(x.median)} (${fmt(x.min)}–${fmt(x.max)}, n=${x.n}${x.errors ? `, ${x.errors} failed` : ''})`;
  console.log(`| ${r.key} | ${cell(e)} | ${cell(t)} | ${ratio(e.median, t.median)} |`);
}
console.log('\n<!-- raw -->\n```json\n' + JSON.stringify({ rows, loadavg: Object.fromEntries(Object.entries(runs).map(([k, v]) => [k, v.map((r) => r.loadavg?.[0])])) }) + '\n```');
