#!/usr/bin/env node
// 3-arm 검색 품질 릴리스 게이트 (spec §8.3). 사용:
//   RG_DIR=<hub>/raw/next-p/three-arm node test/release-gate/three-arm.mjs
import { spawnSync, execSync } from 'node:child_process';
import fs from 'node:fs'; import path from 'node:path';

const RG = process.env.RG_DIR;
if (!RG) { console.error('RG_DIR required'); process.exit(2); }
execSync('shasum -c FROZEN.sha256', { cwd: RG, stdio: 'inherit' });        // r5-2: 동결 강제
const load = (f) => JSON.parse(fs.readFileSync(path.join(RG, f), 'utf-8'));
const baseline = load('baseline-old.json');
const baseMap = new Map(baseline.results.map(r => [r.probeId, r]));
const P = (f) => path.join(RG, f);
function child(db, args) {
  const r = spawnSync(process.execPath, [new URL('arm-run.mjs', import.meta.url).pathname, ...args],
    { env: { ...process.env, DB_FILE_PATH: db }, stdio: ['ignore', 'inherit', 'inherit'] });
  if (r.status !== 0) { console.error(`child FAIL: ${args.join(' ')}`); process.exit(1); }
}
const jaccard = (a, b) => { const A = new Set(a), B = new Set(b);
  const inter = [...A].filter(x => B.has(x)).length; return inter / Math.max(1, new Set([...a, ...b]).size); };

// old-arm 기준치 (old.db 는 동결본 — 냉동 파일이라 cp 안전, 사본으로만 연다)
fs.copyFileSync(P('old.db'), P('old-work.db'));
child(P('old-work.db'), ['links', P('links-old.json')]);
child(P('old-work.db'), ['boost', P('probes-selfretrieval.json'), P('boost-old.json')]);

// cold replay (spec §8.3: 대표 content-change replay 로 cold/steady reuse 실측)
fs.copyFileSync(P('old.db'), P('cold.db'));
child(P('cold.db'), ['coldreplay', 'wiki-gotchas', P('cold-report.json')]);

const report = { arms: {}, divergence: {}, coldTransition: JSON.parse(fs.readFileSync(P('cold-report.json'), 'utf-8')), verdicts: [] };
for (const [name, buildArg] of [['mixed', P('cohort.json')], ['full', 'ALL']]) {
  const db = P(`${name}.db`);
  fs.copyFileSync(P('old.db'), db);
  child(db, ['build', buildArg]);
  // r7-3: synthetic 은 arm 사본에서만 — 품질 지표 측정 DB 를 오염시키지 않는다
  fs.copyFileSync(db, P(`synthetic-${name}.db`));
  child(P(`synthetic-${name}.db`), ['synthetic', P(`synthetic-${name}.json`)]);
  child(db, ['invariants', P(`inv-${name}.json`)]);
  child(db, ['probe', P('probes-selfretrieval.json'), P('probes-knownitem.json'), P(`probe-${name}.json`)]);
  child(db, ['links', P(`links-${name}.json`)]);
  child(db, ['boost', P('probes-selfretrieval.json'), P(`boost-${name}.json`)]);

  const probeOut = JSON.parse(fs.readFileSync(P(`probe-${name}.json`), 'utf-8'));
  const res = probeOut.results;                                            // r7-4: meta + results
  let b = 0, c = 0, armHits = 0, baseHits = 0, selfN = 0;
  const knownRegressions = [];
  const jac = [];
  for (const r of res) {
    const base = baseMap.get(r.probeId); if (!base) continue;
    jac.push({ probeId: r.probeId, j: jaccard(base.topDocIds, r.topDocIds), base: base.topDocIds, arm: r.topDocIds });
    if (r.kind === 'self') { selfN++; if (base.hit) baseHits++; if (r.hit) armHits++;
      if (base.hit && !r.hit) b++; if (!base.hit && r.hit) c++; }
    else if (base.hit && !r.hit) knownRegressions.push(r.probeId);
  }
  jac.sort((x, y) => x.j - y.j);
  report.divergence[name] = jac.slice(0, Math.ceil(jac.length / 10));      // 하위 10% (advisor 위임)
  const dropPp = (baseHits - armHits) / Math.max(1, selfN) * 100;          // r5-12: 순하락
  const n = b + c; let p = 1;
  if (n > 0) { const k = Math.min(b, c); let acc = 0;
    for (let i = 0; i <= k; i++) { let comb = 1; for (let j = 0; j < i; j++) comb = comb * (n - j) / (j + 1); acc += comb * Math.pow(0.5, n); }
    p = Math.min(1, 2 * acc); }
  const linksOld = JSON.parse(fs.readFileSync(P('links-old.json'), 'utf-8'));
  const linksArm = JSON.parse(fs.readFileSync(P(`links-${name}.json`), 'utf-8'));
  const oldSet = new Set(linksOld.tuples);
  const recall = linksArm.tuples.filter(t => oldSet.has(t)).length / Math.max(1, oldSet.size);
  const inv = JSON.parse(fs.readFileSync(P(`inv-${name}.json`), 'utf-8'));
  const boostOld = JSON.parse(fs.readFileSync(P('boost-old.json'), 'utf-8'));
  const boostArm = JSON.parse(fs.readFileSync(P(`boost-${name}.json`), 'utf-8'));
  const synth = JSON.parse(fs.readFileSync(P(`synthetic-${name}.json`), 'utf-8'));

  report.arms[name] = { b, c, p, dropPp,
    armHitRate: armHits / Math.max(1, selfN), baseHitRate: baseHits / Math.max(1, selfN),
    knownRegressions, linkRecall: recall,
    pairChunkP50: linksArm.pairChunkP50, pairChunkP95: linksArm.pairChunkP95,
    perChunkEntityP50: linksArm.perChunkEntityP50, perChunkEntityP95: linksArm.perChunkEntityP95,
    structure: inv.structure,
    boost: { old: boostOld.boostChangedTop5, arm: boostArm.boostChangedTop5 },
    probeMeta: probeOut.meta, invariantErrors: inv.errors, synthetic: synth };
  report.verdicts.push({ arm: name,
    eligibility: (probeOut.meta.model_state === 'ready' && ['complete', 'n/a'].includes(probeOut.meta.reconciliation_state))
      ? 'PASS' : `FAIL(model ${probeOut.meta.model_state} / recon ${probeOut.meta.reconciliation_state})`,   // r8-3
    selfRetrieval: (armHits < baseHits && (p < 0.05 || dropPp > 3)) ? 'FAIL' : 'PASS',
    knownItem: knownRegressions.length === 0 ? 'PASS' : `FAIL(${knownRegressions.length})`,
    linkRecall: recall >= 1.0 ? 'PASS' : `FAIL(${(recall * 100).toFixed(1)}%)`,
    linkMultiplicity: `INFO(pair p50 ${linksArm.pairChunkP50} p95 ${linksArm.pairChunkP95} · chunk p50 ${linksArm.perChunkEntityP50} p95 ${linksArm.perChunkEntityP95})`,
    boostControl: (boostOld.boostChangedTop5 > 0 && boostArm.boostChangedTop5 > 0) ? 'PASS'
      : `FAIL(old ${boostOld.boostChangedTop5} / arm ${boostArm.boostChangedTop5})`,                          // r7-4
    synthetic: (synth.boundaryCrossesName && !synth.nameWhollyInOneChunk && synth.syntheticEntityLinked) ? 'PASS' : 'FAIL',
    coverage: probeOut.meta.coverageMissing === 0 ? 'PASS' : `FAIL(missing ${probeOut.meta.coverageMissing})`,
    invariants: inv.errors.length === 0 ? 'PASS' : `FAIL(${inv.errors.length})`,
    divergence: 'DEFER(advisor)' });
}
fs.writeFileSync(P('three-arm-report.json'), JSON.stringify(report, null, 1));
console.log(JSON.stringify(report.verdicts, null, 1));
process.exit(report.verdicts.some(v => Object.values(v).some(x => String(x).startsWith('FAIL'))) ? 1 : 0);
