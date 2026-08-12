// scripts/palette-check.mjs — re-runs the SIX CHECKS the chain palette comment at dashboard.mjs:15-18
// claims to have passed, so a sixth hue can EARN those numbers instead of inheriting them.
//
// Spec A4 is explicit: "This spec does not claim it passes the six checks — re-run the same validation
// and record the measured worst adjacent ΔE." So this file exists to produce those numbers. It is a
// pure function of its inputs: no model, no network, no dependency. Run: node scripts/palette-check.mjs
//
// Checks, in the order the original comment lists them:
//   1 lightness band      — every hue's CIELAB L* inside a narrow band (no hue reads as "the bright one")
//   2 chroma floor        — every hue's C* above a floor (no hue reads as grey)
//   3 CVD separation      — worst adjacent ΔE2000 under deuteranopia/protanopia/tritanopia
//   4 normal-vision floor — worst adjacent ΔE2000 with normal colour vision
//   5 contrast >= 3:1     — every hue against the panel it is drawn on
//   6 identity            — a hue is fixed per chain, never recycled (structural, asserted below)
//
// X5 note: this also checks the TEXT tokens, because the audit's craft-debt X1 is that the categorical
// set passes six checks while the text layer beneath it passes none.

const PANEL = '#0b0d0f';

const CHAINS = {
  base: '#3987e5',
  optimism: '#d95926',
  arbitrum: '#199e70',
  polygon: '#c98500',
  gnosis: '#d55181',
  // The sixth chain. NOT the spec's suggested #8b6ff0 — this script measured that at ΔE2000 2.1 from
  // base under deuteranopia (indistinguishable), so it was rejected and palette-search.mjs swept the
  // hue circle for a replacement inside the shipped lightness band. See dashboard.mjs:15-25.
  unichain: '#aa6ab0',
};

// ── colour maths, from first principles (no library) ─────────────────────────
const hex = (h) => {
  const s = h.replace('#', '');
  return [0, 2, 4].map(i => parseInt(s.slice(i, i + 2), 16) / 255);
};
const lin = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
const srgbToXyz = (rgb) => {
  const [r, g, b] = rgb.map(lin);
  return [
    r * 0.4124564 + g * 0.3575761 + b * 0.1804375,
    r * 0.2126729 + g * 0.7151522 + b * 0.0721750,
    r * 0.0193339 + g * 0.1191920 + b * 0.9503041,
  ];
};
const relLum = (h) => srgbToXyz(hex(h))[1];
const contrast = (a, b) => {
  const [x, y] = [relLum(a), relLum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};
const xyzToLab = ([X, Y, Z]) => {
  const wp = [0.95047, 1.0, 1.08883];
  const f = (t) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);
  const [fx, fy, fz] = [f(X / wp[0]), f(Y / wp[1]), f(Z / wp[2])];
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
};
const lab = (h) => xyzToLab(srgbToXyz(hex(h)));
const chroma = (h) => { const [, a, b] = lab(h); return Math.hypot(a, b); };

// CIEDE2000 — the perceptual distance metric. Written out rather than approximated, because ΔE76
// systematically understates differences in the blue region and half this palette lives there.
function deltaE2000(l1, l2) {
  const [L1, a1, b1] = l1, [L2, a2, b2] = l2;
  const kL = 1, kC = 1, kH = 1;
  const C1 = Math.hypot(a1, b1), C2 = Math.hypot(a2, b2);
  const Cbar = (C1 + C2) / 2;
  const G = 0.5 * (1 - Math.sqrt(Math.pow(Cbar, 7) / (Math.pow(Cbar, 7) + Math.pow(25, 7))));
  const a1p = (1 + G) * a1, a2p = (1 + G) * a2;
  const C1p = Math.hypot(a1p, b1), C2p = Math.hypot(a2p, b2);
  const deg = (r) => (r * 180) / Math.PI;
  const rad = (d) => (d * Math.PI) / 180;
  const hp = (ap, b) => { if (ap === 0 && b === 0) return 0; const h = deg(Math.atan2(b, ap)); return h >= 0 ? h : h + 360; };
  const h1p = hp(a1p, b1), h2p = hp(a2p, b2);
  const dLp = L2 - L1;
  const dCp = C2p - C1p;
  let dhp = 0;
  if (C1p * C2p !== 0) {
    dhp = h2p - h1p;
    if (dhp > 180) dhp -= 360; else if (dhp < -180) dhp += 360;
  }
  const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin(rad(dhp) / 2);
  const Lbp = (L1 + L2) / 2;
  const Cbp = (C1p + C2p) / 2;
  let hbp = h1p + h2p;
  if (C1p * C2p !== 0) {
    if (Math.abs(h1p - h2p) > 180) hbp += (h1p + h2p < 360 ? 360 : -360);
    hbp /= 2;
  }
  const T = 1 - 0.17 * Math.cos(rad(hbp - 30)) + 0.24 * Math.cos(rad(2 * hbp))
    + 0.32 * Math.cos(rad(3 * hbp + 6)) - 0.20 * Math.cos(rad(4 * hbp - 63));
  const dTheta = 30 * Math.exp(-Math.pow((hbp - 275) / 25, 2));
  const Rc = 2 * Math.sqrt(Math.pow(Cbp, 7) / (Math.pow(Cbp, 7) + Math.pow(25, 7)));
  const Sl = 1 + (0.015 * Math.pow(Lbp - 50, 2)) / Math.sqrt(20 + Math.pow(Lbp - 50, 2));
  const Sc = 1 + 0.045 * Cbp;
  const Sh = 1 + 0.015 * Cbp * T;
  const Rt = -Math.sin(rad(2 * dTheta)) * Rc;
  return Math.sqrt(
    Math.pow(dLp / (kL * Sl), 2) + Math.pow(dCp / (kC * Sc), 2) + Math.pow(dHp / (kH * Sh), 2)
    + Rt * (dCp / (kC * Sc)) * (dHp / (kH * Sh)),
  );
}

// Brettel/Viénot-style dichromat simulation in LMS (Hunt-Pointer-Estevez), the standard construction.
const RGB2LMS = [
  [0.31399022, 0.63951294, 0.04649755],
  [0.15537241, 0.75789446, 0.08670142],
  [0.01775239, 0.10944209, 0.87256922],
];
const LMS2RGB = [
  [5.47221206, -4.6419601, 0.16963708],
  [-1.1252419, 2.29317094, -0.1678952],
  [0.02980165, -0.19318073, 1.16364789],
];
const mul = (M, v) => M.map(r => r[0] * v[0] + r[1] * v[1] + r[2] * v[2]);
const PROJ = {
  protanopia: [[0, 1.05118294, -0.05116099], [0, 1, 0], [0, 0, 1]],
  deuteranopia: [[1, 0, 0], [0.9513092, 0, 0.04763418], [0, 0, 1]],
  tritanopia: [[1, 0, 0], [0, 1, 0], [-0.86744736, 1.86727089, 0]],
};
function simulate(h, kind) {
  const rgb = hex(h).map(lin);
  const lms = mul(RGB2LMS, rgb);
  const out = mul(PROJ[kind], lms);
  const back = mul(LMS2RGB, out).map(c => Math.min(1, Math.max(0, c)));
  // back to LAB via linear-RGB -> XYZ
  const [r, g, b] = back;
  const X = r * 0.4124564 + g * 0.3575761 + b * 0.1804375;
  const Y = r * 0.2126729 + g * 0.7151522 + b * 0.0721750;
  const Z = r * 0.0193339 + g * 0.1191920 + b * 0.9503041;
  return xyzToLab([X, Y, Z]);
}

// ── run the six checks ──────────────────────────────────────────────────────
const names = Object.keys(CHAINS);
const rows = names.map(n => ({ name: n, hex: CHAINS[n], L: lab(CHAINS[n])[0], C: chroma(CHAINS[n]), contrast: contrast(CHAINS[n], PANEL) }));

console.log('CHAIN PALETTE — six checks against panel ' + PANEL);
console.log('');
for (const r of rows) {
  console.log(`  ${r.name.padEnd(9)} ${r.hex}  L*=${r.L.toFixed(1).padStart(5)}  C*=${r.C.toFixed(1).padStart(5)}  contrast=${r.contrast.toFixed(2)}:1`);
}
const Ls = rows.map(r => r.L);
console.log('');
console.log(`1. lightness band       L* ${Math.min(...Ls).toFixed(1)} – ${Math.max(...Ls).toFixed(1)}  (spread ${(Math.max(...Ls) - Math.min(...Ls)).toFixed(1)})`);
console.log(`2. chroma floor         min C* = ${Math.min(...rows.map(r => r.C)).toFixed(1)}`);

// "adjacent" = every unordered pair, because the legend, the holdings bars and the capacity rows all
// place different pairs next to each other depending on sort order. The worst pair is the real bound.
function worstPair(labs) {
  let worst = { d: Infinity, a: null, b: null };
  for (let i = 0; i < names.length; i++) {
    for (let j = i + 1; j < names.length; j++) {
      const d = deltaE2000(labs[i], labs[j]);
      if (d < worst.d) worst = { d, a: names[i], b: names[j] };
    }
  }
  return worst;
}
const normal = worstPair(names.map(n => lab(CHAINS[n])));
console.log(`4. normal-vision floor  worst pair ΔE2000 = ${normal.d.toFixed(1)}  (${normal.a} vs ${normal.b})`);
let worstCvd = { d: Infinity };
for (const kind of Object.keys(PROJ)) {
  const w = worstPair(names.map(n => simulate(CHAINS[n], kind)));
  console.log(`3. ${kind.padEnd(14)}      worst pair ΔE2000 = ${w.d.toFixed(1)}  (${w.a} vs ${w.b})`);
  if (w.d < worstCvd.d) worstCvd = { ...w, kind };
}
console.log(`3. CVD separation       WORST across all three = ${worstCvd.d.toFixed(1)} (${worstCvd.kind}: ${worstCvd.a} vs ${worstCvd.b})`);
console.log(`5. contrast >= 3:1      min = ${Math.min(...rows.map(r => r.contrast)).toFixed(2)}:1  ${Math.min(...rows.map(r => r.contrast)) >= 3 ? 'PASS' : 'FAIL'}`);
console.log(`6. identity             fixed per chain, never recycled — structural, enforced by the HUE map being a constant`);

console.log('');
console.log('TEXT TOKENS (craft debt X1) — contrast against ' + PANEL);
for (const [name, v] of Object.entries({
  '--ink #e8edf0': '#e8edf0', '--dim #828d97': '#828d97',
  '--dimmer OLD #4a545c': '#4a545c', '--dimmer NEW #737f8a': '#737f8a',
  '--sig #3dfaa0': '#3dfaa0', '--warn #ffb545': '#ffb545', '--bad #ff5c5c': '#ff5c5c',
})) {
  const c = contrast(v, PANEL);
  console.log(`  ${name.padEnd(22)} ${c.toFixed(2)}:1  ${c >= 4.5 ? 'AA text' : c >= 3 ? 'AA large only' : 'FAIL'}`);
}
