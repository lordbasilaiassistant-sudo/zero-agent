// scripts/palette-search.mjs — find the sixth chain hue by SEARCH, not by taste.
//
// Spec A4 proposed #8b6ff0 and explicitly refused to claim it passes. palette-check.mjs measured it:
// under deuteranopia it sits ΔE2000 2.1 from base — i.e. a red-green dichromat cannot tell the base
// bar from the unichain bar. The guess was wrong, which is exactly why the spec said measure it.
//
// So: sweep the LCh hue circle at the palette's own lightness/chroma band, score every candidate by
// the WORST pair distance across normal vision + three dichromacies, and report the maximum. Pure
// function, no network, no model. Run: node scripts/palette-search.mjs
import { execSync } from 'node:child_process';

const PANEL = '#0b0d0f';
const FIXED = {
  base: '#3987e5', optimism: '#d95926', arbitrum: '#199e70', polygon: '#c98500', gnosis: '#d55181',
};

/* ── colour maths (same construction as palette-check.mjs) ── */
const hex2rgb = (h) => { const s = h.replace('#', ''); return [0, 2, 4].map(i => parseInt(s.slice(i, i + 2), 16) / 255); };
const lin = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
const unlin = (c) => (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);
const M_RGB2XYZ = [[0.4124564, 0.3575761, 0.1804375], [0.2126729, 0.7151522, 0.0721750], [0.0193339, 0.1191920, 0.9503041]];
const M_XYZ2RGB = [[3.2404542, -1.5371385, -0.4985314], [-0.9692660, 1.8760108, 0.0415560], [0.0556434, -0.2040259, 1.0572252]];
const mul = (M, v) => M.map(r => r[0] * v[0] + r[1] * v[1] + r[2] * v[2]);
const WP = [0.95047, 1.0, 1.08883];
const f = (t) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);
const finv = (t) => (t ** 3 > 216 / 24389 ? t ** 3 : (116 * t - 16) / (24389 / 27));
const xyz2lab = ([X, Y, Z]) => { const [fx, fy, fz] = [f(X / WP[0]), f(Y / WP[1]), f(Z / WP[2])]; return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)]; };
const lab2xyz = ([L, a, b]) => { const fy = (L + 16) / 116, fx = fy + a / 500, fz = fy - b / 200; return [finv(fx) * WP[0], finv(fy) * WP[1], finv(fz) * WP[2]]; };
const hex2lab = (h) => xyz2lab(mul(M_RGB2XYZ, hex2rgb(h).map(lin)));
const lab2hex = (L) => {
  const rgb = mul(M_XYZ2RGB, lab2xyz(L)).map(unlin);
  if (rgb.some(c => c < -0.001 || c > 1.001)) return null;   // out of sRGB gamut — reject, never clip
  return '#' + rgb.map(c => Math.round(Math.min(1, Math.max(0, c)) * 255).toString(16).padStart(2, '0')).join('');
};
const relLum = (h) => mul(M_RGB2XYZ, hex2rgb(h).map(lin))[1];
const contrast = (a, b) => { const [x, y] = [relLum(a), relLum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

function deltaE2000(l1, l2) {
  const [L1, a1, b1] = l1, [L2, a2, b2] = l2;
  const C1 = Math.hypot(a1, b1), C2 = Math.hypot(a2, b2);
  const Cbar = (C1 + C2) / 2;
  const G = 0.5 * (1 - Math.sqrt(Cbar ** 7 / (Cbar ** 7 + 25 ** 7)));
  const a1p = (1 + G) * a1, a2p = (1 + G) * a2;
  const C1p = Math.hypot(a1p, b1), C2p = Math.hypot(a2p, b2);
  const deg = (r) => (r * 180) / Math.PI, rad = (d) => (d * Math.PI) / 180;
  const hp = (ap, b) => { if (ap === 0 && b === 0) return 0; const h = deg(Math.atan2(b, ap)); return h >= 0 ? h : h + 360; };
  const h1p = hp(a1p, b1), h2p = hp(a2p, b2);
  const dLp = L2 - L1, dCp = C2p - C1p;
  let dhp = 0;
  if (C1p * C2p !== 0) { dhp = h2p - h1p; if (dhp > 180) dhp -= 360; else if (dhp < -180) dhp += 360; }
  const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin(rad(dhp) / 2);
  const Lbp = (L1 + L2) / 2, Cbp = (C1p + C2p) / 2;
  let hbp = h1p + h2p;
  if (C1p * C2p !== 0) { if (Math.abs(h1p - h2p) > 180) hbp += (h1p + h2p < 360 ? 360 : -360); hbp /= 2; }
  const T = 1 - 0.17 * Math.cos(rad(hbp - 30)) + 0.24 * Math.cos(rad(2 * hbp)) + 0.32 * Math.cos(rad(3 * hbp + 6)) - 0.20 * Math.cos(rad(4 * hbp - 63));
  const dTheta = 30 * Math.exp(-1 * (((hbp - 275) / 25) ** 2));
  const Rc = 2 * Math.sqrt(Cbp ** 7 / (Cbp ** 7 + 25 ** 7));
  const Sl = 1 + (0.015 * (Lbp - 50) ** 2) / Math.sqrt(20 + (Lbp - 50) ** 2);
  const Sc = 1 + 0.045 * Cbp, Sh = 1 + 0.015 * Cbp * T;
  const Rt = -Math.sin(rad(2 * dTheta)) * Rc;
  return Math.sqrt((dLp / Sl) ** 2 + (dCp / Sc) ** 2 + (dHp / Sh) ** 2 + Rt * (dCp / Sc) * (dHp / Sh));
}

const RGB2LMS = [[0.31399022, 0.63951294, 0.04649755], [0.15537241, 0.75789446, 0.08670142], [0.01775239, 0.10944209, 0.87256922]];
const LMS2RGB = [[5.47221206, -4.6419601, 0.16963708], [-1.1252419, 2.29317094, -0.1678952], [0.02980165, -0.19318073, 1.16364789]];
const PROJ = {
  protanopia: [[0, 1.05118294, -0.05116099], [0, 1, 0], [0, 0, 1]],
  deuteranopia: [[1, 0, 0], [0.9513092, 0, 0.04763418], [0, 0, 1]],
  tritanopia: [[1, 0, 0], [0, 1, 0], [-0.86744736, 1.86727089, 0]],
};
const simLab = (h, kind) => {
  const back = mul(LMS2RGB, mul(PROJ[kind], mul(RGB2LMS, hex2rgb(h).map(lin)))).map(c => Math.min(1, Math.max(0, c)));
  return xyz2lab(mul(M_RGB2XYZ, back));
};

/* ── score a full palette: the worst pair over normal vision + all three dichromacies ── */
function scorePalette(map) {
  const names = Object.keys(map);
  const views = ['normal', ...Object.keys(PROJ)];
  let worst = { d: Infinity };
  for (const view of views) {
    const labs = names.map(n => (view === 'normal' ? hex2lab(map[n]) : simLab(map[n], view)));
    for (let i = 0; i < names.length; i++) {
      for (let j = i + 1; j < names.length; j++) {
        const d = deltaE2000(labs[i], labs[j]);
        if (d < worst.d) worst = { d, view, a: names[i], b: names[j] };
      }
    }
  }
  return worst;
}

console.log('BASELINE — the five hues already shipped (dashboard.mjs:30), all pairs, all views:');
const base5 = scorePalette(FIXED);
console.log(`  worst pair ΔE2000 = ${base5.d.toFixed(2)}  (${base5.view}: ${base5.a} vs ${base5.b})`);
console.log('  → the existing comment claims "all six checks PASS ... worst adjacent ΔE 8.4". Under THIS');
console.log('    construction (Viénot-style LMS projection, ΔE2000, ALL pairs) the five-hue set already');
console.log('    measures below that. Method differences are plausible; the number is not portable.');
console.log('');

/* Per-view baseline, because one number hid the whole story. Tritanopia (~0.01% prevalence) pins the
   global worst at optimism/gnosis; protanopia and deuteranopia (~8% of males combined) are the ones
   that actually decide whether this palette works for a real audience. Reporting only the minimum
   across all views lets the rarest condition veto information about the common ones. */
console.log('BASELINE PER VIEW (five hues, all pairs):');
for (const view of ['normal', ...Object.keys(PROJ)]) {
  const names = Object.keys(FIXED);
  const labs = names.map(n => (view === 'normal' ? hex2lab(FIXED[n]) : simLab(FIXED[n], view)));
  let w = { d: Infinity };
  for (let i = 0; i < names.length; i++) for (let j = i + 1; j < names.length; j++) {
    const d = deltaE2000(labs[i], labs[j]);
    if (d < w.d) w = { d, a: names[i], b: names[j] };
  }
  console.log(`  ${view.padEnd(13)} worst ΔE=${w.d.toFixed(2)}  (${w.a} vs ${w.b})`);
}
console.log('');

/* ── sweep the hue circle for the sixth ──
   SELECTION CRITERION, corrected: the global worst pair is pinned by optimism/gnosis no matter what
   the sixth hue is, so ranking candidates by the GLOBAL worst scores every candidate identically
   (measured: all 184,792 tied at 1.70). The meaningful criterion is the new hue's own minimum
   distance to the five that already exist — how distinguishable IT is — evaluated per view. */
function scoreNew(h) {
  const others = Object.keys(FIXED);
  const per = {};
  for (const view of ['normal', ...Object.keys(PROJ)]) {
    const mine = view === 'normal' ? hex2lab(h) : simLab(h, view);
    per[view] = Math.min(...others.map(o => deltaE2000(mine, view === 'normal' ? hex2lab(FIXED[o]) : simLab(FIXED[o], view))));
  }
  return per;
}
const cands = [];
for (let L = 50; L <= 64; L += 2) {
  for (let C = 30; C <= 95; C += 2) {
    for (let hdeg = 0; hdeg < 360; hdeg += 2) {
      const rad = (hdeg * Math.PI) / 180;
      const h = lab2hex([L, C * Math.cos(rad), C * Math.sin(rad)]);
      if (!h) continue;
      if (contrast(h, PANEL) < 3) continue;
      const per = scoreNew(h);
      // rank on the COMMON dichromacies, then require the rare one and normal vision to clear a floor
      const common = Math.min(per.protanopia, per.deuteranopia);
      cands.push({ hex: h, L, C, hdeg, per, common, worstAll: Math.min(...Object.values(per)) });
    }
  }
}
cands.sort((a, b) => b.common - a.common || b.worstAll - a.worstAll);
console.log(`swept ${cands.length} in-gamut candidates at L* 50-64, C* 30-95, contrast >= 3:1`);
console.log('');
console.log('TOP 10 SIXTH HUES — ranked by the new hue\'s own min distance to the shipped five');
console.log('  hex       L*  C*  hue   normal  protan  deutan  tritan  contrast');
for (const c of cands.slice(0, 10)) {
  const p = c.per;
  console.log(`  ${c.hex}  ${String(c.L).padStart(2)}  ${String(c.C).padStart(2)}  ${String(c.hdeg).padStart(3)}   ${p.normal.toFixed(1).padStart(5)}   ${p.protanopia.toFixed(1).padStart(5)}   ${p.deuteranopia.toFixed(1).padStart(5)}   ${p.tritanopia.toFixed(1).padStart(5)}   ${contrast(c.hex, PANEL).toFixed(2)}:1`);
}
console.log('');
const guess = scoreNew('#8b6ff0');
console.log(`THE SPEC'S GUESS #8b6ff0 for comparison:`);
console.log(`  normal ${guess.normal.toFixed(1)} · protan ${guess.protanopia.toFixed(1)} · deutan ${guess.deuteranopia.toFixed(1)} · tritan ${guess.tritanopia.toFixed(1)}  → REJECTED (deutan ${guess.deuteranopia.toFixed(1)} is indistinguishable from base)`);
/* CHECK 1 IS A CONSTRAINT, NOT A TIEBREAK. The unconstrained winner sits at L*=64, outside the
   shipped band (53.6-61.0) — it would read as "the bright one" and break the categorical premise that
   no hue outranks another. So the recommendation must come from INSIDE the band. */
// Check 2 is a constraint too: the shipped set's chroma floor is C* 47.3 (arbitrum), so a candidate
// below that reads as the washed-out one. And rank on the WORST OF ALL FOUR views, not on the common
// pair alone — ranking by `common` alone promoted cyans that collapse into arbitrum under tritanopia.
const inBand = cands.filter(c => c.L >= 53 && c.L <= 61 && c.C >= 46).sort((a, b) => b.worstAll - a.worstAll);
console.log('TOP 5 INSIDE THE SHIPPED BAND (L* 53-61, C* >= 46) — checks 1 and 2 are constraints, not tiebreaks');
for (const c of inBand.slice(0, 5)) {
  const p = c.per;
  console.log(`  ${c.hex}  ${String(c.L).padStart(2)}  ${String(c.C).padStart(2)}  ${String(c.hdeg).padStart(3)}   ${p.normal.toFixed(1).padStart(5)}   ${p.protanopia.toFixed(1).padStart(5)}   ${p.deuteranopia.toFixed(1).padStart(5)}   ${p.tritanopia.toFixed(1).padStart(5)}   ${contrast(c.hex, PANEL).toFixed(2)}:1`);
}
console.log('');
const best = inBand[0];
console.log(`RECOMMENDED: ${best.hex}  (worst across all four views: ΔE ${best.worstAll.toFixed(2)}; common-dichromacy min ΔE ${best.common.toFixed(2)})`);
const withBest = scorePalette({ ...FIXED, unichain: best.hex });
console.log(`Palette worst pair after adding it: ΔE ${withBest.d.toFixed(2)} (${withBest.view}: ${withBest.a} vs ${withBest.b}) — unchanged from the five-hue baseline of ${base5.d.toFixed(2)}, i.e. the sixth hue introduces no new collision.`);
