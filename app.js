/* OIL-TEX Yard Access — runs entirely in the browser on this device. */
"use strict";
const TZ = "Asia/Bangkok";
const DEFAULT_PURPOSES = ["ขออนุญาตเข้าพื้นที่", "ส่งสินค้า", "รับสินค้า / รับน้ำมัน", "ติดต่องาน", "ซ่อมบำรุง / ผู้รับเหมา"];
const LONG_STAY_H = 12;
const {PROVINCES, parsePlate, normPlate, normProv, lev, snapProvince, thaiIdValid} = OCR;

/* ---------- helpers ---------- */
const $ = s => document.querySelector(s);
const $$ = s => Array.from(document.querySelectorAll(s));
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"}[c]));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const lsGet = (k, d) => { try { const v = localStorage.getItem(k); return v == null ? d : v; } catch { return d; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch {} };
const fmtT = new Intl.DateTimeFormat("th-TH", {timeZone: TZ, hour: "2-digit", minute: "2-digit", hour12: false});
const fmtD = new Intl.DateTimeFormat("th-TH", {timeZone: TZ, weekday: "short", day: "numeric", month: "short", year: "2-digit"});
const fmtDs = new Intl.DateTimeFormat("th-TH", {timeZone: TZ, day: "numeric", month: "short"});
const fmtKey = new Intl.DateTimeFormat("en-CA", {timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit"});
const tOf = iso => iso ? fmtT.format(new Date(iso)) : "";
const dayKey = (d = new Date()) => fmtKey.format(d);
function dur(fromIso, toIso) {
  const m = Math.max(0, Math.round(((toIso ? new Date(toIso) : new Date()) - new Date(fromIso)) / 60000)), h = Math.floor(m / 60);
  return h ? `${h} ชม. ${m % 60} นาที` : `${m} นาที`;
}
function h32(str, seed) { let h = seed >>> 0; for (const ch of str) { h ^= ch.codePointAt(0); h = Math.imul(h, 16777619); } return (h >>> 0).toString(36); }
const keyOf = s => "k" + h32(s, 2166136261) + h32(s, 0x9747b28c);
const newId = () => "v" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
// one-way fingerprint of a 13-digit ID: lets a returning visitor be recognised without storing the number
async function idHash(id) {
  try { const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("oiltex-yard:" + id)); return Array.from(new Uint8Array(b).slice(0, 12), x => x.toString(16).padStart(2, "0")).join(""); }
  catch { return ""; }
}
const normName = s => String(s || "").replace(/\s+/g, " ").trim().toLowerCase();
const plateKey = (plate, prov) => normPlate(plate) + "|" + normProv(prov);
const modeOf = arr => { const m = new Map(); let best = null, bc = 0; for (const x of arr) { const c = (m.get(x) || 0) + 1; m.set(x, c); if (c > bc) { bc = c; best = x; } } return best; };
function download(name, data, type) {
  const blob = data instanceof Blob ? data : new Blob([data], {type});
  const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
}

/* ---------- local database (IndexedDB) ---------- */
const DB = (() => {
  let dbp;
  const open = () => dbp || (dbp = new Promise((res, rej) => {
    const r = indexedDB.open("oiltex-yard", 2);
    r.onupgradeneeded = () => {
      const d = r.result, has = n => d.objectStoreNames.contains(n);
      if (!has("visits")) { const v = d.createObjectStore("visits", {keyPath: "id"}); v.createIndex("status", "status"); v.createIndex("day", "day"); }
      if (!has("vehicles")) d.createObjectStore("vehicles", {keyPath: "key"});
      if (!has("people")) d.createObjectStore("people", {keyPath: "key"});
      if (!has("meta")) d.createObjectStore("meta", {keyPath: "k"});
      if (!has("registry")) d.createObjectStore("registry", {keyPath: "key"});
    };
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  }));
  const req = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  const store = async (name, mode) => (await open()).transaction(name, mode).objectStore(name);
  async function write(name, fn) {
    const d = await open();
    return new Promise((res, rej) => { const t = d.transaction(name, "readwrite"); fn(t.objectStore(name)); t.oncomplete = () => res(); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error); });
  }
  return {
    all: async n => req((await store(n)).getAll()),
    byIndex: async (n, idx, q) => req((await store(n)).index(idx).getAll(q)),
    get: async (n, k) => req((await store(n)).get(k)),
    put: (n, v) => write(n, s => s.put(v)),
    clear: n => write(n, s => s.clear()),
    putMany: (n, vs) => write(n, s => vs.forEach(v => s.put(v))),
    delMany: (n, ks) => write(n, s => ks.forEach(k => s.delete(k)))
  };
})();

/* ---------- state ---------- */
const S = {idHash: "", inside: [], vehicles: [], people: [], registry: [], settings: {companies: [], purposes: DEFAULT_PURPOSES}, todayKey: dayKey(), todayCount: 0,
  purpose: DEFAULT_PURPOSES[0], pax: 1, src: {plate: "manual", person: "manual"}, warnAck: "", report: []};

let toastT;
function toast(msg) { const t = $("#toast"); t.textContent = msg; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => t.hidden = true, 3200); }
function banner(title, body) { const b = $("#banner"); if (!title) { b.hidden = true; return; } b.innerHTML = `<b>${esc(title)}</b>${esc(body || "")}`; b.hidden = false; }
function show(v) {
  $$(".view").forEach(s => s.hidden = s.id !== "v-" + v);
  $$(".tabs button").forEach(b => b.setAttribute("aria-selected", String(b.dataset.v === v)));
  if (v === "report") loadReport();
  if (v === "inside") renderInside();
  if (v === "more") { renderAppQr(); renderStoreInfo(); }
  window.scrollTo(0, 0);
}
$$(".tabs button").forEach(b => b.onclick = () => show(b.dataset.v));

function setConn() { const on = navigator.onLine, c = $("#conn"); c.className = "conn" + (on ? "" : " off"); c.setAttribute("aria-label", on ? "ออนไลน์" : "ออฟไลน์ ยังบันทึกได้"); c.title = c.getAttribute("aria-label"); }
addEventListener("online", () => { setConn(); flushSync(); }); addEventListener("offline", setConn); setConn();

async function tick() {
  const d = new Date();
  $("#clk").textContent = fmtT.format(d); $("#dte").textContent = fmtD.format(d);
  const k = dayKey(d);
  if (k !== S.todayKey) { S.todayKey = k; await countToday(); }
  if (!$("#v-inside").hidden) renderInside();
}
setInterval(tick, 15000);

$("#gateName").value = lsGet("oiltex.gate", "");
function renderGate() { $("#gateLbl").textContent = ($("#gateName").value.trim() || "จุด รปภ.") + " · บันทึกเข้า–ออก"; }
$("#gateName").addEventListener("input", () => { lsSet("oiltex.gate", $("#gateName").value.trim()); renderGate(); });
renderGate();

let wake = null;
async function keepAwake() { try { if (!wake && navigator.wakeLock) { wake = await navigator.wakeLock.request("screen"); wake.addEventListener("release", () => wake = null); } } catch {} }
document.addEventListener("click", keepAwake, {once: true});

$("#provList").innerHTML = PROVINCES.map(p => `<option value="${esc(p)}">`).join("");
function fillCompanyList() {
  const set = new Set(S.settings.companies);
  S.people.forEach(p => p.company && set.add(p.company)); S.vehicles.forEach(v => v.company && set.add(v.company)); S.registry.forEach(v => v.company && set.add(v.company));
  $("#coList").innerHTML = [...set].sort((a, b) => a.localeCompare(b, "th")).map(c => `<option value="${esc(c)}">`).join("");
}

/* ---------- form ---------- */
function renderPurposes() {
  const list = S.settings.purposes;
  if (!list.includes(S.purpose)) S.purpose = list[0];
  $("#purposeChips").innerHTML = list.map(p => `<button type="button" class="chip" aria-pressed="${p === S.purpose}">${esc(p)}</button>`).join("");
  $$("#purposeChips .chip").forEach((b, i) => b.onclick = () => { S.purpose = list[i]; renderPurposes(); });
}
$$("[data-step]").forEach(b => b.onclick = () => { S.pax = Math.min(60, Math.max(1, S.pax + +b.dataset.step)); $("#fPax").textContent = S.pax; });

function plateHTML(plate, prov, small) {
  if (!plate) return `<span class="plate blank${small ? " s" : ""}"><span class="n">— —</span><span class="p">จังหวัด</span></span>`;
  return `<span class="plate${small ? " s" : ""}"><span class="n">${esc(parsePlate(plate).display)}</span><span class="p">${esc(prov || "")}</span></span>`;
}
function renderPlatePreview() { $("#platePrev").innerHTML = plateHTML($("#fPlate").value.trim(), $("#fProv").value.trim()); }
function findInsideBy(plate, prov, name) {
  const pk = normPlate(plate), pv = normProv(prov), nm = normName(name);
  return S.inside.filter(v => (pk.length >= 3 && normPlate(v.plate) === pk && (!pv || !v.prov || normProv(v.prov) === pv)) || (nm.length >= 4 && normName(v.name) === nm));
}
const findInside = () => findInsideBy($("#fPlate").value, $("#fProv").value, $("#fName").value);

function renderSuggestions() {
  const raw = normPlate($("#fPlate").value);
  let html = "";
  S._plateCands = [];
  if (raw.length >= 3) {
    const seen = new Set();
    for (const v of [...S.inside.map(x => ({...x, _in: true})), ...S.vehicles]) {
      const k = plateKey(v.plate, v.prov); if (seen.has(k)) continue;
      const d = lev(raw, normPlate(v.plate));
      if (d > 0 && d <= 1.5) { seen.add(k); S._plateCands.push({v, d}); }
    }
    S._plateCands.sort((a, b) => a.d - b.d);
    if (S._plateCands.length) html = `<span class="lbl">ใกล้เคียงกับรถที่เคยบันทึก แตะเพื่อใช้</span>` + S._plateCands.slice(0, 4).map((c, i) =>
      `<button type="button" class="chip s" data-vs="${i}">${esc(parsePlate(c.v.plate).display)} ${esc(c.v.prov || "")}${c.v.company ? " · " + esc(c.v.company) : ""}${c.v._in ? " · อยู่ในพื้นที่" : ""}</button>`).join("");
  }
  $("#plateSug").innerHTML = html;
  $$("#plateSug [data-vs]").forEach(b => b.onclick = () => applyVehicle(S._plateCands[+b.dataset.vs].v));
  const nm = normName($("#fName").value);
  let nh = ""; S._nameCands = [];
  if (nm.length >= 3) {
    S._nameCands = S.people.filter(p => { const pn = normName(p.name); return pn !== nm && (pn.includes(nm) || lev(nm, pn) <= 2); }).slice(0, 4);
    if (S._nameCands.length) nh = `<span class="lbl">เคยมาแล้ว แตะเพื่อเติมข้อมูล</span>` + S._nameCands.map((p, i) => `<button type="button" class="chip s" data-ps="${i}">${esc(p.name)}${p.company ? " · " + esc(p.company) : ""}</button>`).join("");
  }
  $("#nameSug").innerHTML = nh;
  $$("#nameSug [data-ps]").forEach(b => b.onclick = () => applyPerson(S._nameCands[+b.dataset.ps]));
  renderInsideHit();
}
function flash(el) { el.classList.remove("flash"); void el.offsetWidth; el.classList.add("flash"); }
function setField(id, val) { const el = $(id); if (val == null || val === "" || el.value === val) return; el.value = val; flash(el); }
function applyVehicle(v) {
  setField("#fPlate", parsePlate(v.plate).display); setField("#fProv", v.prov || "");
  if (!$("#fCo").value && v.company) setField("#fCo", v.company);
  if (!$("#fName").value && v.driver) setField("#fName", v.driver);
  if (S.src.plate === "manual") S.src.plate = "known";
  renderPlatePreview(); renderSuggestions();
}
function applyPerson(p) {
  setField("#fName", p.name); if (p.company) setField("#fCo", p.company);
  if (p.doc) $("#fDoc").value = p.doc; if (p.idLast4) setField("#fIdl", p.idLast4);
  renderSuggestions();
}
let sugT;
["#fPlate", "#fProv", "#fName"].forEach(id => $(id).addEventListener("input", () => {
  if (id !== "#fName") { S.src.plate = "manual"; $(id).classList.remove("warnf"); renderPlatePreview(); } else S.src.person = "manual";
  clearTimeout(sugT); sugT = setTimeout(renderSuggestions, 200);
}));
$("#fProv").addEventListener("change", () => { const s = snapProvince($("#fProv").value); if (s.ok && s.value !== $("#fProv").value) $("#fProv").value = s.value; renderPlatePreview(); renderSuggestions(); });
$("#fIdl").addEventListener("input", e => e.target.value = e.target.value.replace(/\D/g, "").slice(0, 4));

function renderInsideHit() {
  const hits = findInside(), box = $("#insideHit");
  if (!hits.length) { box.hidden = true; box.innerHTML = ""; return; }
  box.innerHTML = hits.slice(0, 2).map(v => `
    <div class="h">อยู่ในพื้นที่ตั้งแต่ ${tOf(v.inAt)} น. (${dur(v.inAt)})</div>
    <div>${v.plate ? plateHTML(v.plate, v.prov, true) : ""} ${esc(v.name || "")}${v.company ? " · " + esc(v.company) : ""}</div>
    <button type="button" class="danger" data-exit="${esc(v.id)}">บันทึกออก</button>`).join("");
  box.hidden = false;
  bindExitButtons(box, () => { clearForm(); toast("บันทึกออกแล้ว"); });
}
function bindExitButtons(root, after) {
  root.querySelectorAll("[data-exit]").forEach(b => {
    let armed = false, t;
    b.onclick = async () => {
      if (!armed) { armed = true; b.classList.add("arm"); b.dataset.label = b.textContent; b.textContent = "แตะอีกครั้งเพื่อยืนยันออก"; t = setTimeout(() => { armed = false; b.classList.remove("arm"); b.textContent = b.dataset.label; }, 4000); return; }
      clearTimeout(t); b.disabled = true; b.textContent = "กำลังบันทึก…";
      try { const v = S.inside.find(x => x.id === b.dataset.exit); await recordExit(v); after && after(v); }
      catch (e) { console.error(e); b.disabled = false; b.classList.remove("arm"); b.textContent = b.dataset.label; armed = false; toast("บันทึกออกไม่สำเร็จ ลองอีกครั้ง"); }
    };
  });
}
function clearForm() {
  ["#fPlate", "#fProv", "#fName", "#fIdl", "#fCo", "#fNote"].forEach(id => { $(id).value = ""; $(id).classList.remove("warnf"); });
  $("#fDoc").value = ""; S.pax = 1; $("#fPax").textContent = "1"; S.purpose = S.settings.purposes[0];
  S.src = {plate: "manual", person: "manual"}; S.warnAck = ""; S.idHash = "";
  renderPurposes(); renderPlatePreview(); renderSuggestions();
  $("#formErr").hidden = true; $("#scanCard").hidden = true;
}
$("#btnClear").onclick = clearForm;
function formError(msg, warn) { const e = $("#formErr"); e.textContent = msg; e.className = "formerr" + (warn ? " w" : ""); e.hidden = false; e.scrollIntoView({behavior: "smooth", block: "center"}); }
function scanSummary(title, checks) {
  $("#scanTitle").textContent = title;
  $("#scanChecks").innerHTML = checks.map(c => `<li class="${c[0]}">${esc(c[1])}</li>`).join("");
  $("#scanCard").hidden = false;
}

/* ---------- save / exit ---------- */
$("#entry").addEventListener("submit", async ev => {
  ev.preventDefault();
  const plateRaw = $("#fPlate").value.trim(), provRaw = $("#fProv").value.trim(), name = $("#fName").value.trim(), company = $("#fCo").value.trim();
  if (!plateRaw && !name) { formError("กรอกทะเบียนรถ หรือชื่อผู้มาติดต่อ อย่างน้อยหนึ่งอย่าง"); return; }
  const p = parsePlate(plateRaw), prov = provRaw ? snapProvince(provRaw) : {value: "", ok: !plateRaw};
  const warns = [];
  if (plateRaw && !p.ok) warns.push("รูปแบบทะเบียนไม่ตรงมาตรฐาน");
  if (plateRaw && !prov.value) warns.push("ยังไม่มีจังหวัด");
  if (!company) warns.push("ยังไม่ระบุบริษัท");
  if (findInside().length) warns.push("รายการนี้อยู่ในพื้นที่แล้ว");
  const sig = warns.join("|") + plateRaw + name;
  if (warns.length && S.warnAck !== sig) { S.warnAck = sig; formError(warns.join(" · ") + " — กดบันทึกอีกครั้งถ้าถูกต้องแล้ว", true); return; }
  const btn = $("#btnSave"); btn.disabled = true; btn.textContent = "กำลังบันทึก…";
  try {
    const now = new Date(), id = newId();
    const plate = plateRaw ? (p.ok ? p.display : plateRaw) : "", provV = prov.value || "";
    const vKey = plate ? keyOf(plateKey(plate, provV)) : "", pKey = name ? keyOf(normName(name)) : "";
    const visit = {id, day: dayKey(now), inAt: now.toISOString(), outAt: null, status: "in", plate, prov: provV, vKey, name, pKey,
      doc: $("#fDoc").value, idLast4: $("#fIdl").value, company, pax: S.pax, purpose: S.purpose, note: $("#fNote").value.trim(),
      gate: $("#gateName").value.trim(), outGate: "", src: {...S.src}};
    await DB.put("visits", visit);
    S.inside.unshift(visit); S.todayCount++;
    if (vKey) { const veh = {key: vKey, plate, prov: provV, company, driver: name, lastSeen: visit.inAt}; await DB.put("vehicles", veh); upsertLocal(S.vehicles, veh); }
    if (pKey) {
      const prev = S.people.find(p => p.key === pKey) || {};
      const per = {key: pKey, name, company, doc: visit.doc, idLast4: visit.idLast4, vKey, lastSeen: visit.inAt, idHash: S.idHash || prev.idHash || ""};
      if (per.idHash) for (const o of S.people.filter(p => p.idHash === per.idHash && p.key !== pKey)) { o.idHash = ""; await DB.put("people", o); } // name corrected by the guard: the newest wins
      await DB.put("people", per); upsertLocal(S.people, per);
    }
    fillCompanyList(); renderBadge(); renderInside(); enqueue(id);
    showDone(visit); clearForm();
  } catch (e) { console.error(e); formError("บันทึกไม่สำเร็จ พื้นที่เก็บข้อมูลของเบราว์เซอร์อาจเต็ม ลองสำรองแล้วลบข้อมูลเก่า"); }
  finally { btn.disabled = false; btn.textContent = "อนุญาตและบันทึกเข้า"; }
});
function upsertLocal(arr, item) { const i = arr.findIndex(x => x.key === item.key); if (i >= 0) arr[i] = item; else arr.push(item); }
async function recordExit(v) {
  if (!v) throw new Error("gone");
  const upd = {...v, outAt: new Date().toISOString(), status: "out", outGate: $("#gateName").value.trim()};
  await DB.put("visits", upd);
  S.inside = S.inside.filter(x => x.id !== v.id);
  renderBadge(); renderInside(); renderInsideHit(); enqueue(v.id);
}
function showDone(v) {
  $("#doneTime").textContent = `${tOf(v.inAt)} น. · ${fmtD.format(new Date(v.inAt))}`;
  $("#doneKv").innerHTML = [v.plate && ["ทะเบียน", `${parsePlate(v.plate).display} ${v.prov}`], v.name && ["ชื่อ", v.name], v.company && ["บริษัท", v.company],
    ["วัตถุประสงค์", v.purpose], ["จำนวนคน", v.pax]].filter(Boolean).map(([k, val]) => `<dt>${esc(k)}</dt><dd>${esc(val)}</dd>`).join("");
  $("#passQr").innerHTML = qrSvg(`OTX1:${v.id}:${v.pKey || "-"}:${v.vKey || "-"}`, "M");
  $("#doneSheet").hidden = false; $("#btnNext").focus();
}
$("#btnNext").onclick = () => { $("#doneSheet").hidden = true; window.scrollTo({top: 0, behavior: "smooth"}); };

/* ---------- inside list ---------- */
function renderBadge() {
  const b = $("#badge"); b.textContent = S.inside.length; b.hidden = !S.inside.length;
  $("#sPeople").textContent = S.inside.reduce((a, v) => a + (+v.pax || 1), 0);
  $("#sCars").textContent = S.inside.filter(v => v.plate).length;
  $("#sToday").textContent = S.todayCount;
}
function renderInside() {
  const q = normName($("#qInside").value), qp = normPlate($("#qInside").value);
  const rows = S.inside.filter(v => !q || normName(v.name).includes(q) || normName(v.company).includes(q) || (qp && normPlate(v.plate).includes(qp)));
  const box = $("#insideList");
  if (!S.inside.length) { box.innerHTML = `<div class="empty"><b>ยังไม่มีใครอยู่ในพื้นที่</b>รายการที่บันทึกเข้าจะแสดงที่นี่ พร้อมปุ่มบันทึกออก</div>`; return; }
  if (!rows.length) { box.innerHTML = `<div class="empty"><b>ไม่พบ "${esc($("#qInside").value)}"</b>ลองค้นด้วยเลขทะเบียนบางส่วน หรือชื่อบริษัท</div>`; return; }
  box.innerHTML = rows.map(v => {
    const long = (Date.now() - new Date(v.inAt)) / 36e5 > LONG_STAY_H;
    return `<div class="card${long ? " long" : ""}">
      ${v.plate ? plateHTML(v.plate, v.prov, true) : `<span class="pill g">ไม่มีรถ</span>`}
      <div class="who"><b>${esc(v.name || "ไม่ระบุชื่อ")}</b><span>${esc(v.company || "ไม่ระบุบริษัท")} · ${esc(v.purpose || "")}${(+v.pax > 1) ? ` · ${v.pax} คน` : ""}</span></div>
      <div class="meta"><span>เข้า ${tOf(v.inAt)} น.${v.day !== S.todayKey ? " (" + fmtDs.format(new Date(v.inAt)) + ")" : ""} · ${dur(v.inAt)} ${long ? `<span class="pill w">อยู่นานเกิน ${LONG_STAY_H} ชม.</span>` : ""}</span>
      <button type="button" class="danger sm" data-exit="${esc(v.id)}">บันทึกออก</button></div></div>`;
  }).join("");
  bindExitButtons(box, v => toast(`บันทึกออกแล้ว ${v.plate ? parsePlate(v.plate).display : v.name}`));
}
$("#qInside").addEventListener("input", renderInside);

/* ---------- report ---------- */
$("#rFrom").value = $("#rTo").value = dayKey();
["#rFrom", "#rTo"].forEach(id => $(id).addEventListener("change", loadReport));
$("#qReport").addEventListener("input", renderReport);
async function loadReport() {
  let a = $("#rFrom").value || dayKey(), b = $("#rTo").value || a;
  if (a > b) [a, b] = [b, a];
  S.report = (await DB.byIndex("visits", "day", IDBKeyRange.bound(a, b))).sort((x, y) => (y.inAt || "").localeCompare(x.inAt || ""));
  $("#rNote").textContent = `${S.report.length} รายการ`;
  renderReport();
}
function filteredReport() {
  const q = normName($("#qReport").value), qp = normPlate($("#qReport").value);
  return S.report.filter(v => !q || normName(v.name).includes(q) || normName(v.company).includes(q) || (qp && normPlate(v.plate).includes(qp)));
}
function renderReport() {
  const rows = filteredReport();
  $("#rIn").textContent = rows.length; $("#rOut").textContent = rows.filter(v => v.outAt).length; $("#rStill").textContent = rows.filter(v => !v.outAt).length;
  if (!rows.length) { $("#rBody").innerHTML = `<tr><td colspan="9" style="text-align:center;color:var(--muted);padding:24px">ไม่มีรายการในช่วงวันที่นี้</td></tr>`; return; }
  $("#rBody").innerHTML = rows.slice(0, 1500).map(v => `<tr>
    <td class="num">${esc(fmtDs.format(new Date(v.inAt)))}</td><td class="num">${tOf(v.inAt)}</td>
    <td class="num">${v.outAt ? tOf(v.outAt) : '<span class="pill">ในพื้นที่</span>'}</td>
    <td>${v.plate ? esc(parsePlate(v.plate).display) + "<br><small>" + esc(v.prov) + "</small>" : "–"}</td>
    <td>${esc(v.name || "–")}${v.idLast4 ? `<br><small>${esc(v.doc || "")} ••${esc(v.idLast4)}</small>` : ""}</td>
    <td>${esc(v.company || "–")}</td><td>${esc(v.purpose || "")}${v.note ? "<br><small>" + esc(v.note) + "</small>" : ""}</td>
    <td class="num">${esc(v.pax || 1)}</td><td>${esc(v.gate || "")}</td></tr>`).join("");
}
const srcTh = s => ({scan: "สแกน", manual: "กรอกเอง", known: "เลือกจากรายการเดิม", qr: "QR บัตรผ่าน", photo: "รูปถ่าย"})[s] || s || "";
function rowOf(v) {
  return {id: v.id, day: v.day, inTime: tOf(v.inAt), outTime: v.outAt ? tOf(v.outAt) : "", status: v.outAt ? "ออกแล้ว" : "ในพื้นที่",
    plate: v.plate ? parsePlate(v.plate).display : "", prov: v.prov, name: v.name, doc: v.doc, idLast4: v.idLast4, company: v.company, pax: v.pax,
    purpose: v.purpose, note: v.note, gate: v.gate, outGate: v.outGate || "", src: `รถ: ${srcTh(v.src && v.src.plate)} / คน: ${srcTh(v.src && v.src.person)}`,
    inAt: v.inAt, outAt: v.outAt || ""};
}
$("#btnCsv").onclick = () => {
  const rows = filteredReport();
  if (!rows.length) { toast("ไม่มีรายการให้ส่งออก"); return; }
  const q = s => `"${String(s ?? "").replace(/"/g, '""')}"`;
  const head = ["วันที่", "เวลาเข้า", "เวลาออก", "ระยะเวลา", "สถานะ", "ทะเบียน", "จังหวัด", "ชื่อ", "เอกสาร", "เลขท้าย", "บริษัท", "จำนวนคน", "วัตถุประสงค์", "หมายเหตุ", "จุดตรวจเข้า", "จุดตรวจออก", "ที่มาข้อมูล"];
  const lines = rows.map(v => { const r = rowOf(v); return [r.day, r.inTime, r.outTime, dur(v.inAt, v.outAt || undefined), r.status, r.plate, r.prov, r.name, r.doc, r.idLast4 ? `="${r.idLast4}"` : "", r.company, r.pax, r.purpose, r.note, r.gate, r.outGate, r.src].map((c, i) => i === 9 ? c : q(c)).join(","); });
  const a = $("#rFrom").value, b = $("#rTo").value;
  download(`oiltex-yard_${a}${b && b !== a ? "_" + b : ""}.csv`, "﻿" + head.map(q).join(",") + "\n" + lines.join("\n"), "text/csv;charset=utf-8");
};

/* ---------- settings ---------- */
function renderSettings() { $("#setCo").value = S.settings.companies.join("\n"); $("#setPurp").value = S.settings.purposes.join("\n"); }
$("#btnSaveSet").onclick = async () => {
  const split = s => [...new Set(s.split("\n").map(x => x.trim()).filter(Boolean))];
  const companies = split($("#setCo").value), purposes = split($("#setPurp").value);
  S.settings = {companies, purposes: purposes.length ? purposes : DEFAULT_PURPOSES};
  await DB.put("meta", {k: "settings", ...S.settings});
  renderPurposes(); fillCompanyList(); toast("บันทึกรายชื่อแล้ว");
};
async function renderStoreInfo() {
  let txt = "ข้อมูลเก็บในเบราว์เซอร์ของเครื่องนี้ ไม่ได้ส่งไปที่อื่น (นอกจากตั้งค่า Google Sheets)";
  try {
    const all = await DB.all("visits");
    txt += ` · ${all.length.toLocaleString("th-TH")} รายการ`;
    if (navigator.storage && navigator.storage.persisted) txt += (await navigator.storage.persisted()) ? " · ป้องกันการลบอัตโนมัติแล้ว" : " · ควรสำรองข้อมูลเป็นระยะ";
  } catch {}
  $("#storeInfo").textContent = txt;
}

/* ---------- backup / restore / purge ---------- */
$("#btnBackup").onclick = async () => {
  const data = {app: "oiltex-yard", version: 1, exportedAt: new Date().toISOString(), visits: await DB.all("visits"), vehicles: await DB.all("vehicles"), people: await DB.all("people"), registry: await DB.all("registry"), settings: S.settings};
  download(`oiltex-yard-backup_${dayKey()}.json`, JSON.stringify(data), "application/json");
};
$("#btnRestore").onclick = () => { $("#restoreFile").value = ""; $("#restoreFile").click(); };
$("#restoreFile").addEventListener("change", async e => {
  const f = e.target.files && e.target.files[0]; if (!f) return;
  try {
    const d = JSON.parse(await f.text());
    if (d.app !== "oiltex-yard" || !Array.isArray(d.visits)) throw new Error("bad");
    await DB.putMany("visits", d.visits); await DB.putMany("vehicles", d.vehicles || []); await DB.putMany("people", d.people || []); await DB.putMany("registry", d.registry || []);
    if (d.settings) await DB.put("meta", {k: "settings", ...d.settings});
    await loadAll(); toast(`นำเข้าแล้ว ${d.visits.length} รายการ`);
  } catch { toast("ไฟล์นี้ไม่ใช่ไฟล์สำรองของ OIL-TEX Yard"); }
});
let purgeArm = 0;
$("#btnPurge").onclick = async () => {
  const days = +$("#purgeDays").value, b = $("#btnPurge");
  if (Date.now() - purgeArm > 4000) { purgeArm = Date.now(); b.textContent = `แตะอีกครั้งเพื่อลบรายการที่เก่ากว่า ${days} วัน`; b.classList.add("arm"); setTimeout(() => { b.textContent = "ลบข้อมูลเก่า"; b.classList.remove("arm"); }, 4000); return; }
  purgeArm = 0; b.textContent = "ลบข้อมูลเก่า"; b.classList.remove("arm");
  const cut = dayKey(new Date(Date.now() - days * 864e5));
  const old = (await DB.byIndex("visits", "day", IDBKeyRange.upperBound(cut, true))).filter(v => v.status === "out");
  await DB.delMany("visits", old.map(v => v.id)); toast(`ลบแล้ว ${old.length} รายการ`); renderStoreInfo();
};

/* ---------- registered vehicles: back-office list ---------- */
const regKey = (plate, prov) => keyOf(plateKey(plate, prov));
function parseRegistry(text) {
  const rows = [], bad = [];
  for (const raw of String(text || "").split(/\r?\n/)) {
    const line = raw.trim(); if (!line) continue;
    const cols = (line.includes("\t") ? line.split("\t") : line.split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/)).map(c => c.replace(/^"|"$/g, "").trim());
    if (/ทะเบียน|plate/i.test(cols[0]) && !/\d/.test(cols[0])) continue;   // header row
    let plate = cols[0] || "", rest = cols.slice(1);
    // "1กข 1234 ระยอง" in one cell: the province moves out and the other columns shift left
    const m = plate.match(/^(.*?\d)\s+([ก-๛ .]+)$/);
    if (m) { plate = m[1]; rest = [m[2]].concat(rest); }
    const p = parsePlate(plate);
    if (!p.ok) { bad.push(line); continue; }
    const prov = rest[0] || "", pv = prov ? snapProvince(prov) : {value: ""};
    rows.push({key: regKey(p.display, pv.value), plate: p.display, prov: pv.value || prov, company: rest[1] || "", driver: rest[2] || "", note: rest[3] || "", src: "import", at: new Date().toISOString()});
  }
  return {rows, bad};
}
async function addRegistry(rows, replaceFrom) {
  if (replaceFrom) { const old = S.registry.filter(r => r.src === replaceFrom).map(r => r.key); if (old.length) await DB.delMany("registry", old); }
  await DB.putMany("registry", rows);
  S.registry = await DB.all("registry"); renderRegistry(); fillCompanyList();
}
function renderRegistry() {
  const q = normPlate($("#regQ").value), qn = normName($("#regQ").value);
  const list = S.registry.filter(r => !q || normPlate(r.plate).includes(q) || normName(r.company).includes(qn)).sort((a, b) => normPlate(a.plate).localeCompare(normPlate(b.plate), "th"));
  const src = {sheet: "Google Sheets", import: "นำเข้า", manual: "เพิ่มเอง"};
  $("#regInfo").textContent = S.registry.length ? `${S.registry.length.toLocaleString("th-TH")} คัน · สแกนเจอรถในรายการนี้จะล็อกได้ทันที` : "ยังไม่มีรายการ ระบบจะใช้รถที่เคยเข้าเป็นตัวช่วยแทน";
  $("#regList").innerHTML = list.slice(0, 60).map(r => `<div class="regrow">${plateHTML(r.plate, r.prov, true)}<div class="who"><b>${esc(r.company || "ไม่ระบุบริษัท")}</b><span>${esc([r.driver, src[r.src] || ""].filter(Boolean).join(" · "))}</span></div><button type="button" class="ghost sm" data-regdel="${esc(r.key)}" aria-label="ลบ ${esc(r.plate)}">ลบ</button></div>`).join("") + (list.length > 60 ? `<p>แสดง 60 จาก ${list.length} คัน ค้นหาเพื่อดูคันอื่น</p>` : "");
  $$("#regList [data-regdel]").forEach(b => b.onclick = async () => { await DB.delMany("registry", [b.dataset.regdel]); S.registry = S.registry.filter(r => r.key !== b.dataset.regdel); renderRegistry(); });
}
$("#regQ").addEventListener("input", renderRegistry);
$("#btnRegAdd").onclick = async () => {
  const {rows, bad} = parseRegistry($("#regPaste").value);
  if (!rows.length) { toast(bad.length ? "อ่านเลขทะเบียนไม่ได้ ตรวจรูปแบบ เช่น 70-1234 หรือ 1กข 1234" : "วางรายการก่อน"); return; }
  await addRegistry(rows); $("#regPaste").value = "";
  toast(`เพิ่ม ${rows.length} คัน${bad.length ? ` · ข้าม ${bad.length} แถวที่อ่านทะเบียนไม่ได้` : ""}`);
};
$("#btnRegCsv").onclick = () => {
  const q = s => `"${String(s ?? "").replace(/"/g, '""')}"`;
  const lines = S.registry.map(r => [r.plate, r.prov, r.company, r.driver, r.note].map(q).join(","));
  download("oiltex-registered-vehicles.csv", "\uFEFF" + ["ทะเบียน", "จังหวัด", "บริษัท", "คนขับ", "หมายเหตุ"].map(q).join(",") + "\n" + lines.join("\n"), "text/csv;charset=utf-8");
};
let regClearArm = 0;
$("#btnRegClear").onclick = async () => {
  const b = $("#btnRegClear");
  if (Date.now() - regClearArm > 4000) { regClearArm = Date.now(); b.textContent = "แตะอีกครั้งเพื่อล้างรายการรถทั้งหมด"; b.classList.add("arm"); setTimeout(() => { b.textContent = "ล้างรายการ"; b.classList.remove("arm"); }, 4000); return; }
  regClearArm = 0; b.textContent = "ล้างรายการ"; b.classList.remove("arm");
  await DB.clear("registry"); S.registry = []; renderRegistry(); toast("ล้างรายการรถแล้ว");
};
async function pullRegistry(manual) {
  if (!SYNC.url || !navigator.onLine) { if (manual) toast(SYNC.url ? "ออฟไลน์อยู่ ลองใหม่เมื่อมีเน็ต" : "ตั้งค่าลิงก์ Google Sheets ด้านล่างก่อน"); return; }
  try {
    const res = await fetch(SYNC.url + (SYNC.url.includes("?") ? "&" : "?") + "action=registry", {redirect: "follow"});
    const j = await res.json();
    if (!j.ok || !Array.isArray(j.rows)) throw new Error(j.error || "bad");
    const {rows} = parseRegistry(j.rows.map(r => [r.plate, r.prov, r.company, r.driver, r.note].map(v => String(v ?? "").replace(/[\t\n]/g, " ")).join("\t")).join("\n"));
    rows.forEach(r => r.src = "sheet");
    await addRegistry(rows, "sheet");
    lsSet("oiltex.regPulled", new Date().toISOString());
    $("#regPullInfo").textContent = `ดึงจาก Google Sheets ล่าสุด ${tOf(new Date().toISOString())} น. · ${rows.length} คัน`;
    if (manual) toast(`อัปเดตรายการรถจากหลังบ้านแล้ว ${rows.length} คัน`);
  } catch (e) { if (manual) toast("ดึงรายการไม่สำเร็จ ตรวจว่าอัปเดตโค้ด Apps Script เป็นเวอร์ชันใหม่แล้ว"); }
}
$("#btnRegPull").onclick = () => pullRegistry(true);
setInterval(() => pullRegistry(false), 10 * 60 * 1000);

/* ---------- Google Sheets sync (optional) ---------- */
const SYNC = {url: "", queue: [], last: null, err: "", busy: false};
async function loadSync() { const m = await DB.get("meta", "sync"); if (m) Object.assign(SYNC, {url: m.url || "", queue: m.queue || [], last: m.last || null}); $("#syncUrl").value = SYNC.url; renderSyncInfo(); }
async function saveSync() { await DB.put("meta", {k: "sync", url: SYNC.url, queue: SYNC.queue, last: SYNC.last}); renderSyncInfo(); }
function renderSyncInfo() {
  const el = $("#syncInfo");
  if (!SYNC.url) { el.textContent = "ยังไม่ได้ตั้งค่า ข้อมูลอยู่ในเครื่องนี้เท่านั้น"; return; }
  el.textContent = (SYNC.queue.length ? `รอส่ง ${SYNC.queue.length} รายการ` : "ส่งครบแล้ว") + (SYNC.last ? ` · ส่งล่าสุด ${tOf(SYNC.last)} น.` : "") + (SYNC.err ? ` · ${SYNC.err}` : "");
}
function enqueue(id) { if (!SYNC.url) return; if (!SYNC.queue.includes(id)) SYNC.queue.push(id); saveSync().then(flushSync); }
async function postSync(body) {
  const res = await fetch(SYNC.url, {method: "POST", headers: {"Content-Type": "text/plain;charset=utf-8"}, body: JSON.stringify(body), redirect: "follow"});
  const j = await res.json();
  if (!j.ok) throw new Error(j.error || "ชีตตอบกลับผิดพลาด");
  return j;
}
async function flushSync() {
  if (SYNC.busy || !SYNC.url || !SYNC.queue.length || !navigator.onLine) return;
  SYNC.busy = true;
  try {
    while (SYNC.queue.length) {
      const ids = SYNC.queue.slice(0, 25);
      const rows = (await Promise.all(ids.map(id => DB.get("visits", id)))).filter(Boolean).map(rowOf);
      await postSync({action: "upsert", rows});
      SYNC.queue = SYNC.queue.filter(x => !ids.includes(x)); SYNC.last = new Date().toISOString(); SYNC.err = "";
      await saveSync();
    }
  } catch (e) { SYNC.err = "ส่งไม่สำเร็จ จะลองใหม่อัตโนมัติ"; renderSyncInfo(); }
  finally { SYNC.busy = false; }
}
setInterval(flushSync, 60000);
$("#btnSyncSave").onclick = async () => {
  const url = $("#syncUrl").value.trim();
  if (url && !/^https:\/\/script\.google(usercontent)?\.com\//.test(url)) { toast("ลิงก์ต้องขึ้นต้นด้วย https://script.google.com/"); return; }
  SYNC.url = url; SYNC.err = "";
  if (!url) { await saveSync(); toast("ปิดการส่งขึ้น Google Sheets แล้ว"); return; }
  try { await postSync({action: "ping"}); toast("เชื่อม Google Sheets สำเร็จ"); }
  catch { SYNC.err = "ทดสอบไม่ผ่าน ตรวจว่า Deploy เป็น Web app และให้ Anyone เข้าถึงได้"; }
  await saveSync(); flushSync();
};
$("#btnSyncNow").onclick = async () => {
  if (!SYNC.url) { toast("ใส่ลิงก์ Apps Script ก่อน"); return; }
  if (!SYNC.queue.length) { const all = await DB.all("visits"); SYNC.queue = all.map(v => v.id); await saveSync(); }
  await flushSync(); toast(SYNC.queue.length ? "ยังส่งไม่ครบ ตรวจอินเทอร์เน็ต" : "ส่งครบแล้ว");
};

/* ---------- QR codes ---------- */
function qrSvg(text, ecl = "M") {
  const q = qrcode(0, ecl); q.addData(text); q.make();
  const n = q.getModuleCount(), m = 4, size = n + m * 2; let d = "";
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (q.isDark(r, c)) d += `M${c + m} ${r + m}h1v1h-1z`;
  return `<svg viewBox="0 0 ${size} ${size}" xmlns="http://www.w3.org/2000/svg" shape-rendering="crispEdges" role="img" aria-label="QR code"><rect width="${size}" height="${size}" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
}
const appUrl = () => location.href.split("#")[0].split("?")[0];
function renderAppQr() {
  const url = appUrl(), ok = /^https?:/.test(url);
  $("#appLink").textContent = ok ? url : "เปิดผ่านลิงก์เว็บก่อน แล้ว QR จะแสดงที่นี่";
  $("#appQr").innerHTML = ok ? qrSvg(url, "Q") : `<p style="color:#555;margin:40px 0">ยังไม่มีลิงก์เว็บ</p>`;
}
$("#btnCopy").onclick = async () => {
  try { await navigator.clipboard.writeText(appUrl()); toast("คัดลอกลิงก์แล้ว"); }
  catch { const r = document.createRange(); r.selectNodeContents($("#appLink")); const s = getSelection(); s.removeAllRanges(); s.addRange(r); toast("เลือกลิงก์แล้ว กดคัดลอกจากเมนู"); }
};
$("#btnPoster").onclick = () => { $("#posterQr").innerHTML = qrSvg(appUrl(), "Q"); $("#posterLink").textContent = appUrl(); setTimeout(() => window.print(), 50); };
$("#btnQrPng").onclick = () => {
  const q = qrcode(0, "Q"); q.addData(appUrl()); q.make();
  const n = q.getModuleCount(), m = 4, cell = Math.floor(1024 / (n + m * 2)), size = cell * (n + m * 2);
  const c = document.createElement("canvas"); c.width = c.height = size; const g = c.getContext("2d");
  g.fillStyle = "#fff"; g.fillRect(0, 0, size, size); g.fillStyle = "#000";
  for (let r = 0; r < n; r++) for (let col = 0; col < n; col++) if (q.isDark(r, col)) g.fillRect((col + m) * cell, (r + m) * cell, cell, cell);
  c.toBlob(b => download("OIL-TEX-Yard-QR.png", b), "image/png");
};

/* ---------- registered vehicles (back office) ---------- */
// Plates the reader may snap to: the back-office list first, then vehicles that entered before.
function knownPlates() {
  const seen = new Set(), out = [];
  for (const r of S.registry) { const k = normPlate(r.plate); if (!k || seen.has(k + "|" + normProv(r.prov))) continue; seen.add(k + "|" + normProv(r.prov)); out.push({...r, from: "registry"}); }
  for (const v of S.vehicles) { const k = normPlate(v.plate); if (!k || seen.has(k + "|" + normProv(v.prov))) continue; seen.add(k + "|" + normProv(v.prov)); out.push({plate: v.plate, prov: v.prov, company: v.company, driver: v.driver, from: "history"}); }
  return out;
}
const regFind = (plate, prov) => S.registry.find(r => normPlate(r.plate) === normPlate(plate) && (!prov || !r.prov || normProv(r.prov) === normProv(prov))) || null;

/* ---------- applying scan results to the form ---------- */
function applyPlate(lock) {
  const prov = lock.prov ? snapProvince(lock.prov) : {value: "", ok: false};
  $("#fPlate").value = lock.plate; flash($("#fPlate"));
  $("#fProv").value = prov.value; if (prov.value) flash($("#fProv"));
  $("#fPlate").classList.toggle("warnf", !parsePlate(lock.plate).ok || !!(lock.unsure && lock.unsure.length));
  $("#fProv").classList.toggle("warnf", !prov.value || (lock.provConf != null && lock.provConf < 0.6 && !lock.reg));
  S.src.plate = lock.src || "scan";
  const checks = [];
  if (lock.reg) checks.push(["", `ตรงกับรถ${lock.reg.from === "registry" ? "ที่ลงทะเบียนในหลังบ้าน" : "ที่เคยเข้า"}${lock.reg.company ? ": " + lock.reg.company : ""}`]);
  else checks.push(lock.votes > 1 ? ["", `อ่านตรงกัน ${lock.votes} ภาพจากกล้องสด`] : ["", "อ่านจากรูปถ่าย"]);
  if (lock.unsure && lock.unsure.length) checks.push(["w", "ตัวที่ขีดเส้นใต้ยังไม่ชัด ตรวจกับป้ายจริง"]);
  checks.push(parsePlate(lock.plate).ok ? ["", "รูปแบบทะเบียนถูกต้อง"] : ["w", "รูปแบบทะเบียนไม่ตรงมาตรฐาน ตรวจกับป้ายจริง"]);
  checks.push(prov.value ? [lock.provConf != null && lock.provConf < 0.6 && !lock.reg ? "w" : "", `จังหวัด ${prov.value}${lock.provConf != null && lock.provConf < 0.6 && !lock.reg ? " (ไม่แน่ใจ)" : ""}`] : ["w", "อ่านจังหวัดไม่ได้ เลือกเองจากรายการ"]);
  const src = lock.reg || S.vehicles.find(v => normPlate(v.plate) === normPlate(lock.plate));
  if (src) { if (!$("#fCo").value && src.company) setField("#fCo", src.company); if (!$("#fName").value && src.driver) setField("#fName", src.driver); }
  renderPlatePreview(); renderSuggestions();
  scanSummary("อ่านป้ายทะเบียนแล้ว", checks);
}
function applyPersonLock(lock) {
  const checks = [];
  if (lock.name) { $("#fName").value = lock.name; flash($("#fName")); } else checks.push(["w", "อ่านชื่อไม่ได้ กรอกชื่อเอง"]);
  $("#fDoc").value = lock.doc; if (lock.last4) { $("#fIdl").value = lock.last4; flash($("#fIdl")); }
  S.src.person = lock.src || "scan";
  if (lock.doc === "พาสปอร์ต") checks.unshift(["", "เลขพาสปอร์ตผ่านการตรวจ MRZ"]);
  else checks.unshift(["", `เลขบัตร 13 หลักผ่านการตรวจเลข${lock.votes > 1 ? ` (อ่าน ${lock.votes} ภาพ)` : ""}`]);
  if (lock.name && lock.nameLang === "en") checks.push(["w", "ใช้ชื่อภาษาอังกฤษจากบัตร แก้เป็นภาษาไทยได้"]);
  if (lock.nameLang === "known") checks.push(["", "ชื่อจากการยืนยันครั้งก่อน (จำจากเลขบัตร)"]);
  else if (lock.name && lock.doc === "บัตรประชาชน") checks.push(["w", "ตรวจชื่อกับบัตรจริง แก้ได้ในช่องชื่อ"]);
  if (lock.company && !$("#fCo").value) setField("#fCo", lock.company);
  checks.push(["", "เก็บเฉพาะเลขท้าย 4 หลัก ตาม PDPA"]);
  const known = lock.name && S.people.find(p => normName(p.name) === normName(lock.name));
  if (known) { checks.push(["", `เคยมาแล้ว${known.company ? ": " + known.company : ""}`]); if (!$("#fCo").value && known.company) setField("#fCo", known.company); }
  renderSuggestions();
  scanSummary(`อ่าน${lock.doc}แล้ว`, checks);
}
function handleQrText(text) {
  const m = /^OTX1:([^:]+):([^:]*):([^:]*)$/.exec(String(text).trim());
  if (!m) { scanSummary("QR นี้ไม่ใช่บัตรผ่าน OIL-TEX", [["x", String(text).slice(0, 80)]]); return; }
  const [, vid, pk, vk] = m;
  const inside = S.inside.find(v => v.id === vid) || S.inside.find(v => (pk !== "-" && v.pKey === pk) || (vk !== "-" && v.vKey === vk));
  clearForm();
  if (inside) {
    $("#fPlate").value = inside.plate || ""; $("#fProv").value = inside.prov || ""; $("#fName").value = inside.name || ""; $("#fCo").value = inside.company || "";
    renderPlatePreview(); renderInsideHit();
    scanSummary("บัตรผ่านถูกต้อง · อยู่ในพื้นที่", [["", `เข้าเมื่อ ${tOf(inside.inAt)} น.`], ["", "กด บันทึกออก ด้านล่างเพื่อยืนยัน"]]);
    $("#insideHit").scrollIntoView({behavior: "smooth", block: "center"}); return;
  }
  const person = S.people.find(p => p.key === pk), veh = S.vehicles.find(v => v.key === vk);
  if (!person && !veh) { scanSummary("บัตรผ่านนี้ไม่มีในเครื่องนี้", [["w", "อาจบันทึกจากเครื่องอื่น ให้สแกนป้ายหรือบัตรแทน"]]); return; }
  if (veh) applyVehicle(veh); if (person) applyPerson(person);
  if (veh) S.src.plate = "qr"; if (person) S.src.person = "qr";
  scanSummary("เติมข้อมูลจากบัตรผ่านแล้ว", [["", "ข้อมูลจากการเข้าครั้งก่อน"], ["", "ตรวจคนและรถให้ตรง แล้วกดบันทึกเข้า"]]);
}

/* ---------- live scanner ---------- */
const video = $("#cam"), guide = $("#guide");
const SC = {stream: null, track: null, mode: "plate", gen: 0, pass: 0, locked: null, audio: null, ready: {}, pf: null, idf: null, lastId: null, t0: 0, ms: []};
const HINT = {plate: "วางป้ายทะเบียนให้อยู่ในกรอบ", id: "วางด้านหน้าบัตรให้เต็มกรอบ", passport: "ให้แถบตัวอักษร 2 บรรทัดล่างอยู่ในกรอบเส้นประ", qr: "ส่อง QR บัตรผ่านให้อยู่ในกรอบ"};
const SUB = {plate: "ให้ป้ายเต็มกรอบ ถือนิ่ง ๆ · รถอยู่ไกลใช้ซูม · กลางคืนเปิดไฟ", id: "วางบัตรบนพื้นเรียบ ให้บัตรเต็มกรอบ เอียงเล็กน้อยหลบแสงสะท้อน", passport: "เปิดหน้าที่มีรูป วางให้เรียบ", qr: "ห่างประมาณ 1 คืบ ลดความสว่างจอที่แสดง QR ถ้าจ้าเกิน"};
const PLATE_GIVEUP_MS = 4500;
let barcodeDetector = null;
try { if ("BarcodeDetector" in window) barcodeDetector = new BarcodeDetector({formats: ["qr_code"]}); } catch {}

function live(v, sub, frac, html) {
  if (html) $("#scLive").innerHTML = v; else $("#scLive").textContent = v;
  if (sub != null) $("#scSub").textContent = sub;
  if (frac != null) $("#scMeter").style.width = Math.round(Math.max(0, Math.min(1, frac)) * 100) + "%";
}
function ensureAudio() { try { if (!SC.audio) SC.audio = new (window.AudioContext || window.webkitAudioContext)(); if (SC.audio.state === "suspended") SC.audio.resume(); } catch {} }
function beep() {
  try { const a = SC.audio, o = a.createOscillator(), g = a.createGain(); o.frequency.value = 1046; g.gain.setValueAtTime(0.0001, a.currentTime); g.gain.exponentialRampToValueAtTime(0.35, a.currentTime + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, a.currentTime + 0.16); o.connect(g).connect(a.destination); o.start(); o.stop(a.currentTime + 0.18); } catch {}
  try { navigator.vibrate && navigator.vibrate(90); } catch {}
}
function warmTess(langs) { for (const l of langs) OCR.worker(l).then(() => SC.ready[l] = true).catch(() => {}); }

$$("[data-open]").forEach(b => b.onclick = () => openScanner(b.dataset.open));
$$("#modes button").forEach(b => b.onclick = () => setMode(b.dataset.mode));
$("#scClose").onclick = closeScanner;
async function openScanner(mode) {
  ensureAudio(); keepAwake();
  $("#scanner").hidden = false; document.body.style.overflow = "hidden";
  setMode(mode);
  await startCam();
}
function closeScanner() { SC.gen++; stopCam(); $("#scanner").hidden = true; document.body.style.overflow = ""; $("#scTorch").setAttribute("aria-pressed", "false"); }
function setMode(m) {
  SC.mode = m; SC.gen++; SC.pass = 0; SC.locked = null; SC.lastId = null; SC.t0 = performance.now(); SC.ms = [];
  SC.pf = new Reader.PlateFusion(knownPlates()); SC.idf = new Reader.IdFusion();
  guide.className = "guide m-" + m;
  $("#scHint").textContent = HINT[m];
  $$("#modes button").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.mode === m)));
  $("#lockPanel").hidden = true; $("#scRead").hidden = false; $("#modes").hidden = false;
  live(m === "qr" ? "กำลังหา QR…" : "กำลังอ่าน…", SUB[m], 0);
  if (m === "id") warmTess(["tha", "eng"]); if (m === "passport") warmTess(["eng"]);
  if (SC.stream) runLoop();
}
async function startCam() {
  $("#scErr").hidden = true;
  if (!window.isSecureContext || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    scErr("กล้องสดใช้ได้เมื่อเปิดผ่านลิงก์ https เท่านั้น ปิดหน้านี้แล้วกด \"ใช้รูปถ่ายแทน\" ได้"); return;
  }
  try {
    if (!SC.stream) SC.stream = await navigator.mediaDevices.getUserMedia({audio: false, video: {facingMode: {ideal: "environment"}, width: {ideal: 1920}, height: {ideal: 1080}}});
    video.srcObject = SC.stream; await video.play().catch(() => {});
    SC.track = SC.stream.getVideoTracks()[0];
    setupCaps(); runLoop();
  } catch (e) {
    scErr(e && e.name === "NotAllowedError" ? "ยังไม่ได้อนุญาตให้ใช้กล้อง กดไอคอนกุญแจหรือ aA ที่แถบที่อยู่ แล้วอนุญาตกล้อง" : e && e.name === "NotFoundError" ? "ไม่พบกล้องในเครื่องนี้" : "เปิดกล้องไม่ได้ (" + (e && e.name) + ") ปิดแอปอื่นที่ใช้กล้องอยู่แล้วลองใหม่");
  }
}
function scErr(msg) { const e = $("#scErr"); e.textContent = msg; e.hidden = false; live("กล้องไม่พร้อม", "", 0); }
function setupCaps() {
  const caps = SC.track && SC.track.getCapabilities ? SC.track.getCapabilities() : {};
  const adv = [];
  if (caps.focusMode && caps.focusMode.includes("continuous")) adv.push({focusMode: "continuous"});
  if (caps.exposureMode && caps.exposureMode.includes("continuous")) adv.push({exposureMode: "continuous"});
  if (adv.length) SC.track.applyConstraints({advanced: adv}).catch(() => {});
  $("#scTorch").hidden = !caps.torch;
  if (caps.zoom && caps.zoom.max > caps.zoom.min) {
    const z = $("#scZoom"); z.min = caps.zoom.min; z.max = Math.min(caps.zoom.max, 8); z.step = caps.zoom.step || 0.1;
    const cur = (SC.track.getSettings().zoom) || caps.zoom.min; z.value = cur; $("#zoomVal").textContent = (+cur).toFixed(1) + "×"; $("#zoomRow").hidden = false;
  } else $("#zoomRow").hidden = true;
}
$("#scZoom").addEventListener("input", e => { const v = +e.target.value; SC.track && SC.track.applyConstraints({advanced: [{zoom: v}]}).catch(() => {}); $("#zoomVal").textContent = v.toFixed(1) + "×"; });
$("#scTorch").onclick = async () => {
  const on = $("#scTorch").getAttribute("aria-pressed") !== "true";
  try { await SC.track.applyConstraints({advanced: [{torch: on}]}); $("#scTorch").setAttribute("aria-pressed", String(on)); } catch { toast("เปิดไฟไม่ได้ในเครื่องนี้"); }
};
function stopCam() { if (SC.stream) { SC.stream.getTracks().forEach(t => t.stop()); SC.stream = null; SC.track = null; video.srcObject = null; } }
document.addEventListener("visibilitychange", () => {
  if ($("#scanner").hidden) return;
  if (document.visibilityState === "hidden") { SC.gen++; stopCam(); } else startCam();
});

// guide box (screen) -> region in the video frame (object-fit: cover)
function regionInVideo() {
  const vw = video.videoWidth, vh = video.videoHeight; if (!vw || !vh) return null;
  const r = video.getBoundingClientRect(), g = guide.getBoundingClientRect();
  const s = Math.max(r.width / vw, r.height / vh), ox = (r.width - vw * s) / 2, oy = (r.height - vh * s) / 2;
  const pad = {plate: 0.1, id: 0.03, passport: 0.04, qr: 0.12}[SC.mode];
  let x = (g.left - r.left - ox) / s, y = (g.top - r.top - oy) / s, w = g.width / s, h = g.height / s;
  x -= w * pad; y -= h * pad; w *= 1 + pad * 2; h *= 1 + pad * 2;
  x = Math.max(0, x); y = Math.max(0, y); w = Math.min(vw - x, w); h = Math.min(vh - y, h);
  return {x, y, w, h};
}
function grab(rect, maxW = 1600) {
  const s = Math.min(1, maxW / rect.w), c = document.createElement("canvas");
  c.width = Math.round(rect.w * s); c.height = Math.round(rect.h * s);
  const g = c.getContext("2d", {willReadFrequently: true}); g.imageSmoothingQuality = "high";
  g.drawImage(video, rect.x, rect.y, rect.w, rect.h, 0, 0, c.width, c.height);
  return c;
}
async function qrFrom(canvas, both) {
  if (barcodeDetector) { try { const r = await barcodeDetector.detect(canvas); if (r && r[0]) return r[0].rawValue; } catch {} }
  const d = canvas.getContext("2d", {willReadFrequently: true}).getImageData(0, 0, canvas.width, canvas.height);
  const r = jsQR(d.data, canvas.width, canvas.height, {inversionAttempts: both ? "attemptBoth" : "dontInvert"});
  return r ? r.data : null;
}
const frameMs = () => SC.ms.length ? Math.round(SC.ms.reduce((a, b) => a + b, 0) / SC.ms.length) : 0;
async function runLoop() {
  const gen = ++SC.gen;
  await sleep(150);
  if (SC.mode !== "qr" && SC.mode !== "passport" && !Reader.ready()) {
    live("กำลังโหลดตัวอ่าน…", "ครั้งแรกใช้เวลาไม่กี่วินาที", 0.02);
    try { await Reader.load("models/"); } catch { live("โหลดตัวอ่านไม่สำเร็จ", "ตรวจอินเทอร์เน็ตแล้วเปิดใหม่", 0); return; }
  }
  while (gen === SC.gen && SC.stream && !SC.locked) {
    if (video.readyState < 2 || !video.videoWidth) { await sleep(60); continue; }
    const rect = regionInVideo(); if (!rect) { await sleep(60); continue; }
    try {
      if (SC.mode === "qr") {
        const t = await qrFrom(grab(rect, 900), SC.pass++ % 3 === 2);
        if (gen !== SC.gen) return;
        if (t) { lockQr(t); return; }
        await sleep(40); continue;
      }
      if (SC.mode === "plate") { plateStep(grab(rect, 640)); await sleep(0); continue; }
      if (SC.mode === "id") { await idStep(grab(rect, 1000), gen); await sleep(0); continue; }
      const pc = grab(rect), r = await OCR.readPassport(pc, {x: 0, y: 0, w: pc.width, h: pc.height}, SC.pass++);
      if (gen !== SC.gen) return;
      if (r.passport) lockResult({kind: "passport", passport: r.passport, name: r.name || "", nat: r.nat || "", votes: 1});
      else live("กำลังหาแถบ MRZ…", SUB.passport, 0.05);
    } catch (e) { console.error(e); live("อ่านไม่สำเร็จ กำลังลองใหม่…", null, null); await sleep(300); }
  }
}
function plateHtml(st) {
  // uncertain characters are underlined so the guard knows what to check
  let i = 0;
  return esc(st.display).replace(/[0-9ก-ฮ]/g, ch => { const u = st.unsure && st.unsure.includes(i); i++; return u ? `<u style="text-decoration-color:#f2c94c;text-decoration-thickness:3px">${ch}</u>` : ch; });
}
function plateStep(canvas) {
  const f = Reader.readPlateFrame(canvas);
  if (f && f.ms) { SC.ms.push(f.ms); if (SC.ms.length > 10) SC.ms.shift(); }
  const st = SC.pf.add(f);
  const elapsed = performance.now() - SC.t0;
  if (!st.text) { live("กำลังหาป้าย…", `${SUB.plate}`, 0.04); return; }
  const prov = st.regLock ? st.reg.prov : (st.provConf >= 0.35 ? st.prov : "");
  live(plateHtml(st) + (prov ? `<span style="font-size:15px;font-weight:600;opacity:.85">  ${esc(prov)}</span>` : ""), st.regLock ? "ตรงกับรถที่ลงทะเบียน" : `อ่าน ${st.n} ภาพ · ${frameMs()} ms/ภาพ`, st.regLock || st.freeLock ? 1 : Math.min(0.9, st.minConf * Math.min(1, st.n / 2)), true);
  if (st.regLock) { lockResult({kind: "plate", plate: Reader.display(normPlate(st.reg.plate), /^\d{6}$/.test(normPlate(st.reg.plate))), prov: st.reg.prov || st.prov, provConf: 1, reg: st.reg, votes: st.n, ms: elapsed}); return; }
  if (st.freeLock) {
    // wait a few more frames for the province if it is still unclear
    if (st.provConf < 0.6 && st.n < 5 && elapsed < PLATE_GIVEUP_MS) return;
    lockResult({kind: "plate", plate: st.display, prov: st.provConf >= 0.35 ? st.prov : "", provConf: st.provConf, votes: st.n, unsure: st.unsure, alts: st.alts, text: st.text, ms: elapsed}); return;
  }
  if (elapsed > PLATE_GIVEUP_MS && st.n >= 3) lockResult({kind: "plate", plate: st.display, prov: st.provConf >= 0.35 ? st.prov : "", provConf: st.provConf, votes: st.n, unsure: st.unsure, alts: st.alts, text: st.text, weak: true, ms: elapsed});
}
async function idStep(canvas, gen) {
  const f = Reader.readIdFrame(canvas);
  if (f && f.ms) { SC.ms.push(f.ms); if (SC.ms.length > 10) SC.ms.shift(); }
  let st = SC.idf.add(f && f.found ? f : null);
  if (f && f.found) SC.lastId = f;
  // every few frames let Tesseract read the number too, as an independent vote
  if (SC.pass++ % 4 === 3 && SC.ready.eng) {
    const r = await OCR.readIdCard(canvas, {x: 0, y: 0, w: canvas.width, h: canvas.height}, 0).catch(() => ({}));
    if (gen !== SC.gen) return;
    if (r.id) st = SC.idf.add({text: r.id});
  }
  if (!st.n) { live("กำลังหาเลขบัตร 13 หลัก…", SUB.id, 0.05); return; }
  const shown = st.id || st.partial;
  live(`•••• ••••• ${shown.slice(9, 11)} ${shown[12]}`, st.id ? `เลขบัตรผ่านการตรวจเลข · อ่าน ${st.n} ภาพ` : `กำลังยืนยันเลขบัตร · อ่าน ${st.n} ภาพ`, st.lock ? 1 : Math.min(0.9, 0.3 + st.n * 0.2));
  if (st.lock) lockResult({kind: "id", id: st.id, name: "", nameLang: "", votes: st.n, pendingName: true});
}
async function readIdNames(f, gen) {
  if (!f) return null;
  const bands = Reader.idNameBands(f);
  if (!bands.length) return null;
  const rec = async (lang, c) => { const w = await OCR.worker(lang); await w.setParameters({tessedit_pageseg_mode: "7", tessedit_char_whitelist: "", preserve_interword_spaces: "1"}); return (await w.recognize(c)).data.text || ""; };
  const tt = await rec("tha", bands[0]).catch(() => "");
  if (gen !== SC.gen) return null;
  const a = bands[1] ? await rec("eng", bands[1]).catch(() => "") : "", b = bands[2] ? await rec("eng", bands[2]).catch(() => "") : "";
  const cap = s => s && s.replace(/[A-Za-z]+/g, w => w[0].toUpperCase() + w.slice(1).toLowerCase()).replace(/^(Mr|Mrs|Ms)\. /, "$1. ");
  return {th: Reader.parseThName(tt), en: cap(Reader.parseEnName(a, b))};
}
function lockResult(res) {
  SC.locked = res; const gen = ++SC.gen;
  guide.classList.add("locked"); beep();
  $("#scRead").hidden = true; $("#modes").hidden = true;
  const p = $("#lockPanel");
  const render = () => {
    let body = "", hits = [];
    if (res.kind === "plate") {
      hits = findInsideBy(res.plate, res.prov, "");
      const title = res.reg ? `ตรงกับรถ${res.reg.from === "registry" ? "ที่ลงทะเบียน" : "ที่เคยเข้า"}` : res.weak ? "อ่านได้ไม่ชัด ตรวจก่อนใช้" : "อ่านป้ายได้แล้ว";
      body = `<div class="t">${title} <small style="font-weight:400;color:#5a6e76;margin-left:auto">${(res.ms / 1000).toFixed(1)} วินาที</small></div><div style="display:flex;justify-content:center">${plateHTML(res.plate, res.prov || "จังหวัด ?")}</div>`;
      if (res.reg && (res.reg.company || res.reg.driver)) body += `<dl class="kv"><dt>บริษัท</dt><dd>${esc(res.reg.company || "–")}</dd>${res.reg.driver ? `<dt>คนขับ</dt><dd>${esc(res.reg.driver)}</dd>` : ""}</dl>`;
      const checks = (res.unsure || []).map(i => res.text && res.text[i] ? `ตัว "${res.text[i]}"${res.alts && res.alts[i] ? ` (อาจเป็น "${res.alts[i]}")` : ""}` : "").filter(Boolean);
      if (checks.length) body += `<div class="warnline">ตรวจ${checks.join(" และ ")} กับป้ายจริง${res.weak ? " · แก้ได้หลังกด ใช้ค่านี้" : ""}</div>`;
      else if (res.weak) body += `<div class="warnline">อ่านได้ไม่ชัด กด "ใช้ค่านี้" แล้วแก้ในช่องทะเบียนได้</div>`;
      if (!res.reg && res.prov && res.provConf != null && res.provConf < 0.6) body += `<div class="warnline">จังหวัด "${esc(res.prov)}" ยังไม่แน่ใจ ตรวจกับป้าย</div>`;
    } else {
      const last4 = res.kind === "id" ? res.id.slice(-4) : res.passport.slice(-4);
      hits = res.name ? findInsideBy("", "", res.name) : [];
      body = `<div class="t">${res.nameLang === "known" ? "ผู้มาติดต่อเคยมาแล้ว" : `อ่าน${res.kind === "id" ? "บัตร" : "พาสปอร์ต"}ได้แล้ว`}</div><dl class="kv"><dt>ชื่อ</dt><dd>${res.pendingName ? '<span class="spin" style="border-color:#d5e0dc;border-top-color:#08795a"></span>กำลังอ่านชื่อ…' : esc(res.name || "อ่านชื่อไม่ได้ กรอกเองได้")}${res.nameEn ? `<br><small>${esc(res.nameEn)}</small>` : ""}</dd><dt>เลขท้าย</dt><dd>${esc(last4)}${res.nat ? " · " + esc(res.nat) : ""}</dd>${res.company ? `<dt>บริษัท</dt><dd>${esc(res.company)}</dd>` : ""}</dl>${res.kind === "id" && res.nameLang !== "known" && !res.pendingName ? '<div class="warnline" style="background:#e3f2ec;color:#08795a">ตรวจชื่อกับบัตรจริง ครั้งหน้าบัตรใบนี้จะขึ้นชื่อที่ยืนยันแล้วทันที</div>' : ""}`;
    }
    if (hits.length) body += `<div class="warnline">อยู่ในพื้นที่ตั้งแต่ ${tOf(hits[0].inAt)} น. (${dur(hits[0].inAt)})${hits[0].company ? " · " + esc(hits[0].company) : ""}</div>`;
    const btns = [];
    if (hits.length) btns.push(`<button type="button" class="danger" data-lk="exit">บันทึกออกเลย</button>`);
    if (res.kind === "plate" && !hits.length) btns.push(`<button type="button" class="primary" data-lk="next">ใช้ค่านี้ แล้วสแกนบัตรต่อ</button>`);
    btns.push(`<button type="button" class="${hits.length || res.kind !== "plate" ? "primary" : "ghost"}" data-lk="use">ใช้ค่านี้</button>`);
    btns.push(`<button type="button" class="ghost" data-lk="again">อ่านใหม่</button>`);
    p.innerHTML = body + `<div class="btnrow">${btns.join("")}</div>`;
    p.hidden = false;
    p.querySelectorAll("[data-lk]").forEach(b => b.onclick = async () => {
      const a = b.dataset.lk;
      if (a === "again") { setMode(SC.mode); return; }
      if (a === "exit") {
        b.disabled = true;
        try { await recordExit(hits[0]); closeScanner(); clearForm(); toast(`บันทึกออกแล้ว ${hits[0].plate ? parsePlate(hits[0].plate).display : hits[0].name}`); }
        catch { b.disabled = false; toast("บันทึกออกไม่สำเร็จ"); }
        return;
      }
      res.pendingName = false; applyLock(res);
      if (a === "next") setMode("id"); else closeScanner();
    });
  };
  render();
  if (res.kind === "id" && res.pendingName) {
    (async () => {
      res.hash = await idHash(res.id);
      const known = res.hash && S.people.find(p => p.idHash === res.hash);
      if (known && gen === SC.gen && SC.locked === res) { res.pendingName = false; res.name = known.name; res.nameLang = "known"; res.company = known.company; render(); return; }
      const reads = [];
      for (let k = 0; k < 3 && gen === SC.gen; k++) {
        let f = SC.lastId;
        if (k > 0 && SC.stream) { const rect = regionInVideo(); const g2 = rect && Reader.readIdFrame(grab(rect, 1000)); if (g2 && g2.found) f = g2; }
        const n = await readIdNames(f, gen).catch(() => null);
        if (n) reads.push(n);
        const ths = reads.map(r => r.th).filter(Boolean);
        if (ths.length >= 2 && ths.some((t, i) => ths.indexOf(t) !== i)) break;   // same Thai name twice: done
        if (k === 1 && ths.length === 0 && reads.some(r => r.en)) break;
      }
      if (gen !== SC.gen || SC.locked !== res) return;
      const pickMode = arr => { const c = {}; let b = null; for (const x of arr) { c[x] = (c[x] || 0) + 1; if (!b || c[x] > c[b]) b = x; } return b; };
      const th = pickMode(reads.map(r => r.th).filter(Boolean)), en = pickMode(reads.map(r => r.en).filter(Boolean));
      res.pendingName = false; res.name = th || en || ""; res.nameLang = th ? "th" : en ? "en" : ""; res.nameEn = th && en ? en : "";
      render();
    })();
  }
}
function applyLock(res) {
  if (res.kind === "plate") applyPlate({plate: res.plate, prov: res.prov, provConf: res.provConf, reg: res.reg, votes: res.votes, unsure: res.unsure});
  else if (res.kind === "id") { S.idHash = res.hash || ""; applyPersonLock({name: res.name, nameLang: res.nameLang, doc: "บัตรประชาชน", last4: res.id.slice(-4), votes: res.votes, company: res.company}); }
  else applyPersonLock({name: res.name, nameLang: "en", doc: "พาสปอร์ต", last4: res.passport.slice(-4), votes: 1});
}
function lockQr(text) { beep(); guide.classList.add("locked"); setTimeout(() => { closeScanner(); handleQrText(text); }, 250); }

/* ---------- photo fallback ---------- */
let photoKind = "plate";
$("#photoBtn").onclick = () => { $("#photoSheet").hidden = false; };
$("#photoClose").onclick = () => { $("#photoSheet").hidden = true; };
$$("[data-photo]").forEach(b => b.onclick = () => { photoKind = b.dataset.photo; $("#photoSheet").hidden = true; $("#photoFile").value = ""; $("#photoFile").click(); });
async function loadBitmap(file) {
  if (window.createImageBitmap) { try { return await createImageBitmap(file, {imageOrientation: "from-image"}); } catch {} }
  const url = URL.createObjectURL(file); const img = new Image(); img.src = url; await img.decode(); return img;
}
function sub(c, x, y, w, h, maxW) {
  const s = Math.min(1, maxW / w), o = document.createElement("canvas"); o.width = Math.round(w * s); o.height = Math.round(h * s);
  const g = o.getContext("2d"); g.imageSmoothingQuality = "high"; g.drawImage(c, x, y, w, h, 0, 0, o.width, o.height); return o;
}
$("#photoFile").addEventListener("change", async e => {
  const f = e.target.files && e.target.files[0]; if (!f) return;
  scanSummary("กำลังอ่านรูป…", [["", "ใช้เวลาไม่กี่วินาที"]]);
  try {
    const bmp = await loadBitmap(f), s = Math.min(1, 1800 / Math.max(bmp.width, bmp.height));
    const c = document.createElement("canvas"); c.width = Math.round(bmp.width * s); c.height = Math.round(bmp.height * s); c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
    if (photoKind === "qr") { const t = await qrFrom(c, true); if (t) handleQrText(t); else scanSummary("ไม่พบ QR ในรูป", [["w", "ให้ QR อยู่กลางภาพ ไม่เอียง"]]); return; }
    if (photoKind === "passport") {
      let r = null; for (let pass = 0; pass < 3 && !(r && r.passport); pass++) r = await OCR.readPassport(c, {x: 0, y: 0, w: c.width, h: c.height}, pass);
      if (!r || !r.passport) { scanSummary("อ่าน MRZ จากรูปไม่ได้", [["w", "ถ่ายให้แถบตัวอักษร 2 บรรทัดล่างชัด หรือกรอกเอง"]]); return; }
      applyPersonLock({name: r.name || "", nameLang: "en", doc: "พาสปอร์ต", last4: r.passport.slice(-4), votes: 1, src: "photo"}); return;
    }
    await Reader.load("models/");
    const W = c.width, H = c.height;
    // a photo is one frame: read it at several crops/zooms and fuse them like video frames
    const crops = [[0, 0, W, H], [W * .1, H * .1, W * .8, H * .8], [W * .2, H * .25, W * .6, H * .5], [W * .05, H * .2, W * .9, H * .6]];
    if (photoKind === "plate") {
      const pf = new Reader.PlateFusion(knownPlates()); let st = null;
      for (const [x, y, w, h] of crops) st = pf.add(Reader.readPlateFrame(sub(c, x, y, w, h, 640)));
      if (!st || !st.text) { scanSummary("อ่านป้ายจากรูปไม่ได้", [["w", "ถ่ายใกล้ขึ้นให้ป้ายเต็มภาพ หรือกรอกเอง"]]); return; }
      if (st.regLock) applyPlate({plate: Reader.display(normPlate(st.reg.plate), /^\d{6}$/.test(normPlate(st.reg.plate))), prov: st.reg.prov || st.prov, provConf: 1, reg: st.reg, votes: 1, src: "photo"});
      else applyPlate({plate: st.display, prov: st.provConf >= 0.35 ? st.prov : "", provConf: st.provConf, votes: 1, unsure: st.unsure, src: "photo"});
    } else {
      const idf = new Reader.IdFusion(); let st = null, last = null;
      for (const [x, y, w, h] of crops) { const fr = Reader.readIdFrame(sub(c, x, y, w, h, 1000)); if (fr && fr.found) last = fr; st = idf.add(fr && fr.found ? fr : null); }
      if (!st || !st.id) {
        const r = await OCR.readIdCard(c, {x: 0, y: 0, w: W, h: H}, 0); if (r.id) { st = idf.add({text: r.id}); }
      }
      if (!st || !st.id) { scanSummary("อ่านเลขบัตรจากรูปไม่ได้", [["w", "ถ่ายตรง ๆ ให้บัตรเต็มภาพ ไม่มีแสงสะท้อน หรือกรอกเอง"]]); return; }
      S.idHash = await idHash(st.id);
      const known = S.idHash && S.people.find(p => p.idHash === S.idHash);
      if (known) { applyPersonLock({name: known.name, nameLang: "known", company: known.company, doc: "บัตรประชาชน", last4: st.id.slice(-4), votes: 1, src: "photo"}); return; }
      const n = last ? await readIdNames(last, SC.gen).catch(() => null) : null;
      applyPersonLock({name: (n && (n.th || n.en)) || "", nameLang: n && n.th ? "th" : "en", doc: "บัตรประชาชน", last4: st.id.slice(-4), votes: 1, src: "photo"});
    }
  } catch (err) { console.error(err); scanSummary("อ่านรูปไม่สำเร็จ", [["x", "ลองถ่ายใหม่ หรือกรอกเอง"]]); }
});

/* ---------- boot ---------- */
async function countToday() { try { S.todayCount = (await DB.byIndex("visits", "day", S.todayKey)).length; } catch {} renderBadge(); }
async function loadAll() {
  S.inside = (await DB.byIndex("visits", "status", "in")).sort((a, b) => b.inAt.localeCompare(a.inAt));
  S.vehicles = await DB.all("vehicles"); S.people = await DB.all("people"); S.registry = await DB.all("registry");
  const st = await DB.get("meta", "settings");
  S.settings = {companies: (st && st.companies) || [], purposes: (st && st.purposes && st.purposes.length) ? st.purposes : DEFAULT_PURPOSES};
  await countToday();
  renderPurposes(); fillCompanyList(); renderSettings(); renderInside(); renderInsideHit(); renderRegistry();
}
(async () => {
  tick(); renderPurposes(); renderPlatePreview(); renderInside();
  if (!window.indexedDB) { banner("เบราว์เซอร์นี้เก็บข้อมูลไม่ได้", " เปิดด้วย Chrome หรือ Safari และไม่ใช้โหมดไม่ระบุตัวตน"); return; }
  try { await loadAll(); await loadSync(); flushSync(); pullRegistry(false); }
  catch (e) { console.error(e); banner("เปิดฐานข้อมูลในเครื่องไม่ได้", " ปิดโหมดไม่ระบุตัวตน แล้วโหลดหน้าใหม่"); }
  try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch {}
  if (location.protocol === "file:") banner("เปิดจากไฟล์ในเครื่อง", " กล้องสดอาจใช้ไม่ได้ ให้เปิดผ่านลิงก์ https (ดูวิธีในไฟล์ README)");
  if ("serviceWorker" in navigator && location.protocol === "https:") navigator.serviceWorker.register("sw.js").catch(() => {});
  setTimeout(() => Reader.load("models/").catch(() => {}), 1200);
  if (/^#(scan|inside|report|more)$/.test(location.hash)) show(location.hash.slice(1));
})();
