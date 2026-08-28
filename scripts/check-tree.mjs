#!/usr/bin/env node
// Fail if the Worker cannot deploy from this tree, or if a live-spend script is unguarded.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let failed = 0;
const fail = (m) => { console.error('FAIL  ' + m); failed++; };
const ok = (m) => { console.log('PASS  ' + m); };

const worker = fs.readFileSync(path.join(ROOT, 'worker.mjs'), 'utf8');
const imports = [...worker.matchAll(/^import .+ from '\.\/([^']+)'/gm)].map(m => m[1]);
if (!imports.includes('janitor.mjs')) fail('worker.mjs must import janitor.mjs');
for (const rel of imports) {
  const p = path.join(ROOT, rel);
  if (!fs.existsSync(p)) fail(`Worker import missing on disk: ${rel}`);
  else ok(`import ${rel}`);
}

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
for (const [name, cmd] of Object.entries(pkg.scripts || {})) {
  const m = String(cmd).match(/\bnode\s+(\S+\.mjs)/);
  if (!m) continue;
  const p = path.join(ROOT, m[1]);
  if (!fs.existsSync(p)) fail(`npm run ${name} points at missing ${m[1]}`);
  else ok(`script ${name} -> ${m[1]}`);
}

const probe = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'probe-relay.mjs')], { encoding: 'utf8' });
if (probe.status === 2 && /REFUSED/i.test(probe.stderr + probe.stdout)) ok('probe-relay refuses without --spend');
else fail(`probe-relay without --spend exited ${probe.status}: ${(probe.stderr || probe.stdout || '').slice(0, 180)}`);

const fleet = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'deploy-fleet.mjs')], { encoding: 'utf8' });
if (fleet.status === 2 && /REFUSED/i.test(fleet.stderr + fleet.stdout)) ok('deploy-fleet refuses without --spend');
else fail(`deploy-fleet without --spend exited ${fleet.status}: ${(fleet.stderr || fleet.stdout || '').slice(0, 180)}`);

for (const spend of ['scripts/deploy-launchpad.mjs', 'scripts/zero-coin-deploy.mjs', 'scripts/harvest-eoa.mjs']) {
  const r = spawnSync(process.execPath, [path.join(ROOT, spend)], { encoding: 'utf8' });
  if (r.status === 2 && /REFUSED/i.test(r.stderr + r.stdout)) ok(`${spend} refuses without --spend`);
  else fail(`${spend} without --spend exited ${r.status}: ${(r.stderr || r.stdout || '').slice(0, 180)}`);
}

const renderSrc = fs.readFileSync(path.join(ROOT, 'scripts', 'render-check.mjs'), 'utf8');
if (/from '\.\.\/dashboard2\.mjs'/.test(renderSrc)) ok('render-check imports dashboard2 (the served page)');
else fail('render-check.mjs must import dashboard2.mjs — dashboard.mjs is not served');

const harvestScanW = (worker.match(/name: 'harvest_scan', description: '([^']+)'/) || [])[1] || '';
const toolsSrc = fs.readFileSync(path.join(ROOT, 'tools.mjs'), 'utf8');
const harvestScanT = (toolsSrc.match(/name: 'harvest_scan', description: '([^']+)'/) || [])[1] || '';
if (harvestScanW && harvestScanW === harvestScanT) ok('harvest_scan schema matches Worker and local harness');
else fail('harvest_scan descriptions drifted between worker.mjs and tools.mjs');

const RETIRED_EOA = '0x50624F7790732f9767180871D03A304756200dB9';
const RETIRED_SAFE = '0x510601f59FDa068D70ad6760c9d9085B0F42cbb1';
const liveAssign = new RegExp(
  String.raw`(?:const|let|var|export const)\s+(?:EOA|ZERO_EOA|ZERO_WALLET|ZERO_SAFE|SAFE|OWNER)\s*=\s*['"](?:${RETIRED_EOA}|${RETIRED_SAFE})['"][^\n]*`,
  'i',
);
let identityFails = 0;
for (const dir of [path.join(ROOT, 'scripts'), path.join(ROOT, 'knowledge', 'streams')]) {
  if (!fs.existsSync(dir)) continue;
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.mjs')) continue;
    const src = fs.readFileSync(path.join(dir, name), 'utf8');
    const rel = path.relative(ROOT, path.join(dir, name)).replace(/\\/g, '/');
    const m = src.match(liveAssign);
    if (!m) continue;
    if (/retired|GENESIS I|replay only/i.test(m[0])) continue;
    identityFails++;
    fail(`${rel} assigns a retired address as the live caller/payTo: ${m[0].slice(0, 120)}`);
  }
}
if (!identityFails) ok('hunt scripts do not pin GENESIS I as the live caller');

let adminFails = 0;
for (const name of fs.readdirSync(path.join(ROOT, 'scripts'))) {
  if (!name.endsWith('.mjs')) continue;
  const src = fs.readFileSync(path.join(ROOT, 'scripts', name), 'utf8');
  if (/match\(\s*\/\^WORKER_ADMIN_KEY/.test(src) || /process\.env\.WORKER_ADMIN_KEY/.test(src)) {
    adminFails++;
    fail(`scripts/${name} still falls back to WORKER_ADMIN_KEY — the Worker secret is ADMIN_KEY`);
  }
}
if (!adminFails) ok('scripts read ADMIN_KEY, not WORKER_ADMIN_KEY');

const deploySafe = fs.readFileSync(path.join(ROOT, 'deploy-safe.mjs'), 'utf8');
if (/--spend/.test(deploySafe) && /process\.argv\.includes\('--apply'\)/.test(deploySafe)) {
  ok('deploy-safe requires --spend or --apply before the relay POST');
} else fail('deploy-safe.mjs must gate the relay POST on --spend or --apply');

const janitorOnce = fs.readFileSync(path.join(ROOT, 'scripts', 'run-janitor-once.mjs'), 'utf8');
if (/from '\.\.\/shop\.mjs'/.test(janitorOnce) && /SMART_ACCOUNT/.test(janitorOnce)) {
  ok('run-janitor-once scans the live Safe from shop.mjs');
} else fail('scripts/run-janitor-once.mjs must import SMART_ACCOUNT — do not hardcode the Safe');

const dashSrc = fs.readFileSync(path.join(ROOT, 'dashboard.mjs'), 'utf8').split('\n')[0] || '';
if (/REFERENCE ONLY/i.test(dashSrc)) ok('dashboard.mjs header says reference-only (Worker serves dashboard2)');
else fail('dashboard.mjs must not claim it is the served public page');

const originJanitor = spawnSync('git', ['cat-file', '-e', 'origin/main:janitor.mjs'], { cwd: ROOT, encoding: 'utf8' });
if (originJanitor.status === 0) ok('origin/main has janitor.mjs');
else console.warn('WARN  origin/main lacks janitor.mjs — a clean clone cannot deploy until this is committed and pushed');

const janitorTracked = spawnSync('git', ['ls-files', '--', 'janitor.mjs'], { cwd: ROOT, encoding: 'utf8' }).stdout.trim();
if (!janitorTracked) fail('janitor.mjs is untracked — Worker import; clean clone cannot deploy');
else ok('janitor.mjs is tracked');

const renderTracked = spawnSync('git', ['ls-files', '--', '.render'], { cwd: ROOT, encoding: 'utf8' }).stdout.trim();
if (renderTracked) fail('.render/ is tracked — probe HTML dumps; gitignore it');
else ok('.render/ is not tracked');

const dumpTracked = spawnSync('git', ['ls-files', '--', 'fixtures', 'scripts/factory-born-base.json', 'scripts/launchpad-livetest.json'], { cwd: ROOT, encoding: 'utf8' }).stdout.trim();
if (dumpTracked) fail('probe dumps still tracked: ' + dumpTracked.split(/\s+/).slice(0, 4).join(' '));
else ok('probe dumps (fixtures/, factory-born, launchpad-livetest) are not tracked');

if (failed) { console.error(`\n${failed} tree check(s) failed`); process.exit(1); }
console.log('\ntree ok');
