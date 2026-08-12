// build-docs.mjs — turn docs/*.md into the searchable corpus, then push it to ZERO's KV.
//
//   node scripts/build-docs.mjs            build + report + self-test the search, push nothing
//   node scripts/build-docs.mjs --push     build, then write it to the live Worker KV
//
// The corpus is ONE KV value, not one key per chunk: a search must never cost a read per passage.
// At five documents this lands around a couple hundred KB against a 25 MiB per-value ceiling.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildCorpus, buildLlmsTxt, searchCorpus, CORPUS_KEY } from '../docs.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DOCS = path.join(ROOT, 'docs');

if (!fs.existsSync(DOCS)) { console.error('no docs/ directory — nothing to build'); process.exit(1); }

const files = fs.readdirSync(DOCS).filter(f => f.endsWith('.md')).sort();
if (!files.length) { console.error('docs/ is empty — nothing to build'); process.exit(1); }

const docs = files.map(f => {
  const md = fs.readFileSync(path.join(DOCS, f), 'utf8');
  const slug = f.replace(/\.md$/, '');
  // Title = first H1. One-liner and sources are lifted from the header block the harvest agents
  // were told to write, so the index is generated from the documents rather than hand-maintained.
  const title = (/^#\s+(.+)$/m.exec(md)?.[1] || slug).trim();
  const sources = [...md.matchAll(/https?:\/\/[^\s)>\]]+/g)].map(m => m[0]);
  // The one-liner is what an agent reads FIRST, so it has to say what is inside — not repeat the
  // header boilerplate every doc shares. Strip the fetched-date and the hypothesis warning; if
  // nothing distinctive survives, describe the doc by its own top-level sections, which is far more
  // useful than a generic label anyway.
  let one = (/^>\s*Corpus entry for ZERO\.\s*(.*)$/m.exec(md)?.[1] || '')
    .replace(/Fetched[^.]*\.\s*/i, '')
    .replace(/DOCUMENTATION IS A HYPOTHESIS[^.]*\.\s*/i, '')
    .trim();
  if (one.length < 25) {
    const heads = [...md.matchAll(/^##\s+(.+)$/gm)]
      .map(m => m[1].replace(/^[\d.\s]*/, '').replace(/[`*🚨⚠️✅]/g, '').trim())
      .filter(h => h.length > 3 && !/summary|version|60-second|five-second/i.test(h))
      .slice(0, 4);
    one = heads.length ? heads.join(' · ') : `${title} operational reference`;
  }
  return { slug, title, markdown: md, one_line: one.slice(0, 180), sources: [...new Set(sources)].slice(0, 12) };
});

const corpus = buildCorpus(docs);
const json = JSON.stringify(corpus);

console.log('=== CORPUS ===');
for (const d of corpus.docs) console.log(`  ${d.slug.padEnd(14)} ${String(d.bytes).padStart(7)} bytes  ${String(d.chunks).padStart(4)} passages  ${d.sources.length} sources`);
console.log(`  TOTAL: ${corpus.chunks.length} passages, ${(json.length / 1024).toFixed(1)} KB (KV value limit 25 MiB)`);

// ── SELF-TEST. A search index that returns nothing useful is worse than none, because the agent
// will trust it and stop looking. These probes are questions ZERO has ACTUALLY got wrong and paid
// for; if the corpus cannot answer them it is not doing its job and must not be shipped.
const PROBES = [
  ['can a Safe unwrap WETH', /2300|stipend|transfer|revert/i],
  ['CCTP domain for polygon', /domain|localdomain|\b7\b/i],
  ['exactInputSingle tuple deadline', /exactinputsingle|tuple|deadline/i],
  ['usedNonces already delivered', /nonce|usednonces|replay/i],
  ['eth_call state override', /override|state|eth_call/i],
  ['EIP-1967 implementation slot', /1967|implementation|slot|0x360894/i],
  ['MultiSend byte packing', /multisend|packing|operation|delegatecall/i],
  ['0x9641d764fc13c8B624c04430C7356C1C7C8102e2', /multisend/i],
];
console.log('\n=== SEARCH SELF-TEST (questions ZERO has really got wrong) ===');
let pass = 0;
for (const [q, want] of PROBES) {
  const r = searchCorpus(corpus, q, 3);
  const top = r.results?.[0];
  const ok = top && want.test(top.heading + ' ' + top.text);
  if (ok) pass++;
  console.log(`  ${ok ? 'HIT ' : 'MISS'} "${q}"${top ? `  -> ${top.doc}#${top.heading.slice(0, 46)}` : '  -> nothing'}`);
}
console.log(`  ${pass}/${PROBES.length} probes answered`);

fs.writeFileSync(path.join(ROOT, 'docs', 'llms.txt'), buildLlmsTxt(corpus));
fs.writeFileSync(path.join(ROOT, 'state', 'docs-corpus.json'), json);
console.log('\nwrote docs/llms.txt and state/docs-corpus.json');

if (process.argv.includes('--push')) {
  if (pass < Math.ceil(PROBES.length * 0.6)) {
    console.error(`\nREFUSING TO PUSH: only ${pass}/${PROBES.length} probes answered. A corpus the agent will trust and that cannot answer its own known failures is worse than no corpus. Fix the docs first.`);
    process.exit(1);
  }
  const tmp = path.join(ROOT, 'state', 'docs-corpus.json');
  execFileSync('npx', ['wrangler', 'kv', 'key', 'put', CORPUS_KEY, '--path', tmp, '--binding', 'KV', '--remote'],
    { cwd: ROOT, stdio: 'inherit', shell: true });
  console.log(`pushed ${CORPUS_KEY} (${(json.length / 1024).toFixed(1)} KB)`);
}
