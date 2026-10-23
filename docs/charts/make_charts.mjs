// Generates the benchmark charts as self-contained SVG files next to this script.
// Usage (from the repository root): node docs/charts/make_charts.mjs
// No dependencies. Node 20+. Reads data.json in the same directory.

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const data = JSON.parse(readFileSync(join(here, 'data.json'), 'utf8'));

const esc = (s) =>
  String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const pct = (v) => (v > 0 ? '+' : '') + v.toFixed(1) + '%';

// Word-wrap plain text into lines of at most `max` characters.
function wrap(text, max) {
  const lines = [];
  let line = '';
  for (const word of text.split(' ')) {
    const next = line ? `${line} ${word}` : word;
    if (next.length > max && line) {
      lines.push(line);
      line = word;
    } else {
      line = next;
    }
  }
  if (line) lines.push(line);
  return lines;
}

// Colors are CSS custom properties on :root; the dark block mirrors the
// dark chart surface from the reference palette (palette.md).
const STYLE = `
:root{--surface:#fcfcfb;--ink:#0b0b0b;--ink2:#52514e;--muted:#898781;--grid:#e1e0d9;--axis:#c3c2b7;--blue:#2a78d6;--red:#e34948}
@media (prefers-color-scheme: dark){:root{--surface:#1a1a19;--ink:#f0efec;--ink2:#c3c2b7;--grid:#2c2c2a;--axis:#383835;--blue:#3987e5;--red:#e66767}}
text{font-family:system-ui,-apple-system,"Segoe UI",sans-serif}
.ink{fill:var(--ink)}.ink2{fill:var(--ink2)}
.grid{stroke:var(--grid);stroke-width:1}.axis{stroke:var(--axis);stroke-width:1.5}
.base,.down{fill:var(--blue)}.up{fill:var(--red)}.other{fill:var(--muted)}
.zoneA{fill:var(--muted);fill-opacity:.12}.zoneB{fill:var(--blue);fill-opacity:.10}
.line{fill:none;stroke:var(--blue);stroke-width:2}
.dot{fill:var(--blue);stroke:var(--surface);stroke-width:2}
`;

// Text helper. Font size is an attribute (CSS would override it otherwise).
function T(x, y, s, o = {}) {
  const a = [`x="${x}"`, `y="${y}"`, `class="${o.cls || 'ink'}"`, `font-size="${o.size || 13}"`];
  if (o.anchor) a.push(`text-anchor="${o.anchor}"`);
  if (o.weight) a.push(`font-weight="${o.weight}"`);
  return `<text ${a.join(' ')}>${esc(s)}</text>`;
}

// Horizontal bar starting at x0 with signed width w. The end at x0 stays
// square (baseline side); only the data end gets the rounded corner.
function bar(x0, y, w, h, r = 4) {
  const dir = Math.sign(w);
  const a = Math.abs(w);
  if (a === 0) return '';
  const rr = Math.min(r, a, h / 2);
  const x1 = x0 + w;
  const xe = x1 - dir * rr;
  return `M${x0},${y}H${xe}Q${x1},${y} ${x1},${y + rr}V${y + h - rr}Q${x1},${y + h} ${xe},${y + h}H${x0}Z`;
}

// Title (wrapped) and subtitle. Returns the SVG fragment and the next free y.
function header(title, subtitle) {
  const lines = wrap(title, 70);
  let body = '';
  lines.forEach((l, i) => {
    body += T(24, 28 + i * 22, l, { cls: 'ink', size: 16, weight: 600 });
  });
  const sy = 28 + (lines.length - 1) * 22 + 22;
  body += T(24, sy, subtitle, { cls: 'ink2', size: 13 });
  return { body, y: sy + 26 };
}

// Source line at the bottom. Returns the fragment and the total height.
function footer(y) {
  return { body: T(24, y, data.source, { cls: 'ink2', size: 11 }), h: y + 18 };
}

// 1. Diverging bars around zero: pxpipe cost change by session size.
function chartGain() {
  const d = data['pxpipe-gain-by-context'];
  const cx = 450; // zero line
  const k = 8; // px per percentage point; axis spans +/-30%
  const h = header(d.title, d.subtitle);
  let b = h.body;
  const y = h.y;

  b += `<rect class="up" x="24" y="${y - 9}" width="12" height="12" rx="2"/>`;
  b += T(42, y + 1, 'Cost up (more expensive)', { cls: 'ink2' });
  b += `<rect class="down" x="236" y="${y - 9}" width="12" height="12" rx="2"/>`;
  b += T(254, y + 1, 'Cost down (cheaper)', { cls: 'ink2' });

  const rs = y + 26;
  const step = 78;
  const n = d.items.length;
  const bottom = rs + (n - 1) * step + 70;

  for (const t of [-30, -20, -10, 10, 20, 30]) {
    const x = cx + t * k;
    b += `<line class="grid" x1="${x}" y1="${rs - 6}" x2="${x}" y2="${bottom}"/>`;
  }
  b += `<line class="axis" x1="${cx}" y1="${rs - 6}" x2="${cx}" y2="${bottom}"/>`;
  for (const t of [-30, -20, -10, 0, 10, 20, 30]) {
    const label = t === 0 ? '0%' : (t > 0 ? '+' : '') + t + '%';
    b += T(cx + t * k, bottom + 16, label, { cls: 'ink2', size: 12, anchor: 'middle' });
  }

  d.items.forEach((it, i) => {
    const top = rs + i * step;
    const w = it.pct * k;
    const up = it.pct > 0;
    b += T(24, top + 12, it.name, { cls: 'ink', size: 13, weight: 600 });
    b += T(24, top + 28, it.detail, { cls: 'ink2', size: 12 });
    b += `<path class="${up ? 'up' : 'down'}" d="${bar(cx, top + 36, w, 26, 4)}"/>`;
    const lx = up ? cx + w + 8 : cx + w - 8;
    b += T(lx, top + 53, pct(it.pct), { cls: 'ink', size: 13, weight: 600, anchor: up ? 'start' : 'end' });
  });

  const f = footer(bottom + 40);
  return { title: d.title, desc: d.desc, body: b + f.body, h: f.h };
}

// 2. Two side-by-side bar groups for the XL session.
function chartXl() {
  const d = data['xl-near-limit'];
  const h = header(d.title, d.subtitle);
  let b = h.body;
  const ph = h.y + 12; // panel headings
  const rs = ph + 20;
  const rows = d.rows;

  const panels = [
    { x0: 24, key: 'cost', pctKey: 'costPct', label: 'Cost per session', fmt: (v) => `$${v.toFixed(3)}` },
    { x0: 372, key: 'peak', pctKey: 'peakPct', label: 'Peak context', fmt: (v) => `${v.toFixed(1)}k tokens` },
  ];
  for (const p of panels) {
    const max = Math.max(...rows.map((r) => r[p.key]));
    b += T(p.x0, ph, p.label, { cls: 'ink', size: 14, weight: 600 });
    rows.forEach((r, i) => {
      const top = rs + i * 60;
      const v = r[p.key];
      b += T(p.x0, top + 12, r.name + (r.footnote ? ' *' : ''), { cls: 'ink2', size: 13 });
      const w = (v / max) * 200;
      b += `<path class="${r.baseline ? 'other' : 'base'}" d="${bar(p.x0, top + 20, w, 22, 4)}"/>`;
      const tag = r.baseline ? 'baseline' : pct(r[p.pctKey]);
      b += T(p.x0 + w + 8, top + 35, `${p.fmt(v)} (${tag})`, { cls: 'ink', size: 13 });
    });
  }

  const fy = rs + (rows.length - 1) * 60 + 64;
  wrap(d.footnote, 100).forEach((line, i) => {
    b += T(24, fy + i * 15, line, { cls: 'ink2', size: 12 });
  });
  const f = footer(fy + (wrap(d.footnote, 100).length - 1) * 15 + 30);
  return { title: d.title, desc: d.desc, body: b + f.body, h: f.h };
}

// 3. Sorted horizontal bars, baseline highlighted.
function chartEveryday() {
  const d = data.everyday;
  const h = header(d.title, d.subtitle);
  let b = h.body;
  const items = [...d.items].sort((a, c) => a.cost - c.cost);
  const zero = 312;
  const scale = 250 / 0.6; // px per dollar; domain 0 to $0.60
  const rs = h.y + 10;
  const step = 36;
  const bottom = rs + items.length * step;

  b += `<line class="axis" x1="${zero}" y1="${rs - 4}" x2="${zero}" y2="${bottom - 6}"/>`;
  items.forEach((it, i) => {
    const top = rs + i * step;
    const w = it.cost * scale;
    b += T(24, top + 18, it.name, { cls: it.baseline ? 'ink' : 'ink2', size: 13, weight: it.baseline ? 600 : 400 });
    b += `<path class="${it.baseline ? 'base' : 'other'}" d="${bar(zero, top + 8, w, 20, 4)}"/>`;
    const tag = it.baseline ? 'baseline' : pct(it.pct);
    b += T(zero + w + 8, top + 22, `$${it.cost.toFixed(3)} (${tag})`, { cls: 'ink', size: 13 });
  });

  const f = footer(bottom + 22);
  return { title: d.title, desc: d.desc, body: b + f.body, h: f.h };
}

// 4. Context size per request, with zones and dry-run savings.
function chartRouter() {
  const d = data['router-decisions'];
  const h = header(d.title, d.subtitle);
  let b = h.body;

  const maxI = Math.max(...d.points.map((p) => p[0]));
  const X = (i) => 70 + (i / maxI) * 610;
  const Y = (k) => 380 - k * 2.6; // 0k at y=380, 100k at y=120
  const lo = d.zoneLow;
  const hi = d.zoneHigh;
  const w = d.window;
  const shareLo = Math.round((lo / w) * 100);
  const shareHi = Math.round((hi / w) * 100);
  const winK = w; // data.json gives the window in k tokens

  // Zones
  b += `<rect class="zoneB" x="70" y="${Y(hi)}" width="610" height="${Y(lo) - Y(hi)}"/>`;
  b += `<rect class="zoneA" x="70" y="${Y(lo)}" width="610" height="${Y(0) - Y(lo)}"/>`;
  b += T(80, Y(hi) + 18, `${lo}k to ${hi}k (${shareLo}% to ${shareHi}% of ${winK}k): dry run, switch only if it pays back within 20 requests`, { cls: 'ink2', size: 12 });
  b += T(80, Y(0) - 16, `Below ${lo}k (under ${shareLo}% of ${winK}k): direct, no analysis`, { cls: 'ink2', size: 12 });

  // Y axis
  b += T(70, Y(hi) - 12, 'Context size (k tokens)', { cls: 'ink2', size: 12 });
  for (const k of [0, 20, 40, 60, 80, 100]) {
    if (k > 0) b += `<line class="grid" x1="70" y1="${Y(k)}" x2="680" y2="${Y(k)}"/>`;
    b += T(62, Y(k) + 4, `${k}k`, { cls: 'ink2', size: 12, anchor: 'end' });
  }
  // X axis
  b += `<line class="axis" x1="70" y1="380" x2="680" y2="380"/>`;
  for (let i = 0; i <= 70; i += 10) {
    b += T(X(i), 396, String(i), { cls: 'ink2', size: 12, anchor: 'middle' });
  }
  b += T(375, 414, 'Request index', { cls: 'ink2', size: 12, anchor: 'middle' });

  // Line and points
  const path = d.points.map(([i, k], j) => `${j ? 'L' : 'M'}${X(i).toFixed(1)},${Y(k).toFixed(1)}`).join('');
  b += `<path class="line" d="${path}"/>`;
  for (const [i, k] of d.points) {
    b += `<circle class="dot" cx="${X(i).toFixed(1)}" cy="${Y(k).toFixed(1)}" r="4"/>`;
  }
  const last = d.points[d.points.length - 1];
  b += T(X(last[0]) - 4, Y(last[1]) - 14, 'switched to pxpipe', { cls: 'ink', size: 12, anchor: 'end' });

  // Dry-run savings strip aligned to request index
  b += T(24, 440, 'Saving S', { cls: 'ink2', size: 12 });
  for (const [i, s] of d.savings) {
    b += T(X(i).toFixed(1), 440, `${s.toFixed(1)}k`, { cls: 'ink', size: 12, anchor: 'middle' });
  }

  const noteLines = wrap(d.note, 100);
  noteLines.forEach((line, i) => {
    b += T(24, 470 + i * 15, line, { cls: 'ink2', size: 12 });
  });
  const f = footer(470 + (noteLines.length - 1) * 15 + 30);
  return { title: d.title, desc: d.desc, body: b + f.body, h: f.h };
}

function svgDoc(name, c) {
  const id = `chart-${name}`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 720 ${c.h}" width="720" height="${c.h}" role="img" aria-labelledby="${id}-t ${id}-d">
<title id="${id}-t">${esc(c.title)}</title>
<desc id="${id}-d">${esc(c.desc)}</desc>
<style>${STYLE}</style>
${c.body}
</svg>
`;
}

const charts = {
  'pxpipe-gain-by-context': chartGain(),
  'xl-near-limit': chartXl(),
  everyday: chartEveryday(),
  'router-decisions': chartRouter(),
};

for (const [name, c] of Object.entries(charts)) {
  const out = join(here, `${name}.svg`);
  writeFileSync(out, svgDoc(name, c), 'utf8');
  console.log(`wrote ${out}`);
}
