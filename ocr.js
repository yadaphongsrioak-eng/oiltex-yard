/* OIL-TEX Yard — on-device reading engine (no server, no Claude).
   Tesseract runs in a Web Worker from the bundled vendor/ folder, so it works offline. */
"use strict";
var OCR_DEBUG = null;
const OCR = (() => {
  const PROVINCES = ["กรุงเทพมหานคร","กระบี่","กาญจนบุรี","กาฬสินธุ์","กำแพงเพชร","ขอนแก่น","จันทบุรี","ฉะเชิงเทรา","ชลบุรี","ชัยนาท","ชัยภูมิ","ชุมพร","เชียงราย","เชียงใหม่","ตรัง","ตราด","ตาก","นครนายก","นครปฐม","นครพนม","นครราชสีมา","นครศรีธรรมราช","นครสวรรค์","นนทบุรี","นราธิวาส","น่าน","บึงกาฬ","บุรีรัมย์","ปทุมธานี","ประจวบคีรีขันธ์","ปราจีนบุรี","ปัตตานี","พระนครศรีอยุธยา","พะเยา","พังงา","พัทลุง","พิจิตร","พิษณุโลก","เพชรบุรี","เพชรบูรณ์","แพร่","ภูเก็ต","มหาสารคาม","มุกดาหาร","แม่ฮ่องสอน","ยโสธร","ยะลา","ร้อยเอ็ด","ระนอง","ระยอง","ราชบุรี","ลพบุรี","ลำปาง","ลำพูน","เลย","ศรีสะเกษ","สกลนคร","สงขลา","สตูล","สมุทรปราการ","สมุทรสงคราม","สมุทรสาคร","สระแก้ว","สระบุรี","สิงห์บุรี","สุโขทัย","สุพรรณบุรี","สุราษฎร์ธานี","สุรินทร์","หนองคาย","หนองบัวลำภู","อ่างทอง","อำนาจเจริญ","อุดรธานี","อุตรดิตถ์","อุทัยธานี","อุบลราชธานี","เบตง"];
  const TH_CONS = "กขฃคฅฆงจฉชซฌญฎฏฐฑฒณดตถทธนบปผฝพฟภมยรลวศษสหฬอฮ";

  /* ---------- text helpers ---------- */
  const normPlate = s => String(s || "").replace(/[\s\-–—.·]/g, "");
  function parsePlate(s) {
    const n = normPlate(s);
    let m = n.match(/^(\d?[ก-ฮ]{1,2})(\d{1,4})$/);
    if (m) return {ok: true, kind: "std", display: m[1] + " " + m[2]};
    m = n.match(/^(\d{2})(\d{4})$/);
    if (m) return {ok: true, kind: "truck", display: m[1] + "-" + m[2]};
    return {ok: false, display: String(s || "").trim()};
  }
  const normProv = s => String(s || "").replace(/^จ\.?\s*|^จังหวัด\s*/, "").replace(/\s+/g, "").trim();
  const CONF = [["ข","ช","ฃ","ซ"],["ค","ด","ต","ฅ","ศ"],["บ","ป","ษ"],["ผ","ฝ","พ","ฟ"],["ถ","ภ","ฎ","ฏ"],["ม","ฆ"],["ล","ส"],["ร","ธ"],["ท","ห","ฑ","ฒ"],["อ","ฮ"],["น","ห"],["0","8"],["3","8"],["1","7"],["5","6"]];
  const confMap = new Map(); CONF.forEach((g, i) => g.forEach(c => { if (!confMap.has(c)) confMap.set(c, new Set()); confMap.get(c).add(i); }));
  const subCost = (a, b) => { if (a === b) return 0; const x = confMap.get(a), y = confMap.get(b); if (x && y) for (const i of x) if (y.has(i)) return 0.4; return 1; };
  function lev(a, b) {
    a = Array.from(a); b = Array.from(b);
    let prev = Array.from({length: b.length + 1}, (_, j) => j);
    for (let i = 1; i <= a.length; i++) {
      const cur = [i];
      for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + subCost(a[i - 1], b[j - 1]));
      prev = cur;
    }
    return prev[b.length];
  }
  // province from noisy OCR text: compare on consonants+vowels with marks stripped
  const skel = s => String(s || "").replace(/\u0E4D\u0E32/g, "\u0E33").replace(/[^\u0E01-\u0E2E\u0E30\u0E32\u0E33\u0E40-\u0E44]/g, "");
  const PROV_SKEL = PROVINCES.map(p => skel(p));
  function snapProvince(p) {
    const n = normProv(p); if (!n) return {value: "", ok: false};
    const exact = PROVINCES.find(x => x === n);
    if (exact) return {value: exact, ok: true};
    if (/^(กทม|กรุงเทพ)/.test(n)) return {value: "กรุงเทพมหานคร", ok: true, fixed: true};
    const best = matchProvince(n);
    return best && best.score <= 0.34 ? {value: best.value, ok: true, fixed: true} : {value: String(p).trim(), ok: false};
  }
  function matchProvince(text) {
    const s = skel(text);
    if (s.length < 2) return null;
    let best = null;
    PROVINCES.forEach((p, i) => {
      const ps = PROV_SKEL[i];
      // allow the OCR string to contain extra junk around the name
      let d = lev(s, ps);
      if (s.length > ps.length + 1) for (let k = 0; k + ps.length <= s.length; k++) d = Math.min(d, lev(s.slice(k, k + ps.length), ps) + 0.3);
      const score = d / Math.max(ps.length, 2);
      if (!best || score < best.score) best = {value: p, score};
    });
    return best;
  }
  function thaiIdValid(s) {
    if (!/^\d{13}$/.test(s)) return false;
    let sum = 0; for (let i = 0; i < 12; i++) sum += +s[i] * (13 - i);
    return (11 - sum % 11) % 10 === +s[12];
  }
  const mrzVal = c => c === "<" ? 0 : /\d/.test(c) ? +c : (c >= "A" && c <= "Z") ? c.charCodeAt(0) - 55 : -1;
  function mrzCheck(str) { const w = [7, 3, 1]; let s = 0; for (let i = 0; i < str.length; i++) { const v = mrzVal(str[i]); if (v < 0) return -1; s += v * w[i % 3]; } return s % 10; }

  /* ---------- image preprocessing ---------- */
  function crop(src, sx, sy, sw, sh, targetW) {
    const s = targetW / sw;
    const c = document.createElement("canvas"); c.width = Math.round(targetW); c.height = Math.max(8, Math.round(sh * s));
    const g = c.getContext("2d", {willReadFrequently: true});
    g.imageSmoothingEnabled = true; g.imageSmoothingQuality = "high";
    g.drawImage(src, sx, sy, sw, sh, 0, 0, c.width, c.height);
    return c;
  }
  // grayscale + percentile contrast stretch; optional Otsu binarize with dark text on white
  function enhance(c, binarize) {
    const g = c.getContext("2d", {willReadFrequently: true});
    const im = g.getImageData(0, 0, c.width, c.height), d = im.data, n = d.length / 4;
    const gray = new Uint8ClampedArray(n), hist = new Uint32Array(256);
    for (let i = 0; i < n; i++) { const v = (d[i * 4] * 299 + d[i * 4 + 1] * 587 + d[i * 4 + 2] * 114) / 1000 | 0; gray[i] = v; hist[v]++; }
    let lo = 0, hi = 255, acc = 0;
    for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc > n * 0.02) { lo = v; break; } }
    acc = 0; for (let v = 255; v >= 0; v--) { acc += hist[v]; if (acc > n * 0.02) { hi = v; break; } }
    const span = Math.max(24, hi - lo);
    const h2 = new Uint32Array(256);
    for (let i = 0; i < n; i++) { const v = Math.max(0, Math.min(255, (gray[i] - lo) * 255 / span)) | 0; gray[i] = v; h2[v]++; }
    let thr = 128;
    if (binarize) {
      let sum = 0; for (let v = 0; v < 256; v++) sum += v * h2[v];
      let sB = 0, wB = 0, best = -1;
      for (let v = 0; v < 256; v++) { wB += h2[v]; if (!wB) continue; const wF = n - wB; if (!wF) break; sB += v * h2[v]; const mB = sB / wB, mF = (sum - sB) / wF, between = wB * wF * (mB - mF) * (mB - mF); if (between > best) { best = between; thr = v; } }
      let dark = 0; for (let i = 0; i < n; i++) if (gray[i] <= thr) dark++;
      const invert = binarize === true && dark > n * 0.5; // light text on dark plate
      for (let i = 0; i < n; i++) { let b = gray[i] > thr ? 255 : 0; if (invert) b = 255 - b; gray[i] = b; }
    }
    for (let i = 0; i < n; i++) { d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = gray[i]; d[i * 4 + 3] = 255; }
    g.putImageData(im, 0, 0);
    return c;
  }

  /* ---------- workers ---------- */
  const workers = {};
  let base = "vendor/";
  function setBase(b) { base = b; }
  function worker(lang) {
    if (!workers[lang]) workers[lang] = Tesseract.createWorker(lang, 1, {
      workerPath: base + "worker.min.js", corePath: base + "core", langPath: base + "lang",
      workerBlobURL: false, gzip: true
    }).catch(e => { delete workers[lang]; throw e; });
    return workers[lang];
  }
  async function rec(lang, canvas, params) {
    const w = await worker(lang);
    await w.setParameters(Object.assign({preserve_interword_spaces: "1", tessedit_char_whitelist: ""}, params));
    const r = await w.recognize(canvas);
    return {text: r.data.text || "", conf: r.data.confidence || 0};
  }

  /* ---------- readers: each takes a frame region and returns a candidate ---------- */
  // Find text rows on a binarized plate: kill the frame border, then use the horizontal ink profile.
  function rowBands(bin) {
    const w = bin.width, h = bin.height, g = bin.getContext("2d", {willReadFrequently: true});
    const im = g.getImageData(0, 0, w, h), d = im.data;
    const dark = (x, y) => d[(y * w + x) * 4] < 128;
    const rowInk = new Float32Array(h), colInk = new Float32Array(w);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (dark(x, y)) { rowInk[y]++; colInk[x]++; }
    // border lines: rows/cols that are mostly ink, and a thin outer margin
    const mx = Math.round(w * 0.03), my = Math.round(h * 0.04);
    for (let y = 0; y < h; y++) if (rowInk[y] > w * 0.8 || y < my || y >= h - my) for (let x = 0; x < w; x++) d[(y * w + x) * 4] = d[(y * w + x) * 4 + 1] = d[(y * w + x) * 4 + 2] = 255;
    for (let x = 0; x < w; x++) if (colInk[x] > h * 0.75 || x < mx || x >= w - mx) for (let y = 0; y < h; y++) d[(y * w + x) * 4] = d[(y * w + x) * 4 + 1] = d[(y * w + x) * 4 + 2] = 255;
    g.putImageData(im, 0, 0);
    const prof = new Float32Array(h);
    for (let y = 0; y < h; y++) { let c = 0; for (let x = 0; x < w; x++) if (dark(x, y)) c++; prof[y] = c / w; }
    const bands = []; let inB = false, s0 = 0, gap = 0;
    for (let y = 0; y < h; y++) {
      const on = prof[y] > 0.015;
      if (on) { if (!inB) { inB = true; s0 = y; } gap = 0; }
      else if (inB && ++gap > h * 0.025) { inB = false; bands.push([s0, y - gap]); }
    }
    if (inB) bands.push([s0, h - 1]);
    return bands.map(([a, b]) => {
      let x0 = w, x1 = 0;
      for (let y = a; y <= b; y++) for (let x = 0; x < w; x++) if (dark(x, y)) { if (x < x0) x0 = x; if (x > x1) x1 = x; }
      return {y0: a, y1: b, x0, x1, h: b - a + 1};
    }).filter(b => b.h > h * 0.07 && b.x1 - b.x0 > w * 0.12);
  }
  // cut a band out of an image, scale text to ~56px tall, pad with white
  function band(src, b, pad) {
    const H = 56, s = H / b.h;
    const bw = (b.x1 - b.x0 + 1) + pad * 2, bh = b.h + pad * 2;
    const c = document.createElement("canvas"); c.width = Math.round(bw * s) + 32; c.height = Math.round(bh * s) + 32;
    const g = c.getContext("2d"); g.fillStyle = "#fff"; g.fillRect(0, 0, c.width, c.height);
    g.imageSmoothingQuality = "high";
    g.drawImage(src, b.x0 - pad, b.y0 - pad, bw, bh, 16, 16, bw * s, bh * s);
    return c;
  }
  function sub(src, r) { const c = document.createElement("canvas"); c.width = r.w; c.height = r.h; c.getContext("2d", {willReadFrequently: true}).drawImage(src, r.x, r.y, r.w, r.h, 0, 0, r.w, r.h); return c; }
  // the plate is the largest bright rectangle inside the guide box
  function locateLight(bin) {
    const w = bin.width, h = bin.height, d = bin.getContext("2d", {willReadFrequently: true}).getImageData(0, 0, w, h).data;
    const light = (x, y) => d[(y * w + x) * 4] > 128;
    const longestRun = (arr, thr) => { let best = [0, arr.length - 1], bl = 0, s0 = -1; for (let i = 0; i <= arr.length; i++) { if (i < arr.length && arr[i] > thr) { if (s0 < 0) s0 = i; } else if (s0 >= 0) { if (i - s0 > bl) { bl = i - s0; best = [s0, i - 1]; } s0 = -1; } } return bl ? best : null; };
    const cx0 = Math.round(w * 0.2), cx1 = Math.round(w * 0.8);
    const rows = new Float32Array(h);
    for (let y = 0; y < h; y++) { let c = 0; for (let x = cx0; x < cx1; x++) if (light(x, y)) c++; rows[y] = c / (cx1 - cx0); }
    const yr = longestRun(rows, 0.22);
    if (!yr || yr[1] - yr[0] < h * 0.3) return {x: 0, y: 0, w, h};
    const cols = new Float32Array(w);
    for (let x = 0; x < w; x++) { let c = 0; for (let y = yr[0]; y <= yr[1]; y++) if (light(x, y)) c++; cols[x] = c / (yr[1] - yr[0] + 1); }
    const xr = longestRun(cols, 0.3);
    if (!xr || xr[1] - xr[0] < w * 0.3) return {x: 0, y: 0, w, h};
    return {x: xr[0], y: yr[0], w: xr[1] - xr[0] + 1, h: yr[1] - yr[0] + 1};
  }
  function rotate(src, deg) {
    if (!deg) return src;
    const c = document.createElement("canvas"); c.width = src.width; c.height = src.height;
    const g = c.getContext("2d", {willReadFrequently: true}); g.fillStyle = "#fff"; g.fillRect(0, 0, c.width, c.height);
    g.translate(c.width / 2, c.height / 2); g.rotate(deg * Math.PI / 180); g.drawImage(src, -src.width / 2, -src.height / 2);
    return c;
  }
  // skew angle that makes text rows sharpest (max variance of the row ink profile)
  function skewAngle(bin) {
    const sw = 240, s = sw / bin.width, sh = Math.max(20, Math.round(bin.height * s));
    let best = 0, bv = -1;
    for (let a = -7; a <= 7; a += 1) {
      const c = document.createElement("canvas"); c.width = sw; c.height = sh;
      const g = c.getContext("2d", {willReadFrequently: true}); g.fillStyle = "#fff"; g.fillRect(0, 0, sw, sh);
      g.translate(sw / 2, sh / 2); g.rotate(a * Math.PI / 180); g.drawImage(bin, -sw / 2, -sh / 2, sw, sh);
      const d = g.getImageData(0, 0, sw, sh).data; let mean = 0; const prof = new Float32Array(sh);
      for (let y = 0; y < sh; y++) { let k = 0; for (let x = 0; x < sw; x++) if (d[(y * sw + x) * 4] < 128) k++; prof[y] = k; mean += k; }
      mean /= sh; let v = 0; for (let y = 0; y < sh; y++) v += (prof[y] - mean) ** 2;
      if (v > bv) { bv = v; best = a; }
    }
    return best;
  }
  // Plate: crop to the plate, locate the registration row (tallest) and the province row under it, read each as one line.
  async function readPlate(src, box, pass) {
    const W = 640;
    const g0 = enhance(crop(src, box.x, box.y, box.w, box.h, W), false);
    const b0 = enhance(sub(g0, {x: 0, y: 0, w: g0.width, h: g0.height}), "raw");
    const r = locateLight(b0);
    let gray = enhance(sub(g0, r), false);
    let bin = enhance(sub(gray, {x: 0, y: 0, w: gray.width, h: gray.height}), "raw");
    const ang = skewAngle(bin);
    if (ang) { gray = rotate(gray, ang); bin = enhance(rotate(bin, ang), "raw"); }
    const bands = rowBands(bin);
    if (!bands.length) return {plate: null, prov: null, raw: "", provRaw: ""};
    const regIdx = bands.reduce((bi, b, i, a) => b.h > a[bi].h ? i : bi, 0);
    const reg = bands[regIdx], provB = bands[regIdx + 1];
    const srcImg = pass % 2 ? bin : gray, pad = Math.round(reg.h * 0.18);
    const regC = band(srcImg, reg, pad);
    const r1 = await rec("tha", regC, {tessedit_pageseg_mode: "7", tessedit_char_whitelist: TH_CONS + "0123456789 -"});
    const plate = extractPlate(r1.text);
    let prov = null, provRaw = "";
    if (plate && provB) {
      const r2 = await rec("tha", band(srcImg, provB, Math.round(provB.h * 0.2)), {tessedit_pageseg_mode: "7"});
      provRaw = r2.text.trim();
      const m = matchProvince(provRaw);
      if (m && m.score <= 0.45) prov = m.value;
    }
    return {plate, prov, raw: r1.text.trim(), provRaw, conf: r1.conf};
  }
  function extractPlate(text) {
    const t = String(text || "").replace(/[ะ-ฺเ-๎]/g, "").replace(/[|\[\]{}()]/g, "1").replace(/[Oo]/g, "0");
    const lines = t.split(/\n/);
    for (const line of lines) {
      const s = line.replace(/[^0-9ก-ฮ\-\s]/g, " ").replace(/\s+/g, " ").trim();
      let m = s.match(/(?:^|\s)(\d{2})\s*-\s*(\d{4})(?!\d)/);
      if (m) return m[1] + "-" + m[2];
      m = s.replace(/\s/g, "").match(/(\d?)([ก-ฮ]{1,2})(\d{1,4})/);
      if (m) {
        const lead = m[1], letters = m[2], num = m[3];
        return (lead + letters) + " " + num;
      }
    }
    return null;
  }

  // Thai ID card / driving licence: 13-digit number with checksum, English + Thai names
  async function readIdCard(src, box, pass) {
    const W = 1100;
    const c = enhance(crop(src, box.x, box.y, box.w, box.h, W), pass % 2 === 1);
    const r = await rec("eng", c, {tessedit_pageseg_mode: "11", tessedit_char_whitelist: "0123456789 "});
    const id = extractThaiId(r.text);
    let en = null, th = null;
    if (id && pass % 3 !== 2) {
      const re = await rec("eng", c, {tessedit_pageseg_mode: "6"});
      en = extractEnName(re.text);
    }
    if (id && pass % 3 === 2) {
      const rt = await rec("tha", c, {tessedit_pageseg_mode: "6"});
      th = extractThName(rt.text);
    }
    return {id, en, th, raw: r.text};
  }
  function extractThaiId(text) {
    const cands = [];
    const flat = String(text || "").replace(/\n/g, " ");
    // grouped form 1 2345 67890 12 3 (spacing tolerant)
    const re = /(\d)\s*(\d{4})\s*(\d{5})\s*(\d{2})\s*(\d)(?!\d)/g; let m;
    while ((m = re.exec(flat))) cands.push(m.slice(1).join(""));
    for (const line of String(text || "").split("\n")) { const d = line.replace(/\D/g, ""); if (d.length === 13) cands.push(d); }
    return cands.find(thaiIdValid) || null;
  }
  function extractEnName(text) {
    const t = String(text || "");
    const first = t.match(/Name\s*[:.]?\s*((?:Mr|Mrs|Miss|Ms)\.?)?\s*([A-Z][a-zA-Z\-]{1,30})/);
    const last = t.match(/Last\s*name\s*[:.]?\s*([A-Z][a-zA-Z\-]{1,30})/i);
    if (!first) return null;
    const title = first[1] ? (/^miss/i.test(first[1]) ? "Miss" : first[1].replace(/\.?$/, ".")) + " " : "";
    return (title + first[2] + (last ? " " + last[1] : "")).trim();
  }
  function extractThName(text) {
    const lines = String(text || "").split("\n");
    for (const l of lines) {
      const m = l.match(/(นางสาว|นาย|นาง|ด\.ช\.|ด\.ญ\.)\s*([ก-๛]{2,})\s+([ก-๛]{2,})/);
      if (m) return (m[1] + m[2] + " " + m[3]).replace(/\u0E4D\u0E32/g, "\u0E33");
    }
    return null;
  }

  // Passport: MRZ lines with check digits
  async function readPassport(src, box, pass) {
    const W = 1200;
    const y = box.y + box.h * 0.62, h = box.h * 0.38;
    const c = enhance(crop(src, box.x, y, box.w, h, W), pass % 2 === 1);
    const r = await rec("eng", c, {tessedit_pageseg_mode: "6", tessedit_char_whitelist: "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789<"});
    return Object.assign({raw: r.text}, extractMrz(r.text));
  }
  function extractMrz(text) {
    const lines = String(text || "").toUpperCase().split("\n").map(l => l.replace(/[^A-Z0-9<]/g, "")).filter(l => l.length >= 30);
    for (let i = 0; i < lines.length; i++) {
      const l2 = lines[i];
      if (l2.length < 28) continue;
      const pno = l2.slice(0, 9), dob = l2.slice(13, 19), exp = l2.slice(21, 27);
      if (mrzCheck(pno) !== +l2[9] || mrzCheck(dob) !== +l2[19] || mrzCheck(exp) !== +l2[27]) continue;
      const l1 = lines[i - 1] && lines[i - 1].startsWith("P") ? lines[i - 1] : "";
      let name = null, nat = l2.slice(10, 13).replace(/</g, "");
      if (l1) { const parts = l1.slice(5).split("<<"); name = ((parts[1] || "").replace(/<+/g, " ").trim() + " " + (parts[0] || "").replace(/<+/g, " ").trim()).trim(); }
      return {passport: pno.replace(/</g, ""), nat, name};
    }
    return {passport: null};
  }

  return {PROVINCES, parsePlate, normPlate, normProv, lev, snapProvince, matchProvince, thaiIdValid, mrzCheck,
    crop, enhance, worker, setBase, readPlate, readIdCard, readPassport, extractPlate, extractThaiId, extractEnName, extractThName, extractMrz};
})();
