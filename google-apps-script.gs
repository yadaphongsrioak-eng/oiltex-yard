/**
 * OIL-TEX Yard — รับข้อมูลเข้า–ออกจากเว็บแอป แล้วเขียนลง Google Sheets
 * วิธีติดตั้ง (ทำครั้งเดียว):
 * 1) สร้าง Google Sheet ใหม่ > ส่วนขยาย > Apps Script
 * 2) ลบโค้ดเดิม วางโค้ดนี้ทั้งหมด แล้วกดบันทึก
 * 3) กด "การทำให้ใช้งานได้" (Deploy) > การทำให้ใช้งานได้รายการใหม่ > ประเภท: เว็บแอป
 *    - ดำเนินการในฐานะ: ฉัน
 *    - ผู้ที่มีสิทธิ์เข้าถึง: ทุกคน (Anyone)
 * 4) คัดลอกลิงก์ที่ลงท้ายด้วย /exec ไปวางในแอป: แท็บ QR/ตั้งค่า > ส่งข้อมูลขึ้น Google Sheets
 * ทุกรายการมีรหัส (id) ไม่ซ้ำ ส่งซ้ำได้โดยไม่เกิดแถวซ้ำ ตอนบันทึกออกจะอัปเดตแถวเดิม
 */
const SHEET_NAME = "Visits";
const HEAD = ["id", "วันที่", "เวลาเข้า", "เวลาออก", "สถานะ", "ทะเบียน", "จังหวัด", "ชื่อ", "เอกสาร", "เลขท้าย",
  "บริษัท", "จำนวนคน", "วัตถุประสงค์", "หมายเหตุ", "จุดตรวจเข้า", "จุดตรวจออก", "ที่มาข้อมูล", "inAt (ISO)", "outAt (ISO)", "อัปเดตล่าสุด"];

function doPost(e) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const body = JSON.parse(e.postData.contents);
    if (body.action === "ping") return out({ok: true});
    if (body.action !== "upsert" || !Array.isArray(body.rows)) return out({ok: false, error: "bad request"});
    const sh = sheet_();
    const n = Math.max(sh.getLastRow() - 1, 0);
    const ids = n ? sh.getRange(2, 1, n, 1).getValues().map(r => String(r[0])) : [];
    body.rows.forEach(r => {
      const row = [r.id, r.day, r.inTime, r.outTime, r.status, r.plate, r.prov, r.name, r.doc, r.idLast4 ? "'" + r.idLast4 : "",
        r.company, r.pax, r.purpose, r.note, r.gate, r.outGate, r.src, r.inAt, r.outAt, new Date()];
      const i = ids.indexOf(String(r.id));
      if (i >= 0) sh.getRange(i + 2, 1, 1, row.length).setValues([row]);
      else { sh.appendRow(row); ids.push(String(r.id)); }
    });
    return out({ok: true, n: body.rows.length});
  } catch (err) {
    return out({ok: false, error: String(err)});
  } finally {
    lock.releaseLock();
  }
}

function doGet() { return out({ok: true, message: "OIL-TEX Yard sync is running"}); }

function sheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(SHEET_NAME);
  if (!sh) { sh = ss.insertSheet(SHEET_NAME); sh.appendRow(HEAD); sh.setFrozenRows(1); sh.getRange(1, 1, 1, HEAD.length).setFontWeight("bold"); }
  return sh;
}

function out(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }
