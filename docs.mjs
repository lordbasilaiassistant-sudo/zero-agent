// docs.mjs — THE CORPUS. A searchable reference library for the ZERO agent team.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────────
// WHY A CORPUS AND NOT MORE PROMPT.
// ZERO's system prompt is ~30,700 tokens of mostly-static knowledge injected on EVERY call: genesis
// 13.3k, frontier 8.4k, phases 4.7k. That is the reason it cannot run on a cheaper or faster brain,
// the reason a multi-agent team is unaffordable (four agents at 30k each is absurd), and plausibly a
// reason it kept re-deriving its own status — recall degrades in a haystack.
//
// The fix is not a bigger prompt. It is RETRIEVAL: keep a small always-on core, and let the agent ASK
// for the rest. This file is the "rest" — every system ZERO actually touches, distilled to operational
// reference, chunked, and searchable in ONE KV read.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────────
// WHY THE SEARCH IS A SCRIPT AND NOT A MODEL.
// DOCTRINE §5: give the tireless exhaustive work to CODE, leave the model the breadth. Scoring text
// overlap is a pure function of (query, corpus) — so it is a script: $0, instant, deterministic,
// testable, and incapable of hallucinating a passage that is not there. No embedding API, no key,
// nothing to rate-limit, nothing to go down. An embedding model would be a dependency and a bill in
// exchange for better recall on a corpus small enough not to need it.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────────
// ⚠️ THE HEALTH WARNING THAT TRAVELS WITH EVERY RESULT.
// DOCUMENTATION IS A HYPOTHESIS. THE CHAIN IS THE MEASUREMENT.
// This is not a slogan, it is this project's scar tissue. Measured on 2026-08-12: this repo's own
// CLAUDE.md documented the admin secret under the wrong name, so every caller that trusted the doc
// got a silent 401 with no way to tell a wrong name from a wrong key. Earlier: a "reward" getter that
// the docs described as a payout was a CAP, and paid 8,527,792x less than it advertised.
// So `doc_search` NEVER returns a passage bare. Every result carries the reminder that a doc is a
// lead to verify with a free eth_call, never a fact to spend a scarce relay slot on.

export const CORPUS_KEY = 'docs:corpus';

// Cheap stopwords. Anything that appears in most technical prose carries no selectivity.
const STOP = new Set(('a an and are as at be but by for from has have how in into is it its of on or '
  + 'that the this to was were what when where which who will with you your can does do not if then '
  + 'there their they these those we us our i').split(' '));

const tokenize = (s) => (s || '').toLowerCase().match(/[a-z0-9_]{2,}|0x[a-f0-9]{4,}/g) || [];

// ── BUILD ────────────────────────────────────────────────────────────────────────────────────────
// Split each markdown doc on its headings. A heading is a natural semantic boundary AND a strong
// retrieval signal — matching a heading is worth far more than matching body prose, because whoever
// wrote the heading was naming the thing the reader is looking for.
export function chunkMarkdown(slug, title, md, maxChars = 1400) {
  const chunks = [];
  const lines = (md || '').split(/\r?\n/);
  let heading = title || slug;
  let hashes = '';                 // the ORIGINAL heading level, so reconstruction is lossless
  let buf = [];
  const flush = () => {
    const text = buf.join('\n').trim();
    if (!text) { buf = []; return; }
    // A single long section becomes several chunks that all keep the heading, so the heading signal
    // is not lost on the tail of a long passage.
    for (let i = 0; i < text.length; i += maxChars) {
      chunks.push({
        id: `${slug}#${chunks.length}`, slug, heading,
        // ⚠️ THE HEADING MUST LIVE IN THE TEXT TOO, not only in metadata. It used to be consumed by
        // the parser and stored only as a field — which was fine for scoring and silently destroyed
        // the document: `/docs/<slug>` rebuilds a doc by joining chunk TEXT, so a 34-section
        // reference was being served as ONE structureless wall with every heading gone. Measured
        // 2026-08-12: 34 headings in docs/safe.md, 1 in what the endpoint returned.
        // `headingMark` is emitted only on the FIRST chunk of a section so a long section does not
        // repeat its own title mid-flow.
        headingMark: i === 0 && hashes ? `${hashes} ${heading}` : '',
        text: text.slice(i, i + maxChars),
      });
    }
    buf = [];
  };
  for (const ln of lines) {
    const m = /^(#{1,4})\s+(.*)$/.exec(ln);
    if (m) { flush(); hashes = m[1]; heading = m[2].trim(); continue; }
    buf.push(ln);
  }
  flush();
  return chunks;
}

// Rebuild a document from its chunks WITHOUT losing structure. Anything serving a whole doc must go
// through this rather than joining `.text`, which is what dropped every heading.
export function reassembleDoc(corpus, slug) {
  return corpus.chunks
    .filter(c => c.slug === slug)
    .map(c => (c.headingMark ? `${c.headingMark}\n\n${c.text}` : c.text))
    .join('\n\n');
}

export function buildCorpus(docs) {
  const chunks = [];
  const index = [];
  for (const d of docs) {
    const c = chunkMarkdown(d.slug, d.title, d.markdown);
    chunks.push(...c);
    index.push({ slug: d.slug, title: d.title, one_line: d.one_line || '', sources: d.sources || [], chunks: c.length, bytes: (d.markdown || '').length });
  }
  return {
    built_at: new Date().toISOString(),
    warning: 'DOCUMENTATION IS A HYPOTHESIS. THE CHAIN IS THE MEASUREMENT. Every entry here is a lead to verify with a free eth_call, never a fact to spend a scarce relay slot on.',
    docs: index,
    chunks,
  };
}

// The llms.txt index — the human/agent-readable table of contents, generated, never hand-kept.
export function buildLlmsTxt(corpus, base = 'https://zero-agent.broke2built.workers.dev') {
  const L = [];
  L.push('# ZERO — agent documentation corpus');
  L.push('');
  L.push('> Operational reference for the systems this autonomous agent actually touches, distilled');
  L.push('> from vendor docs and, where cheap, verified on-chain. Built ' + corpus.built_at + '.');
  L.push('');
  L.push('> **DOCUMENTATION IS A HYPOTHESIS. THE CHAIN IS THE MEASUREMENT.** Entries marked VERIFIED');
  L.push('> were confirmed with a free call. Everything else is documented-only and must be checked');
  L.push('> before anything scarce is spent on it. This project has been burned by its own docs.');
  L.push('');
  L.push('Search it: `POST ' + base + '/docs/search` with `{"q":"..."}`, or the `doc_search` tool.');
  L.push('');
  L.push('## Documents');
  for (const d of corpus.docs) {
    L.push(`- [${d.title}](${base}/docs/${d.slug}): ${d.one_line} (${d.chunks} passages)`);
  }
  L.push('');
  L.push('## Sources');
  for (const d of corpus.docs) {
    if (!d.sources?.length) continue;
    L.push(`### ${d.title}`);
    for (const s of d.sources) L.push(`- ${s}`);
  }
  return L.join('\n');
}

// ── SEARCH ───────────────────────────────────────────────────────────────────────────────────────
// Term-overlap scoring with three deliberate boosts, each earning its place:
//   heading match  x3  — the heading names the thing; body prose merely mentions it
//   exact phrase   x4  — "exactInputSingle" beats two chunks that happen to contain both words
//   rare term      x?  — idf, so "usednonces" outweighs "address" without a stopword list per domain
// Hex literals are kept whole by the tokenizer so an agent can search a bare contract address.
export function searchCorpus(corpus, query, k = 5) {
  if (!corpus?.chunks?.length) return { error: 'corpus is empty — it has never been built', results: [] };
  const qTerms = tokenize(query).filter(t => !STOP.has(t));
  if (!qTerms.length) return { error: 'query had no searchable terms', results: [] };
  const phrase = (query || '').toLowerCase().trim();

  const df = new Map();
  for (const c of corpus.chunks) {
    const seen = new Set(tokenize(c.heading + ' ' + c.text));
    for (const t of qTerms) if (seen.has(t)) df.set(t, (df.get(t) || 0) + 1);
  }
  const N = corpus.chunks.length;

  const scored = corpus.chunks.map(c => {
    const hTok = tokenize(c.heading), bTok = tokenize(c.text);
    const hSet = new Set(hTok), bSet = new Set(bTok);
    let score = 0, matched = 0;
    for (const t of qTerms) {
      const idf = Math.log(1 + N / (1 + (df.get(t) || 0)));
      if (hSet.has(t)) { score += 3 * idf; matched++; }
      else if (bSet.has(t)) { score += idf; matched++; }
    }
    if (phrase.length > 6 && c.text.toLowerCase().includes(phrase)) score *= 4;
    // Require more than one query term to match on multi-term queries, so a single common word
    // cannot drag an unrelated passage into the results.
    if (qTerms.length > 1 && matched < 2) score *= 0.15;
    return { ...c, score, matched };
  }).filter(c => c.score > 0).sort((a, b) => b.score - a.score).slice(0, k);

  return {
    query,
    warning: corpus.warning,
    built_at: corpus.built_at,
    results: scored.map(r => ({ doc: r.slug, heading: r.heading, score: +r.score.toFixed(3), text: r.text })),
    note: scored.length ? undefined : 'nothing matched — try fewer or more specific terms, or a bare contract address / function name',
  };
}

// Worker-side helper. Caches the corpus in isolate memory: it is immutable between builds, and a
// re-read per tool call would burn a KV read on every single search for no new information.
let _cache = null, _cacheAt = 0;
export async function loadCorpus(env, maxAgeMs = 600000) {
  if (_cache && Date.now() - _cacheAt < maxAgeMs) return _cache;
  const raw = await env.KV.get(CORPUS_KEY, 'json');
  if (raw) { _cache = raw; _cacheAt = Date.now(); }
  return raw;
}

export async function docSearch(env, query, k = 5) {
  const corpus = await loadCorpus(env);
  if (!corpus) {
    return { error: 'no docs corpus has been built yet', how: 'the operator builds it with scripts/build-docs.mjs and pushes it to KV', results: [] };
  }
  return searchCorpus(corpus, query, k);
}
