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
    const r = indexedDB.open("oiltex-yard", 1);
    r.onupgradeneeded = () => {
      const d = r.result;
      const v = d.createObjectStore("visits", {keyPath: "id"}); v.createIndex("status", "status"); v.createIndex("day", "day");
      d.createObjectStore("vehicles", {keyPath: "key"}); d.createObjectStore("people", {keyPath: "key"}); d.createObjectStore("meta", {keyPath: "k"});
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
    putMany: (n, vs) => write(n, s => vs.forEach(v => s.put(v))),
    delMany: (n, ks) => write(n, s => ks.forEach(k => s.delete(k)))
  };
})();

/* ---------- state ---------- */
const S = {inside: [], vehicles: [], people: [], settings: {companies: [], purposes: DEFAULT_PURPOSES}, todayKey: dayKey(), todayCount: 0,
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
  S.people.forEach(p => p.company && set.add(p.company)); S.vehicles.forEach(v => v.company && set.add(v.company));
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
  S.src = {plate: "manual", person: "manual"}; S.warnAck = "";
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
    if (pKey) { const per = {key: pKey, name, company, doc: visit.doc, idLast4: visit.idLast4, vKey, lastSeen: visit.inAt}; await DB.put("people", per); upsertLocal(S.people, per); }
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
  const data = {app: "oiltex-yard", version: 1, exportedAt: new Date().toISOString(), visits: await DB.all("visits"), vehicles: await DB.all("vehicles"), people: await DB.all("people"), settings: S.settings};
  download(`oiltex-yard-backup_${dayKey()}.json`, JSON.stringify(data), "application/json");
};
$("#btnRestore").onclick = () => { $("#restoreFile").value = ""; $("#restoreFile").click(); };
$("#restoreFile").addEventListener("change", async e => {
  const f = e.target.files && e.target.files[0]; if (!f) return;
  try {
    const d = JSON.parse(await f.text());
    if (d.app !== "oiltex-yard" || !Array.isArray(d.visits)) throw new Error("bad");
    await DB.putMany("visits", d.visits); await DB.putMany("vehicles", d.vehicles || []); await DB.putMany("people", d.people || []);
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

/* ---------- applying scan results to the form ---------- */
function applyPlate(lock) {
  const prov = lock.prov ? snapProvince(lock.prov) : {value: "", ok: false};
  $("#fPlate").value = lock.plate; flash($("#fPlate"));
  $("#fProv").value = prov.value; if (prov.value) flash($("#fProv"));
  $("#fPlate").classList.toggle("warnf", !parsePlate(lock.plate).ok);
  $("#fProv").classList.toggle("warnf", !prov.value);
  S.src.plate = lock.src || "scan";
  const checks = [["", lock.votes > 1 ? `อ่านตรงกัน ${lock.votes} ครั้งจากกล้องสด` : "อ่านจากรูปถ่าย"], parsePlate(lock.plate).ok ? ["", "รูปแบบทะเบียนถูกต้อง"] : ["w", "รูปแบบทะเบียนไม่ตรงมาตรฐาน ตรวจกับป้ายจริง"],
    prov.value ? ["", `จังหวัด ${prov.value}`] : ["w", "อ่านจังหวัดไม่ได้ เลือกเองจากรายการ"]];
  const known = S.vehicles.find(v => normPlate(v.plate) === normPlate(lock.plate));
  if (known) { checks.push(["", `รถเคยเข้า${known.company ? ": " + known.company : ""}`]); if (!$("#fCo").value && known.company) setField("#fCo", known.company); if (!prov.value && known.prov) { $("#fProv").value = known.prov; $("#fProv").classList.remove("warnf"); } }
  renderPlatePreview(); renderSuggestions();
  scanSummary("อ่านป้ายทะเบียนแล้ว", checks);
}
function applyPersonLock(lock) {
  const checks = [];
  if (lock.name) { $("#fName").value = lock.name; flash($("#fName")); } else checks.push(["w", "อ่านชื่อไม่ได้ กรอกชื่อเอง"]);
  $("#fDoc").value = lock.doc; if (lock.last4) { $("#fIdl").value = lock.last4; flash($("#fIdl")); }
  S.src.person = lock.src || "scan";
  if (lock.doc === "พาสปอร์ต") checks.unshift(["", "เลขพาสปอร์ตผ่านการตรวจ MRZ"]);
  else checks.unshift(["", `เลขบัตร 13 หลักผ่านการตรวจ${lock.votes > 1 ? ` (ตรงกัน ${lock.votes} ครั้ง)` : ""}`]);
  if (lock.name && lock.nameLang === "en") checks.push(["w", "ใช้ชื่อภาษาอังกฤษจากบัตร แก้เป็นภาษาไทยได้"]);
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
const SC = {stream: null, track: null, mode: "plate", gen: 0, pass: 0, hist: [], provWait: 0, idv: null, locked: null, audio: null, ready: {}};
const HINT = {plate: "วางป้ายทะเบียนให้อยู่ในกรอบ", id: "วางด้านหน้าบัตรให้เต็มกรอบ", passport: "ให้แถบตัวอักษร 2 บรรทัดล่างอยู่ในกรอบเส้นประ", qr: "ส่อง QR บัตรผ่านให้อยู่ในกรอบ"};
const SUB = {plate: "ถือนิ่ง ๆ ให้ป้ายเต็มกรอบ ใช้ซูมถ้ารถอยู่ไกล · กลางคืนเปิดไฟ", id: "วางบัตรบนพื้นเรียบ เอียงเล็กน้อยหลบแสงสะท้อน", passport: "เปิดหน้าที่มีรูป วางให้เรียบ", qr: "ห่างประมาณ 1 คืบ ลดความสว่างจอที่แสดง QR ถ้าจ้าเกิน"};
const LANGS = {plate: ["tha"], id: ["eng", "tha"], passport: ["eng"], qr: []};
let barcodeDetector = null;
try { if ("BarcodeDetector" in window) barcodeDetector = new BarcodeDetector({formats: ["qr_code"]}); } catch {}

function live(v, sub, frac) {
  $("#scLive").textContent = v; if (sub != null) $("#scSub").textContent = sub;
  if (frac != null) $("#scMeter").style.width = Math.round(Math.max(0, Math.min(1, frac)) * 100) + "%";
}
function ensureAudio() { try { if (!SC.audio) SC.audio = new (window.AudioContext || window.webkitAudioContext)(); if (SC.audio.state === "suspended") SC.audio.resume(); } catch {} }
function beep() {
  try { const a = SC.audio, o = a.createOscillator(), g = a.createGain(); o.frequency.value = 1046; g.gain.setValueAtTime(0.0001, a.currentTime); g.gain.exponentialRampToValueAtTime(0.35, a.currentTime + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, a.currentTime + 0.16); o.connect(g).connect(a.destination); o.start(); o.stop(a.currentTime + 0.18); } catch {}
  try { navigator.vibrate && navigator.vibrate(90); } catch {}
}
function warm(mode) { for (const l of LANGS[mode]) OCR.worker(l).then(() => SC.ready[l] = true).catch(() => {}); }

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
  SC.mode = m; SC.gen++; SC.pass = 0; SC.hist = []; SC.provWait = 0; SC.idv = {ids: [], en: [], th: []}; SC.locked = null;
  guide.className = "guide " + m;
  $("#scHint").textContent = HINT[m];
  $$("#modes button").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.mode === m)));
  $("#lockPanel").hidden = true; $("#scRead").hidden = false; $("#modes").hidden = false;
  live(m === "qr" ? "กำลังหา QR…" : "กำลังอ่าน…", SUB[m], 0);
  warm(m);
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
  if (caps.focusMode && caps.focusMode.includes("continuous")) SC.track.applyConstraints({advanced: [{focusMode: "continuous"}]}).catch(() => {});
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
  const pad = {plate: 0.12, id: 0.04, passport: 0.04, qr: 0.12}[SC.mode];
  let x = (g.left - r.left - ox) / s, y = (g.top - r.top - oy) / s, w = g.width / s, h = g.height / s;
  x -= w * pad; y -= h * pad; w *= 1 + pad * 2; h *= 1 + pad * 2;
  x = Math.max(0, x); y = Math.max(0, y); w = Math.min(vw - x, w); h = Math.min(vh - y, h);
  return {x, y, w, h};
}
const grabC = document.createElement("canvas");
function grab(rect, maxW = 1600) {
  const s = Math.min(1, maxW / rect.w);
  grabC.width = Math.round(rect.w * s); grabC.height = Math.round(rect.h * s);
  grabC.getContext("2d", {willReadFrequently: true}).drawImage(video, rect.x, rect.y, rect.w, rect.h, 0, 0, grabC.width, grabC.height);
  const c = document.createElement("canvas"); c.width = grabC.width; c.height = grabC.height; c.getContext("2d").drawImage(grabC, 0, 0);
  return c;
}
async function qrFrom(canvas, both) {
  if (barcodeDetector) { try { const r = await barcodeDetector.detect(canvas); if (r && r[0]) return r[0].rawValue; } catch {} }
  const d = canvas.getContext("2d", {willReadFrequently: true}).getImageData(0, 0, canvas.width, canvas.height);
  const r = jsQR(d.data, canvas.width, canvas.height, {inversionAttempts: both ? "attemptBoth" : "dontInvert"});
  return r ? r.data : null;
}
async function runLoop() {
  const gen = ++SC.gen;
  await sleep(200);
  while (gen === SC.gen && SC.stream && !SC.locked) {
    if (video.readyState < 2 || !video.videoWidth) { await sleep(120); continue; }
    const rect = regionInVideo(); if (!rect) { await sleep(120); continue; }
    try {
      if (SC.mode === "qr") {
        const t = await qrFrom(grab(rect, 900), SC.pass++ % 3 === 2);
        if (gen !== SC.gen) return;
        if (t) { lockQr(t); return; }
        await sleep(70); continue;
      }
      const need = LANGS[SC.mode].filter(l => !SC.ready[l]);
      if (need.length) live("กำลังเตรียมตัวอ่าน…", "ครั้งแรกใช้เวลาไม่กี่วินาที ครั้งต่อไปเปิดได้ทันที", 0.02);
      const img = grab(rect), box = {x: 0, y: 0, w: img.width, h: img.height};
      const r = SC.mode === "plate" ? await OCR.readPlate(img, box, SC.pass) : SC.mode === "id" ? await OCR.readIdCard(img, box, SC.pass) : await OCR.readPassport(img, box, SC.pass);
      SC.pass++;
      if (gen !== SC.gen) return;
      if (SC.mode === "plate") votePlate(r); else if (SC.mode === "id") voteId(r); else votePassport(r);
    } catch (e) { console.error(e); live("อ่านไม่สำเร็จ กำลังลองใหม่…", null, null); await sleep(400); }
  }
}
function votePlate(r) {
  if (!r.plate) { live(SC.hist.length ? SC.hist[SC.hist.length - 1].plate : "กำลังหาป้าย…", SUB.plate, SC.hist.length ? null : 0.05); return; }
  const k = normPlate(r.plate);
  SC.hist.push({k, plate: r.plate, prov: r.prov}); if (SC.hist.length > 8) SC.hist.shift();
  const same = SC.hist.filter(h => h.k === k), known = S.vehicles.some(v => normPlate(v.plate) === k) || S.inside.some(v => normPlate(v.plate) === k);
  const need = known ? 2 : 3;
  const provs = same.map(h => h.prov).filter(Boolean), prov = modeOf(provs);
  live(`${r.plate}${prov ? "  " + prov : ""}`, `อ่านตรงกัน ${same.length}/${need} ครั้ง${prov ? "" : " · กำลังอ่านจังหวัด"}`, same.length / need);
  if (same.length >= need) {
    if (!prov && SC.provWait++ < 3) return;  // give the province a few more frames
    lockResult({kind: "plate", plate: r.plate, prov: prov || "", votes: same.length});
  }
}
function voteId(r) {
  const v = SC.idv;
  if (r.id) v.ids.push(r.id); if (r.en) v.en.push(r.en); if (r.th) v.th.push(r.th);
  const top = modeOf(v.ids), n = top ? v.ids.filter(x => x === top).length : 0;
  if (!top) { live("กำลังหาเลขบัตร 13 หลัก…", SUB.id, 0.05); return; }
  const th = modeOf(v.th), en = modeOf(v.en);
  live(`•••• ••••• ${top.slice(9, 11)} ${top[12]}`, (th || en) ? `ชื่อ: ${th || en}` : "เลขบัตรผ่านการตรวจ · กำลังอ่านชื่อ…", Math.min(1, n / 2 * 0.7 + ((th || en) ? 0.3 : 0)));
  if (n >= 2 && (th || (en && SC.pass >= 3) || SC.pass >= 6)) lockResult({kind: "id", id: top, name: th || en || "", nameLang: th ? "th" : en ? "en" : "", votes: n});
}
function votePassport(r) {
  if (!r.passport) { live("กำลังหาแถบ MRZ…", SUB.passport, 0.05); return; }
  lockResult({kind: "passport", passport: r.passport, name: r.name || "", nat: r.nat || "", votes: 1});
}
function lockResult(res) {
  SC.locked = res; SC.gen++;
  guide.classList.add("locked"); beep();
  $("#scRead").hidden = true; $("#modes").hidden = true;
  const p = $("#lockPanel");
  let body = "", hits = [];
  if (res.kind === "plate") {
    hits = findInsideBy(res.plate, res.prov, "");
    body = `<div class="t">อ่านป้ายได้แล้ว</div><div style="display:flex;justify-content:center">${plateHTML(res.plate, res.prov || "จังหวัด ?")}</div>`;
  } else {
    const last4 = res.kind === "id" ? res.id.slice(-4) : res.passport.slice(-4);
    hits = res.name ? findInsideBy("", "", res.name) : [];
    body = `<div class="t">อ่าน${res.kind === "id" ? "บัตร" : "พาสปอร์ต"}ได้แล้ว</div><dl class="kv"><dt>ชื่อ</dt><dd>${esc(res.name || "อ่านชื่อไม่ได้ กรอกเองได้")}</dd><dt>เลขท้าย</dt><dd>${esc(last4)}${res.nat ? " · " + esc(res.nat) : ""}</dd></dl>`;
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
    applyLock(res);
    if (a === "next") setMode("id"); else closeScanner();
  });
}
function applyLock(res) {
  if (res.kind === "plate") applyPlate(res);
  else if (res.kind === "id") applyPersonLock({name: res.name, nameLang: res.nameLang, doc: "บัตรประชาชน", last4: res.id.slice(-4), votes: res.votes});
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
$("#photoFile").addEventListener("change", async e => {
  const f = e.target.files && e.target.files[0]; if (!f) return;
  scanSummary("กำลังอ่านรูป…", [["", "ใช้เวลาไม่กี่วินาที"]]);
  try {
    const bmp = await loadBitmap(f), s = Math.min(1, 1800 / Math.max(bmp.width, bmp.height));
    const c = document.createElement("canvas"); c.width = Math.round(bmp.width * s); c.height = Math.round(bmp.height * s); c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
    const box = {x: 0, y: 0, w: c.width, h: c.height};
    if (photoKind === "qr") { const t = await qrFrom(c, true); if (t) handleQrText(t); else scanSummary("ไม่พบ QR ในรูป", [["w", "ให้ QR อยู่กลางภาพ ไม่เอียง"]]); return; }
    const found = [];
    for (let pass = 0; pass < 4; pass++) {
      const r = photoKind === "plate" ? await OCR.readPlate(c, box, pass) : photoKind === "id" ? await OCR.readIdCard(c, box, pass) : await OCR.readPassport(c, box, pass);
      found.push(r);
      if (photoKind === "passport" && r.passport) break;
    }
    if (photoKind === "plate") {
      const plates = found.map(r => r.plate).filter(Boolean);
      if (!plates.length) { scanSummary("อ่านป้ายจากรูปไม่ได้", [["w", "ถ่ายใกล้ขึ้นให้ป้ายเต็มภาพ หรือกรอกเอง"]]); return; }
      const plate = modeOf(plates), prov = modeOf(found.filter(r => r.plate === plate).map(r => r.prov).filter(Boolean)) || "";
      applyPlate({plate, prov, votes: 1, src: "photo"});
    } else if (photoKind === "id") {
      const id = modeOf(found.map(r => r.id).filter(Boolean));
      if (!id) { scanSummary("อ่านเลขบัตรจากรูปไม่ได้", [["w", "ถ่ายตรง ๆ ให้บัตรเต็มภาพ ไม่มีแสงสะท้อน หรือกรอกเอง"]]); return; }
      const th = modeOf(found.map(r => r.th).filter(Boolean)), en = modeOf(found.map(r => r.en).filter(Boolean));
      applyPersonLock({name: th || en || "", nameLang: th ? "th" : "en", doc: "บัตรประชาชน", last4: id.slice(-4), votes: 1, src: "photo"});
    } else {
      const r = found.find(x => x.passport);
      if (!r) { scanSummary("อ่าน MRZ จากรูปไม่ได้", [["w", "ถ่ายให้แถบตัวอักษร 2 บรรทัดล่างชัด หรือกรอกเอง"]]); return; }
      applyPersonLock({name: r.name || "", nameLang: "en", doc: "พาสปอร์ต", last4: r.passport.slice(-4), votes: 1, src: "photo"});
    }
  } catch (err) { console.error(err); scanSummary("อ่านรูปไม่สำเร็จ", [["x", "ลองถ่ายใหม่ หรือกรอกเอง"]]); }
});

/* ---------- boot ---------- */
async function countToday() { try { S.todayCount = (await DB.byIndex("visits", "day", S.todayKey)).length; } catch {} renderBadge(); }
async function loadAll() {
  S.inside = (await DB.byIndex("visits", "status", "in")).sort((a, b) => b.inAt.localeCompare(a.inAt));
  S.vehicles = await DB.all("vehicles"); S.people = await DB.all("people");
  const st = await DB.get("meta", "settings");
  S.settings = {companies: (st && st.companies) || [], purposes: (st && st.purposes && st.purposes.length) ? st.purposes : DEFAULT_PURPOSES};
  await countToday();
  renderPurposes(); fillCompanyList(); renderSettings(); renderInside(); renderInsideHit();
}
(async () => {
  tick(); renderPurposes(); renderPlatePreview(); renderInside();
  if (!window.indexedDB) { banner("เบราว์เซอร์นี้เก็บข้อมูลไม่ได้", " เปิดด้วย Chrome หรือ Safari และไม่ใช้โหมดไม่ระบุตัวตน"); return; }
  try { await loadAll(); await loadSync(); flushSync(); }
  catch (e) { console.error(e); banner("เปิดฐานข้อมูลในเครื่องไม่ได้", " ปิดโหมดไม่ระบุตัวตน แล้วโหลดหน้าใหม่"); }
  try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch {}
  if (location.protocol === "file:") banner("เปิดจากไฟล์ในเครื่อง", " กล้องสดอาจใช้ไม่ได้ ให้เปิดผ่านลิงก์ https (ดูวิธีในไฟล์ README)");
  if ("serviceWorker" in navigator && location.protocol === "https:") navigator.serviceWorker.register("sw.js").catch(() => {});
  setTimeout(() => warm("plate"), 2500);
  if (/^#(scan|inside|report|more)$/.test(location.hash)) show(location.hash.slice(1));
})();
