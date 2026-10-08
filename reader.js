/* OIL-TEX Yard — fast on-device reader for Thai plates and Thai ID numbers.
   Two small neural networks trained for this app (characters 32x32, province lines 32x128) run in plain JS.
   Pipeline per frame: binarize -> find character row -> classify each character -> Thai plate grammar ->
   fuse many frames per character -> match against registered vehicles -> lock. */
"use strict";
const Reader = (() => {
  const DIGITS = "0123456789", CONS = "กขคฆงจฉชซฌญฎฏฐฑฒณดตถทธนบปผฝพฟภมยรลวศษสหฬอฮ";
  const CLASSES = [...DIGITS, ...CONS, "#"], JUNK = CLASSES.length - 1, NDIG = 10;
  const PROVINCES = OCR.PROVINCES;
  const isDigit = ch => ch >= "0" && ch <= "9";

  /* ---------------- tiny CNN runtime ---------------- */
  function f16(h) {
    const s = (h & 0x8000) ? -1 : 1, e = (h >> 10) & 0x1f, f = h & 0x3ff;
    if (e === 0) return s * Math.pow(2, -14) * (f / 1024);
    if (e === 31) return f ? NaN : s * Infinity;
    return s * Math.pow(2, e - 15) * (1 + f / 1024);
  }
  async function loadModel(url) {
    const [man, buf] = await Promise.all([fetch(url + ".json").then(r => r.json()), fetch(url + ".bin").then(r => r.arrayBuffer())]);
    const u16 = new Uint16Array(buf), layers = [];
    for (const t of man.tensors) {
      const a = new Float32Array(t.size);
      for (let i = 0; i < t.size; i++) a[i] = f16(u16[t.offset + i]);
      (layers[t.layer] = layers[t.layer] || {})[t.name] = a;
      layers[t.layer][t.name + "Shape"] = t.shape;
    }
    return {man, layers, h: man.arch.inp[0], w: man.arch.inp[1]};
  }
  // conv3x3 SAME + bias + relu, then 2x2 max-pool. x: [H][W][C] flat.
  function convPool(x, H, W, C, L) {
    const [, , cin, cout] = L.wShape, w = L.w, b = L.b;
    const y = new Float32Array(H * W * cout);
    for (let i = 0; i < H; i++) for (let j = 0; j < W; j++) {
      const o = (i * W + j) * cout;
      for (let co = 0; co < cout; co++) y[o + co] = b[co];
      for (let ky = 0; ky < 3; ky++) {
        const yy = i + ky - 1; if (yy < 0 || yy >= H) continue;
        for (let kx = 0; kx < 3; kx++) {
          const xx = j + kx - 1; if (xx < 0 || xx >= W) continue;
          const xo = (yy * W + xx) * cin, wo = (ky * 3 + kx) * cin * cout;
          for (let ci = 0; ci < cin; ci++) {
            const v = x[xo + ci]; if (v === 0) continue;
            const wr = wo + ci * cout;
            for (let co = 0; co < cout; co++) y[o + co] += v * w[wr + co];
          }
        }
      }
    }
    const H2 = H >> 1, W2 = W >> 1, p = new Float32Array(H2 * W2 * cout);
    for (let i = 0; i < H2; i++) for (let j = 0; j < W2; j++) for (let c = 0; c < cout; c++) {
      const a = y[((2 * i) * W + 2 * j) * cout + c], bb = y[((2 * i) * W + 2 * j + 1) * cout + c],
        cc = y[((2 * i + 1) * W + 2 * j) * cout + c], d = y[((2 * i + 1) * W + 2 * j + 1) * cout + c];
      const m = Math.max(a, bb, cc, d); p[(i * W2 + j) * cout + c] = m > 0 ? m : 0;
    }
    return [p, H2, W2, cout];
  }
  function dense(x, L, relu) {
    const [nin, nout] = L.wShape, w = L.w, y = new Float32Array(nout);
    for (let o = 0; o < nout; o++) y[o] = L.b[o];
    for (let i = 0; i < nin; i++) { const v = x[i]; if (v === 0) continue; const r = i * nout; for (let o = 0; o < nout; o++) y[o] += v * w[r + o]; }
    if (relu) for (let o = 0; o < nout; o++) if (y[o] < 0) y[o] = 0;
    return y;
  }
  function softmax(z) { let m = -Infinity; for (const v of z) if (v > m) m = v; let s = 0; const o = new Float32Array(z.length); for (let i = 0; i < z.length; i++) { o[i] = Math.exp(z[i] - m); s += o[i]; } for (let i = 0; i < z.length; i++) o[i] /= s; return o; }
  function predict(model, input) {
    let x = input, H = model.h, W = model.w, C = 1;
    const L = model.layers;
    for (let k = 0; k < L.length - 2; k++) [x, H, W, C] = convPool(x, H, W, C, L[k]);
    x = dense(x, L[L.length - 2], true);
    return softmax(dense(x, L[L.length - 1], false));
  }

  /* ---------------- image helpers (mirror gen.py exactly) ---------------- */
  function axisWeights(src, dst) {
    const W = [];
    if (dst < src) {
      const sc = src / dst;
      for (let i = 0; i < dst; i++) {
        const a = i * sc, b = (i + 1) * sc, row = [];
        for (let j = Math.floor(a); j < Math.min(src, Math.ceil(b)); j++) { const ov = Math.min(b, j + 1) - Math.max(a, j); if (ov > 0) row.push([j, ov / sc]); }
        W.push(row);
      }
    } else {
      for (let i = 0; i < dst; i++) {
        let x = (i + 0.5) * src / dst - 0.5; x = Math.min(Math.max(x, 0), src - 1);
        const j0 = Math.floor(x), f = x - j0, j1 = Math.min(j0 + 1, src - 1);
        W.push(j0 === j1 ? [[j0, 1]] : [[j0, 1 - f], [j1, f]]);
      }
    }
    return W;
  }
  function resizeF(src, sw, sh, dw, dh) {
    const wx = axisWeights(sw, dw), wy = axisWeights(sh, dh), tmp = new Float32Array(sh * dw), out = new Float32Array(dh * dw);
    for (let y = 0; y < sh; y++) for (let i = 0; i < dw; i++) { let s = 0; for (const [j, w] of wx[i]) s += src[y * sw + j] * w; tmp[y * dw + i] = s; }
    for (let i = 0; i < dh; i++) for (let x = 0; x < dw; x++) { let s = 0; for (const [j, w] of wy[i]) s += tmp[j * dw + x] * w; out[i * dw + x] = s; }
    return out;
  }
  function percentile(arr, q) {
    const a = Float32Array.from(arr).sort(), pos = (a.length - 1) * q / 100, lo = Math.floor(pos), hi = Math.ceil(pos);
    return a[lo] + (a[hi] - a[lo]) * (pos - lo);
  }
  function cropInv(g, x0, y0, x1, y1) {
    const w = x1 - x0, h = y1 - y0, c = new Float32Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) c[y * w + x] = 255 - g.d[(y + y0) * g.w + x + x0];
    const lo = percentile(c, 5), hi = percentile(c, 98), span = Math.max(hi - lo, 20);
    for (let i = 0; i < c.length; i++) { const v = (c[i] - lo) / span; c[i] = v < 0 ? 0 : v > 1 ? 1 : v; }
    return {c, w, h};
  }
  function normChar(g, b) {
    const bw = b.x1 - b.x0 + 1, bh = b.y1 - b.y0 + 1, pad = Math.max(1, Math.round(Math.max(bw, bh) * 0.08));
    const {c, w, h} = cropInv(g, Math.max(0, b.x0 - pad), Math.max(0, b.y0 - pad), Math.min(g.w, b.x1 + pad + 1), Math.min(g.h, b.y1 + pad + 1));
    const s = 28 / Math.max(w, h), nw = Math.max(1, Math.round(w * s)), nh = Math.max(1, Math.round(h * s));
    const r = resizeF(c, w, h, nw, nh), out = new Float32Array(32 * 32), ox = (32 - nw) >> 1, oy = (32 - nh) >> 1;
    for (let y = 0; y < nh; y++) for (let x = 0; x < nw; x++) out[(y + oy) * 32 + x + ox] = r[y * nw + x];
    return out;
  }
  function normLine(g, b) {
    const ph = Math.max(1, Math.round((b.y1 - b.y0 + 1) * 0.12)), pw = Math.max(1, Math.round((b.x1 - b.x0 + 1) * 0.03));
    const {c, w, h} = cropInv(g, Math.max(0, b.x0 - pw), Math.max(0, b.y0 - ph), Math.min(g.w, b.x1 + pw + 1), Math.min(g.h, b.y1 + ph + 1));
    return resizeF(c, w, h, 128, 32);
  }
  // grayscale from a canvas region; mode "max" lifts coloured plate backgrounds (yellow/red/green) above black text
  function grayOf(canvas, mode) {
    const w = canvas.width, h = canvas.height, px = canvas.getContext("2d", {willReadFrequently: true}).getImageData(0, 0, w, h).data, d = new Uint8Array(w * h);
    for (let i = 0, j = 0; i < d.length; i++, j += 4) d[i] = mode === "max" ? Math.max(px[j], px[j + 1], px[j + 2]) : (px[j] * 299 + px[j + 1] * 587 + px[j + 2] * 114) / 1000;
    return {w, h, d};
  }
  function invert(g) { const d = new Uint8Array(g.d.length); for (let i = 0; i < d.length; i++) d[i] = 255 - g.d[i]; return {w: g.w, h: g.h, d}; }
  // Bradley local threshold: 1 = ink (darker than local mean by t)
  function binarize(g, win, t) {
    const {w, h, d} = g, I = new Float64Array((w + 1) * (h + 1)), b = new Uint8Array(w * h), r = win >> 1;
    for (let y = 0; y < h; y++) { let s = 0; for (let x = 0; x < w; x++) { s += d[y * w + x]; I[(y + 1) * (w + 1) + x + 1] = I[y * (w + 1) + x + 1] + s; } }
    for (let y = 0; y < h; y++) {
      const y0 = Math.max(0, y - r), y1 = Math.min(h - 1, y + r);
      for (let x = 0; x < w; x++) {
        const x0 = Math.max(0, x - r), x1 = Math.min(w - 1, x + r), n = (x1 - x0 + 1) * (y1 - y0 + 1);
        const s = I[(y1 + 1) * (w + 1) + x1 + 1] - I[y0 * (w + 1) + x1 + 1] - I[(y1 + 1) * (w + 1) + x0] + I[y0 * (w + 1) + x0];
        b[y * w + x] = d[y * w + x] * n <= s * (1 - t) ? 1 : 0;
      }
    }
    return b;
  }
  // 8-connected components with bounding boxes
  function components(b, w, h, minArea) {
    const lab = new Int32Array(w * h), par = [0];
    const find = a => { while (par[a] !== a) { par[a] = par[par[a]]; a = par[a]; } return a; };
    let next = 1;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x; if (!b[i]) continue;
      const nb = [];
      if (x > 0 && lab[i - 1]) nb.push(lab[i - 1]);
      if (y > 0) { const u = i - w; if (lab[u]) nb.push(lab[u]); if (x > 0 && lab[u - 1]) nb.push(lab[u - 1]); if (x < w - 1 && lab[u + 1]) nb.push(lab[u + 1]); }
      if (!nb.length) { par.push(next); lab[i] = next++; continue; }
      let m = find(nb[0]); for (const n of nb) { const r = find(n); if (r < m) m = r; }
      for (const n of nb) { const r = find(n); if (r !== m) par[r] = m; }
      lab[i] = m;
    }
    const st = new Map();
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const l = lab[y * w + x]; if (!l) continue;
      const r = find(l); let s = st.get(r);
      if (!s) st.set(r, s = {x0: x, y0: y, x1: x, y1: y, area: 0});
      if (x < s.x0) s.x0 = x; if (x > s.x1) s.x1 = x; if (y < s.y0) s.y0 = y; if (y > s.y1) s.y1 = y; s.area++;
    }
    const out = [];
    for (const s of st.values()) if (s.area >= minArea) { s.w = s.x1 - s.x0 + 1; s.h = s.y1 - s.y0 + 1; s.cx = (s.x0 + s.x1) / 2; s.cy = (s.y0 + s.y1) / 2; out.push(s); }
    return out;
  }
  const union = (a, b) => { const s = {x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1), area: a.area + b.area}; s.w = s.x1 - s.x0 + 1; s.h = s.y1 - s.y0 + 1; s.cx = (s.x0 + s.x1) / 2; s.cy = (s.y0 + s.y1) / 2; return s; };
  // join pieces of one glyph (broken strokes, ญ/ฐ tails) that sit on top of each other
  function mergeStacked(cs) {
    cs = cs.slice().sort((a, b) => b.area - a.area);
    let changed = true;
    while (changed) {
      changed = false;
      for (let i = 0; i < cs.length && !changed; i++) for (let j = i + 1; j < cs.length && !changed; j++) {
        const a = cs[i], b = cs[j];
        if (a.w > 1.6 * a.h || b.w > 1.6 * b.h) continue;                       // frames, dashes, long lines
        const ov = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0) + 1, gap = Math.max(a.y0, b.y0) - Math.min(a.y1, b.y1);
        if (gap < -0.2 * Math.min(a.h, b.h)) continue;                            // one inside the other: not stacked
        const u = union(a, b);
        if (u.h > 1.7 * Math.max(a.h, b.h) || u.w > 1.25 * Math.max(a.w, b.w)) continue;
        if (ov > 0.55 * Math.min(a.w, b.w) && gap < 0.3 * Math.max(a.h, b.h) && b.area > 0.015 * a.area) { cs[i] = u; cs.splice(j, 1); changed = true; }
      }
    }
    return cs;
  }
  const median = a => { const s = a.slice().sort((x, y) => x - y); return s.length ? s[s.length >> 1] : 0; };

  /* ---------------- plate: find characters in one frame ---------------- */
  function findRow(cs, W, H) {
    const cand = cs.filter(c => c.h >= 0.1 * H && c.h <= 0.9 * H && c.w >= 0.2 * c.h && c.w <= 1.9 * c.h && c.area / (c.w * c.h) >= 0.08 && c.area / (c.w * c.h) <= 0.95 && c.x0 > 0 && c.x1 < W - 1 && c.y0 > 0 && c.y1 < H - 1);
    // same text row: mostly the same vertical span (consonants are shorter than digits; ฎ ฏ ฐ ญ hang lower)
    const sameRow = (c, s) => {
      const r = c.h / s.h; if (r < 0.55 || r > 1.8) return false;
      return Math.min(c.y1, s.y1) - Math.max(c.y0, s.y0) + 1 >= 0.6 * Math.min(c.h, s.h);
    };
    let best = null;
    for (const s of cand) {
      const mem = cand.filter(c => sameRow(c, s)).sort((a, b) => a.x0 - b.x0);
      if (mem.length < 2) continue;
      const mh = median(mem.map(m => m.h)), si = mem.indexOf(s);
      let a = si, b = si;
      while (a > 0 && mem[a].x0 - mem[a - 1].x1 < 1.4 * mh) a--;
      while (b < mem.length - 1 && mem[b + 1].x0 - mem[b].x1 < 1.4 * mh) b++;
      const run = mem.slice(a, b + 1).filter((c, i, arr) => !arr.some(o => o !== c && o.x0 <= c.x0 && o.x1 >= c.x1 && o.y0 <= c.y0 && o.y1 >= c.y1));
      if (run.length < 2 || run.length > 9) continue;
      const score = Math.min(run.length, 7) * 5 + (mh / H) * 100;
      if (!best || score > best.score) best = {score, run, mh};
    }
    return best;
  }
  // pieces that may belong to a row glyph: a tail below (ฎ ฏ ฐ ญ) or a broken-off stroke above/below
  function attachables(m, cs, row) {
    const mh = row.mh, inRow = new Set(row.run);
    return cs.filter(c => !inRow.has(c) && c.h < 0.7 * mh && c.area > 0.01 * m.area &&
      Math.min(m.x1, c.x1) - Math.max(m.x0, c.x0) + 1 > 0.5 * Math.min(m.w, c.w) && c.cx >= m.x0 - 0.1 * m.w && c.cx <= m.x1 + 0.1 * m.w &&
      ((c.y0 >= m.y1 - 0.1 * mh && c.y0 - m.y1 < 0.2 * mh) || (c.y1 <= m.y0 + 0.1 * mh && m.y0 - c.y1 < 0.2 * mh))).slice(0, 2);
  }
  const charConf = p => { let m = 0; for (let k = 0; k < JUNK; k++) if (p[k] > m) m = p[k]; return m; };
  // a truck-plate dash glued to a digit ("0-" or "-6"): thin bar at mid-height on the blob's left/right edge
  function trimDash(b, W, c, mh) {
    const mid = c.y0 + c.h / 2, colInfo = x => { let y0 = -1, y1 = -1; for (let y = c.y0; y <= c.y1; y++) if (b[y * W + x]) { if (y0 < 0) y0 = y; y1 = y; } return [y0, y1]; };
    const isBar = x => { const [y0, y1] = colInfo(x); return y0 >= 0 && y1 - y0 <= 0.28 * mh && Math.abs((y0 + y1) / 2 - mid) < 0.22 * mh; };
    for (const side of [1, -1]) {
      let x = side > 0 ? c.x1 : c.x0, n = 0;
      while (n < c.w * 0.6 && isBar(x)) { x -= side; n++; }
      if (n >= 0.18 * mh) {
        const xa = side > 0 ? c.x0 : x + 1, xb = side > 0 ? x : c.x1;
        let y0 = c.y1, y1 = c.y0, a = 0, X0 = xb, X1 = xa;
        for (let y = c.y0; y <= c.y1; y++) for (let xx = xa; xx <= xb; xx++) if (b[y * W + xx]) { a++; if (y < y0) y0 = y; if (y > y1) y1 = y; if (xx < X0) X0 = xx; if (xx > X1) X1 = xx; }
        if (!a) return null;
        const t = {x0: X0, x1: X1, y0, y1, area: a}; t.w = X1 - X0 + 1; t.h = y1 - y0 + 1; t.cx = (X0 + X1) / 2; t.cy = (y0 + y1) / 2;
        const dash = side > 0 ? {x0: xb + 1, x1: c.x1} : {x0: c.x0, x1: x};
        return {glyph: t, dash};
      }
    }
    return null;
  }
  // cut a blob where blur has fused two glyphs ("71" -> one shape): thinnest column in the middle
  function splitBox(b, W, c) {
    let best = -1, bv = Infinity;
    for (let x = Math.round(c.x0 + 0.28 * c.w); x <= Math.round(c.x0 + 0.72 * c.w); x++) {
      let v = 0; for (let y = c.y0; y <= c.y1; y++) v += b[y * W + x];
      if (v < bv) { bv = v; best = x; }
    }
    if (best < 0 || bv > 0.45 * c.h) return null;
    const shrink = (x0, x1) => {
      let y0 = c.y1, y1 = c.y0, a = 0, X0 = x1, X1 = x0;
      for (let y = c.y0; y <= c.y1; y++) for (let x = x0; x <= x1; x++) if (b[y * W + x]) { a++; if (y < y0) y0 = y; if (y > y1) y1 = y; if (x < X0) X0 = x; if (x > X1) X1 = x; }
      if (!a) return null;
      const s = {x0: X0, x1: X1, y0, y1, area: a}; s.w = X1 - X0 + 1; s.h = y1 - y0 + 1; s.cx = (X0 + X1) / 2; s.cy = (y0 + y1) / 2; return s;
    };
    const l = shrink(c.x0, best - 1), r = shrink(best + 1, c.x1);
    return l && r && l.h > 0.5 * c.h && r.h > 0.5 * c.h ? [l, r] : null;
  }
  function findDash(cs, row) {
    const mh = row.mh, cy = median(row.run.map(c => c.cy));
    return cs.filter(c => c.h >= 0.05 * mh && c.h <= 0.35 * mh && c.w >= 0.25 * mh && c.w <= 1.3 * mh && Math.abs(c.cy - cy) < 0.3 * mh && c.x0 > row.run[0].x0 && c.x1 < row.run[row.run.length - 1].x1);
  }
  function provinceBox(cs, row, W, H) {
    const r0 = row.run[0], r1 = row.run[row.run.length - 1], mh = row.mh;
    const bot = Math.max(...row.run.map(c => c.y1)), top = bot + 0.02 * mh, lim = Math.min(H - 1, bot + 1.05 * mh);
    const rowW = r1.x1 - r0.x0, xl = r0.x0 - 0.4 * rowW, xr = r1.x1 + 0.4 * rowW;
    const parts = cs.filter(c => c.y0 >= top && c.y1 <= lim + 0.1 * mh && c.cx >= xl && c.cx <= xr && c.h >= 0.04 * mh && c.h <= 0.75 * mh && !(c.w > 5 * c.h && c.h < 0.15 * mh) && c.w < 0.9 * (xr - xl));
    // letters of the province name: the main band of mid-size glyphs
    const core = parts.filter(c => c.h >= 0.18 * mh && c.h <= 0.65 * mh && c.w <= 1.6 * c.h);
    if (!core.length) return null;
    const mid = (r0.x0 + r1.x1) / 2;
    core.sort((p, q) => p.cx - q.cx);
    let ci = 0; core.forEach((p, i) => { if (Math.abs(p.cx - mid) < Math.abs(core[ci].cx - mid)) ci = i; });
    // grow along the band while letters are close together and on the same line
    const bandY = core[ci].y1, gapMax = 0.7 * mh;
    let a = ci, b = ci;
    while (a > 0 && core[a].x0 - core[a - 1].x1 < gapMax && Math.abs(core[a - 1].y1 - bandY) < 0.25 * mh) a--;
    while (b < core.length - 1 && core[b + 1].x0 - core[b].x1 < gapMax && Math.abs(core[b + 1].y1 - bandY) < 0.25 * mh) b++;
    const letters = core.slice(a, b + 1);
    const ly0 = median(letters.map(c => c.y0)), ly1 = median(letters.map(c => c.y1)), lh = Math.max(4, ly1 - ly0);
    const lx0 = Math.min(...letters.map(c => c.x0)), lx1 = Math.max(...letters.map(c => c.x1));
    // vowels and tone marks: small pieces just above/below the letters, inside their span
    const marks = parts.filter(c => !letters.includes(c) && c.cx >= lx0 - 0.3 * lh && c.cx <= lx1 + 0.3 * lh && c.y1 >= ly0 - 0.9 * lh && c.y0 <= ly1 + 0.7 * lh && c.h < 1.3 * lh);
    const box = letters.concat(marks).reduce(union);
    if (box.w < 0.1 * rowW || box.h < 0.12 * mh) return null;
    return box;
  }
  // Thai plate grammar: [digit] consonant [consonant] digits(1-4), or truck NN-NNNN
  const STD = /^D?C{1,2}D{1,4}$/;
  function decode(probs, hasDash) {
    const n = probs.length; let best = null;
    const tScore = probs.map(p => { let d = 0, c = 0; for (let k = 0; k < NDIG; k++) d += p[k]; for (let k = NDIG; k < JUNK; k++) c += p[k]; return {D: Math.log(d + 1e-6), C: Math.log(c + 1e-6), X: Math.log(p[JUNK] + 1e-6) + Math.log(0.25)}; });
    const total = Math.pow(3, n);
    for (let m = 0; m < total; m++) {
      let k = m, types = "", score = 0, keep = [];
      for (let i = 0; i < n; i++) { const t = "DCX"[k % 3]; k = (k / 3) | 0; score += tScore[i][t]; if (t !== "X") { types += t; keep.push(i); } }
      const truck = hasDash && types === "DDDDDD";
      if (!truck && !STD.test(types)) continue;
      if (!best || score > best.score) best = {score, types, keep, truck};
    }
    if (!best) return null;
    const chars = best.keep.map((i, j) => {
      const t = best.types[j], p = probs[i], lo = t === "D" ? 0 : NDIG, hi = t === "D" ? NDIG : JUNK;
      let s = 0; for (let k = lo; k < hi; k++) s += p[k];
      const q = new Float32Array(hi - lo); for (let k = lo; k < hi; k++) q[k - lo] = p[k] / (s || 1);
      return {t, q};
    });
    return {types: best.types, truck: best.truck, chars};
  }
  const symOf = (t, k) => t === "D" ? DIGITS[k] : CONS[k];
  function display(text, truck) {
    if (truck) return text.slice(0, 2) + "-" + text.slice(2);
    const m = text.match(/^(\d?[ก-ฮ]{1,2})(\d{1,4})$/); return m ? m[1] + " " + m[2] : text;
  }

  let charModel = null, lineModel = null, loading = null;
  function load(base) {
    if (!loading) loading = Promise.all([loadModel(base + "char"), loadModel(base + "line").catch(() => null)]).then(([c, l]) => { charModel = c; lineModel = l; return true; }).catch(e => { loading = null; throw e; });
    return loading;
  }
  const ready = () => !!charModel;

  // One frame of a plate. canvas: crop around the guide box.
  function readPlateFrame(canvas, opts = {}) {
    if (!ready()) return null;
    const t0 = performance.now();
    let g = grayOf(canvas, "max");
    const W = g.w, H = g.h, win = Math.max(15, Math.round(W / 6) | 1);
    let res = null;
    for (const pol of ["dark", "light"]) {
      const gg = pol === "dark" ? g : invert(g);
      const bin = binarize(gg, win, 0.12), cs = components(bin, W, H, Math.max(6, (W * H) / 40000));
      const row = findRow(cs, W, H);
      if (!row) continue;
      if (res && res.row.run.length >= row.run.length) continue;
      res = {row, cs, g: gg, pol, bin};
      if (row.run.length >= 3) break;
    }
    if (!res) return {found: false, ms: performance.now() - t0};
    const {row, cs} = res;
    const bgOf = c => { // 75th percentile brightness of a ring around the glyph box
      const px = Math.round(0.25 * c.h), vals = [];
      for (let y = Math.max(0, c.y0 - px); y <= Math.min(H - 1, c.y1 + px); y += 2) for (let x = Math.max(0, c.x0 - px); x <= Math.min(W - 1, c.x1 + px); x += 2)
        if (x < c.x0 || x > c.x1 || y < c.y0 || y > c.y1) vals.push(res.g.d[y * W + x]);
      vals.sort((p, q) => p - q); return vals.length ? vals[Math.floor(vals.length * 0.75)] : 0;
    };
    const bgs = row.run.map(bgOf), mbg = median(bgs);
    row.run = row.run.filter((c, i) => bgs[i] >= 0.45 * mbg);   // glyphs on the dark car body around the plate
    // the plate's printed frame, when visible, encloses the real characters: drop the few it doesn't
    const inside = (f, c) => c.x0 > f.x0 + 2 && c.x1 < f.x1 - 2 && c.y0 > f.y0 && c.y1 < f.y1;
    let frame = null, fn = 0;
    for (const f of cs) {
      if (!(f.w > 0.45 * W && f.h > 1.6 * row.mh && f.area < 0.35 * f.w * f.h)) continue;
      const n = row.run.filter(c => inside(f, c)).length;
      if (n > fn || (n === fn && frame && f.w * f.h < frame.w * frame.h)) { frame = f; fn = n; }
    }
    if (frame && fn >= Math.max(2, 0.7 * row.run.length)) row.run = row.run.filter(c => inside(frame, c));
    if (row.run.length < 2) return {found: false, ms: performance.now() - t0};
    const glued = [];
    row.run = row.run.map(c => { const t = c.w > 0.6 * row.mh ? trimDash(res.bin, W, c, row.mh) : null; if (t) { glued.push(t.dash); return t.glyph; } return c; });
    const probs = row.run.map((c, i) => {
      let p = predict(charModel, normChar(res.g, c)), box = c;
      for (const a of attachables(c, cs, row)) {
        const u = union(box, a), q = predict(charModel, normChar(res.g, u));
        if (charConf(q) > charConf(p) + 0.05) { p = q; box = u; }
      }
      row.run[i] = box;
      return p;
    });
    const dashes = findDash(cs, row).concat(glued);
    // wide, unsure blobs may be two fused glyphs: try the cut and keep it when it reads better
    for (let i = row.run.length - 1; i >= 0; i--) {
      const c = row.run[i];
      if (c.w < 0.75 * row.mh || row.run.length >= 8) continue;
      const parts = splitBox(res.bin, W, c); if (!parts) continue;
      const pp = parts.map(q => predict(charModel, normChar(res.g, q)));
      const before = charConf(probs[i]), after = Math.min(charConf(pp[0]), charConf(pp[1]));
      const truckHint = dashes.length && dashes[0].x0 > c.x1 && row.run.filter(r => r.x1 < dashes[0].x0).length === 1;
      if (after > before + 0.1 || (truckHint && after > 0.5)) { row.run.splice(i, 1, ...parts); probs.splice(i, 1, ...pp); }
    }
    const dec = decode(probs, dashes.length > 0);
    if (!dec) return {found: false, ms: performance.now() - t0, row: row.run.length};
    let prov = null;
    const pb = provinceBox(cs, row, W, H);
    if (pb && lineModel) prov = predict(lineModel, normLine(res.g, pb));
    const text = dec.chars.map(c => symOf(c.t, argmax(c.q))).join("");
    return {found: true, sig: dec.types + (dec.truck ? "T" : ""), truck: dec.truck, chars: dec.chars, text, display: display(text, dec.truck), prov,
      boxes: dec.chars.map((_, j) => row.run[j]), ms: performance.now() - t0};
  }
  const argmax = a => { let m = 0; for (let i = 1; i < a.length; i++) if (a[i] > a[m]) m = i; return m; };

  /* ---------------- plate: fuse frames, match registry, decide lock ---------------- */
  function sigOf(plate) {
    const n = OCR.normPlate(plate), truck = /^\d{6}$/.test(n);
    return {sig: [...n].map(ch => isDigit(ch) ? "D" : "C").join("") + (truck ? "T" : ""), text: n};
  }
  class PlateFusion {
    constructor(registry) {
      this.frames = 0; this.by = new Map(); this.recent = [];
      this.reg = (registry || []).map(r => Object.assign({}, r, sigOf(r.plate))).filter(r => r.text.length >= 2);
    }
    add(f) {
      this.frames++;
      if (!f || !f.found) { this.recent.push(null); return this.state(); }
      let s = this.by.get(f.sig);
      if (!s) this.by.set(f.sig, s = {sig: f.sig, truck: f.truck, n: 0, sum: f.chars.map(c => new Float32Array(c.q.length)), prov: new Float32Array(PROVINCES.length), provN: 0});
      s.n++;
      f.chars.forEach((c, i) => { for (let k = 0; k < c.q.length; k++) s.sum[i][k] += c.q[k]; });
      if (f.prov) { for (let k = 0; k < f.prov.length; k++) s.prov[k] += f.prov[k]; s.provN++; }
      this.recent.push(f.text); if (this.recent.length > 4) this.recent.shift();
      return this.state();
    }
    best() { let b = null; for (const s of this.by.values()) if (!b || s.n > b.n) b = s; return b; }
    state() {
      const s = this.best();
      if (!s) return {text: "", frames: this.frames};
      const types = s.sig.replace("T", "");
      const avg = s.sum.map(a => Array.from(a, v => v / s.n));
      const idx = avg.map(argmax), conf = avg.map((a, i) => a[idx[i]]);
      const text = idx.map((k, i) => symOf(types[i], k)).join("");
      let prov = "", provConf = 0;
      if (s.provN) { const pa = Array.from(s.prov, v => v / s.provN), k = argmax(pa); prov = PROVINCES[k]; provConf = pa[k]; }
      const out = {text, display: display(text, s.truck), conf, minConf: Math.min(...conf), n: s.n, frames: this.frames, prov, provConf, truck: s.truck, sig: s.sig};
      // registered vehicles: likelihood of each candidate under the fused per-character probabilities
      const freeScore = conf.reduce((a, c) => a + Math.log(c + 1e-4), 0);
      let r1 = null, r2 = null;
      for (const r of this.reg) {
        if (r.sig !== s.sig) continue;
        let sc = 0, worst = 1;
        for (let i = 0; i < types.length; i++) {
          const k = (types[i] === "D" ? DIGITS : CONS).indexOf(r.text[i]); const p = k < 0 ? 0 : avg[i][k];
          sc += Math.log(p + 1e-4); if (p < worst) worst = p;
        }
        if (prov && provConf > 0.8 && r.prov && OCR.normProv(r.prov) !== OCR.normProv(prov)) sc -= 2.5;
        const c = {r, sc, worst};
        if (!r1 || sc > r1.sc) { r2 = r1; r1 = c; } else if (!r2 || sc > r2.sc) r2 = c;
      }
      out.reg = null;
      if (r1 && r1.sc >= freeScore - 0.9 && r1.worst >= 0.04 && (!r2 || r1.sc - r2.sc >= 2.0)) {
        out.reg = r1.r; out.regLock = true;
      }
      // free reading: consistent over frames and confident on every character
      const lastTwo = this.recent.slice(-2);
      const stable2 = lastTwo.length === 2 && lastTwo.every(t => t === text);
      const seen = this.recent.filter(t => t === text).length;
      let found = 0; for (const v of this.by.values()) found += v.n;
      const dominant = s.n >= 0.7 * found;
      out.freeLock = dominant && ((s.n >= 2 && stable2 && out.minConf >= 0.8) || (s.n >= 3 && seen >= 2 && out.minConf >= 0.6));
      out.unsure = conf.map((c, i) => c < 0.7 ? i : -1).filter(i => i >= 0);
      // look-alike twins differ by one small stroke: flag them for a human check unless clearly decided
      const TWIN = {"ฎ": "ฏ", "ฏ": "ฎ", "ช": "ซ", "ซ": "ช"};
      out.alts = {};
      idx.forEach((k, i) => {
        const ch = symOf(types[i], k), tw = TWIN[ch]; if (!tw) return;
        const pk = CONS.indexOf(tw), pp = avg[i][pk];
        if (pp >= 0.02 || conf[i] < 0.97) { if (!out.unsure.includes(i)) out.unsure.push(i); out.alts[i] = tw; }
      });
      conf.forEach((c, i) => { if (c < 0.7 && !(i in out.alts)) { const a = avg[i].map((v, k) => [v, k]).sort((p, q) => q[0] - p[0])[1]; out.alts[i] = symOf(types[i], a[1]); } });
      return out;
    }
  }

  /* ---------------- Thai ID number (13 digits) ---------------- */
  function readIdFrame(canvas) {
    if (!ready()) return null;
    const t0 = performance.now(), g = grayOf(canvas, "lum"), W = g.w, H = g.h;
    const b = binarize(g, Math.max(15, Math.round(W / 14) | 1), 0.2);
    const cs = components(b, W, H, Math.max(5, (W * H) / 60000)).filter(c => c.cy < 0.55 * H);
    const cand = cs.filter(c => c.h >= 0.025 * H && c.h <= 0.14 * H && c.w >= 0.15 * c.h && c.w <= 3.4 * c.h && c.area / (c.w * c.h) >= 0.12);
    // cut blobs of touching digits (blur) into single digits at the thinnest columns
    const splitN = (c, n) => {
      const cuts = [c.x0 - 1];
      for (let k = 1; k < n; k++) {
        const ex = c.x0 + (k * c.w) / n, r = Math.max(2, Math.round(0.22 * c.w / n));
        let bx = Math.round(ex), bv = Infinity;
        for (let x = Math.round(ex - r); x <= Math.round(ex + r); x++) { let v = 0; for (let y = c.y0; y <= c.y1; y++) v += b[y * W + x]; if (v < bv) { bv = v; bx = x; } }
        cuts.push(bx);
      }
      cuts.push(c.x1 + 1);
      const out = [];
      for (let k = 0; k < n; k++) {
        let y0 = c.y1, y1 = c.y0, X0 = cuts[k + 1], X1 = cuts[k], a = 0;
        for (let y = c.y0; y <= c.y1; y++) for (let x = cuts[k] + 1; x < cuts[k + 1]; x++) if (b[y * W + x]) { a++; if (y < y0) y0 = y; if (y > y1) y1 = y; if (x < X0) X0 = x; if (x > X1) X1 = x; }
        if (!a) return [c];
        const p = {x0: X0, x1: X1, y0, y1, area: a}; p.w = X1 - X0 + 1; p.h = y1 - y0 + 1; p.cx = (X0 + X1) / 2; p.cy = (y0 + y1) / 2; out.push(p);
      }
      return out;
    };
    let best = null;
    for (const s of cand) {
      if (s.w > 0.95 * s.h) continue;   // seed on a single digit
      let mem = cand.filter(c => Math.abs(c.h - s.h) <= 0.2 * s.h && Math.abs(c.cy - s.cy) <= 0.3 * s.h).sort((a, b) => a.x0 - b.x0);
      const singles = mem.filter(c => c.w <= 0.85 * c.h), dw = singles.length ? median(singles.map(c => c.w)) : 0.6 * s.h;
      mem = mem.flatMap(c => { const n = Math.round(c.w / (dw * 1.08)); return n >= 2 && n <= 5 ? splitN(c, n) : [c]; });
      if (mem.length < 13) continue;
      for (let st = 0; st + 13 <= mem.length; st++) {
        const win = mem.slice(st, st + 13), gaps = [];
        for (let i = 1; i < 13; i++) gaps.push(win[i].x0 - win[i - 1].x1);
        const grp = [0, 4, 9, 11], inner = gaps.filter((_, i) => !grp.includes(i)), mxIn = Math.max(...inner);
        const mnG = Math.min(...grp.map(i => gaps[i]));
        if (mxIn > 1.2 * s.h || win[12].x1 - win[0].x0 > 14 * s.h) continue;
        const sc = (mnG - mxIn) / s.h;
        if (sc > 0.08 && (!best || sc > best.sc)) best = {sc, win, h: s.h};
      }
    }
    if (!best) return {found: false, ms: performance.now() - t0};
    const probs = best.win.map(c => { const p = predict(charModel, normChar(g, c)); let s = 0; for (let k = 0; k < NDIG; k++) s += p[k]; return Float32Array.from(p.slice(0, NDIG), v => v / (s || 1)); });
    const row = {x0: best.win[0].x0, x1: best.win[12].x1, y0: Math.min(...best.win.map(c => c.y0)), y1: Math.max(...best.win.map(c => c.y1)), h: best.h};
    return {found: true, probs, digits: probs.map(argmax).join(""), row, g, bin: b, ms: performance.now() - t0};
  }
  class IdFusion {
    constructor() { this.n = 0; this.sum = Array.from({length: 13}, () => new Float32Array(10)); this.recent = []; }
    add(f) {
      if (f && f.probs) { this.n++; f.probs.forEach((p, i) => { for (let k = 0; k < 10; k++) this.sum[i][k] += p[k]; }); this.recent.push(f.digits); }
      else if (f && f.text && /^\d{13}$/.test(f.text)) { this.n++; [...f.text].forEach((ch, i) => { for (let k = 0; k < 10; k++) this.sum[i][k] += k === +ch ? 0.85 : 0.015; }); this.recent.push(f.text); }
      if (this.recent.length > 4) this.recent.shift();
      return this.state();
    }
    state() {
      if (!this.n) return {n: 0};
      const avg = this.sum.map(a => Array.from(a, v => v / this.n));
      const top = avg.map(argmax), conf = avg.map((a, i) => a[top[i]]);
      let id = top.join(""), cost = 0, fixed = [];
      if (!OCR.thaiIdValid(id)) {
        // repair with the checksum: cheapest one or two digit changes, using what the frames saw
        const alts = [];
        for (let i = 0; i < 13; i++) for (let k = 0; k < 10; k++) if (k !== top[i]) alts.push({i, k, c: Math.log(avg[i][top[i]] + 1e-4) - Math.log(avg[i][k] + 1e-4)});
        alts.sort((a, b) => a.c - b.c);
        let bestFix = null;
        for (const a of alts) { const t = top.slice(); t[a.i] = a.k; if (OCR.thaiIdValid(t.join(""))) { bestFix = {c: a.c, ch: [a]}; break; } }
        const few = alts.slice(0, 40);
        for (let x = 0; x < few.length; x++) for (let y = x + 1; y < few.length; y++) {
          const a = few[x], b = few[y]; if (a.i === b.i || (bestFix && a.c + b.c >= bestFix.c)) continue;
          const t = top.slice(); t[a.i] = a.k; t[b.i] = b.k;
          if (OCR.thaiIdValid(t.join(""))) bestFix = {c: a.c + b.c, ch: [a, b]};
        }
        if (bestFix) { const t = top.slice(); bestFix.ch.forEach(a => { t[a.i] = a.k; fixed.push(a.i); }); id = t.join(""); cost = bestFix.c; } else id = null;
      }
      const minConf = Math.min(...conf.filter((_, i) => !fixed.includes(i)));
      const seen = id ? this.recent.filter(r => r === id).length : 0;
      const lock = !!id && ((this.n >= 2 && cost === 0 && minConf >= 0.7) || (this.n >= 3 && cost < 2.5 && seen >= 1) || (this.n === 1 && cost === 0 && minConf >= 0.97) || (this.n >= 5 && cost < 4));
      return {n: this.n, id, cost, fixed, minConf, lock, partial: top.join("")};
    }
  }
  // Text rows of the card below the ID number (Thai name, English first name, English last name).
  // Each row is cropped after the printed label so only the value is read.
  function idNameBands(f) {
    const {g, bin, row} = f, W = g.w, H = g.h, x0 = Math.round(W * 0.02), x1 = Math.min(W - 1, Math.round(row.x1 + 0.02 * W));
    const y0 = Math.round(row.y1 + row.h * 0.4), raw = new Float32Array(H), prof = new Float32Array(H);
    for (let y = y0; y < H; y++) { let s = 0; for (let x = x0; x <= x1; x++) s += bin[y * W + x]; raw[y] = s / (x1 - x0 + 1); }
    const r = Math.max(1, Math.round(row.h * 0.08));
    for (let y = y0; y < H; y++) { let s = 0, n = 0; for (let k = -r; k <= r; k++) if (y + k >= y0 && y + k < H) { s += raw[y + k]; n++; } prof[y] = s / n; }
    const vals = Array.from(prof.slice(y0)).sort((p, q) => p - q), thr = Math.max(0.01, 0.3 * vals[Math.floor(vals.length * 0.9)] + 0.7 * vals[Math.floor(vals.length * 0.3)]);
    const bands = []; let on = false, s0 = 0;
    for (let y = y0; y <= H; y++) {
      const v = y < H ? prof[y] : 0;
      if (v > thr) { if (!on) { on = true; s0 = y; } }
      else if (on) { on = false; if (y - s0 > row.h * 0.45 && y - s0 < row.h * 2.6) bands.push({y0: s0, y1: y - 1}); if (bands.length >= 3) break; }
    }
    const comps = components(bin, W, H, 4);
    return bands.map(bd => {
      // label | big gap | value: start after the widest gap in the left 60% of the row
      const cs = comps.filter(c => c.cy >= bd.y0 && c.cy <= bd.y1 && c.x0 >= x0 && c.x1 <= x1 && c.h > 0.2 * (bd.y1 - bd.y0)).sort((p, q) => p.x0 - q.x0);
      let cut = x0, gmax = 0, reach = x0;
      for (const c of cs) { if (c.x0 - reach > gmax && c.x0 < x0 + 0.6 * (x1 - x0)) { gmax = c.x0 - reach; cut = c.x0; } reach = Math.max(reach, c.x1); }
      const vx0 = gmax > 1.2 * (bd.y1 - bd.y0) ? Math.max(x0, cut - Math.round(0.3 * (bd.y1 - bd.y0))) : x0;
      const pad = Math.round((bd.y1 - bd.y0) * 0.35), Y0 = Math.max(0, bd.y0 - pad), Y1 = Math.min(H - 1, bd.y1 + pad);
      const src = document.createElement("canvas"); src.width = x1 - vx0 + 1; src.height = Y1 - Y0 + 1;
      const im = src.getContext("2d").createImageData(src.width, src.height);
      for (let y = 0; y < src.height; y++) for (let x = 0; x < src.width; x++) { const v = g.d[(y + Y0) * W + x + vx0], j = (y * src.width + x) * 4; im.data[j] = im.data[j + 1] = im.data[j + 2] = v; im.data[j + 3] = 255; }
      src.getContext("2d").putImageData(im, 0, 0);
      const sc = Math.min(3, 56 / src.height), c = document.createElement("canvas"); c.width = Math.round(src.width * sc); c.height = Math.round(src.height * sc);
      const cx = c.getContext("2d"); cx.imageSmoothingQuality = "high"; cx.drawImage(src, 0, 0, c.width, c.height);
      return c;
    });
  }
  // Thai name from OCR text: tolerant title match (นาย นาง นางสาว ด.ช. ด.ญ.) + first + last name
  const TITLES = ["นางสาว", "นาง", "นาย", "ด.ช.", "ด.ญ.", "เด็กชาย", "เด็กหญิง"];
  function parseThName(text) {
    let t = String(text || "").replace(/\u0E4D\u0E32/g, "\u0E33").replace(/[^ก-๛.\s]/g, " ").replace(/\s+/g, " ").trim();
    t = t.replace(/^.*?(ชื่อ\S*\s*สกุล|สกุล)\s*/, "");
    const tok = t.split(" ").filter(x => x.replace(/[่-๋็์]/g, "").length >= 2 || /^ด\.[ชญ]\.$/.test(x));
    if (tok.length < 2) return null;
    let best = null;
    for (let n = 0; n < Math.min(2, tok.length - 1); n++) {          // title may sit in its own token or be glued to the first name
      const head = tok[n];
      for (const ti of TITLES) {
        const d = lev(head.slice(0, ti.length), ti) / ti.length;
        if (d <= 0.34 && (!best || d < best.d)) best = {d, ti, n, glued: head.length > ti.length + 1 ? head.slice(ti.length) : ""};
      }
    }
    if (!best) return tok.length >= 2 ? tok.slice(-2).join(" ") : null;
    const rest = (best.glued ? [best.glued] : []).concat(tok.slice(best.n + 1));
    if (!rest.length) return null;
    return best.ti + rest[0] + (rest.length > 1 ? " " + rest.slice(1).join("") : "");
  }
  function parseEnName(first, last) {
    const a = String(first || ""), b = String(last || "");
    const m1 = a.match(/\b(M[rR][sS]?|Miss|Ms|MISS|MS|MR|MRS)\.?\s*([A-Z][A-Za-z\-]{1,30})/);
    const words = b.replace(/Last\s*name/i, " ").match(/[A-Z][A-Za-z\-]{1,30}/g) || [];
    if (!m1) return null;
    const ti = /^miss/i.test(m1[1]) ? "Miss" : /^mrs/i.test(m1[1]) ? "Mrs." : /^ms/i.test(m1[1]) ? "Ms." : "Mr.";
    return (ti + " " + m1[2] + (words.length ? " " + words.sort((p, q) => q.length - p.length)[0] : "")).trim();
  }
  const lev = OCR.lev;

  return {load, ready, readPlateFrame, PlateFusion, readIdFrame, IdFusion, idNameBands, parseThName, parseEnName, display, sigOf, CLASSES, PROVINCES,
    _t: {normChar, normLine, predict, binarize, components, findRow, decode, mergeStacked, provinceBox, grayOf, resizeF, axisWeights, get charModel() { return charModel; }, get lineModel() { return lineModel; }}};
})();
