import assert from "node:assert/strict";
import test from "node:test";

const rules = await import(new URL("../src/lib/registration/rules.ts", import.meta.url).href);
const receipt = await import(new URL("../src/lib/registration/receipt.ts", import.meta.url).href);

// IST = UTC+5:30, so 08:30Z is 14:00 IST.
const at = (iso) => new Date(iso);

test("before 2 pm IST is the morning OP, from 2 pm it is the evening OP", () => {
  assert.equal(rules.opSessionIST(at("2026-10-21T00:00:00Z")), "morning"); // 05:30 IST
  assert.equal(rules.opSessionIST(at("2026-10-21T08:29:59Z")), "morning"); // 13:59:59 IST
  assert.equal(rules.opSessionIST(at("2026-10-21T08:30:00Z")), "evening"); // 14:00:00 IST
  assert.equal(rules.opSessionIST(at("2026-10-21T14:00:00Z")), "evening"); // 19:30 IST
});

test("the session follows IST, not UTC, around midnight", () => {
  assert.equal(rules.opSessionIST(at("2026-10-20T18:29:00Z")), "evening"); // 23:59 IST
  assert.equal(rules.opSessionIST(at("2026-10-20T18:30:00Z")), "morning"); // 00:00 IST next day
});

test("the evening start can be moved, and a bad value falls back to 14:00", () => {
  assert.equal(rules.opSessionIST(at("2026-10-21T08:00:00Z"), "13:30"), "evening"); // 13:30 IST
  assert.equal(rules.opSessionIST(at("2026-10-21T07:59:00Z"), "13:30"), "morning");
  assert.equal(rules.opSessionIST(at("2026-10-21T08:29:00Z"), "nonsense"), "morning");
  assert.equal(rules.opSessionIST(at("2026-10-21T08:30:00Z"), "25:99"), "evening");
});

test("session labels and reference codes", () => {
  assert.equal(rules.OP_SESSION_LABEL.morning, "Morning OP");
  assert.equal(rules.OP_SESSION_LABEL.evening, "Evening OP");
  assert.equal(rules.OP_SESSION_CODE.morning, "M");
  assert.equal(rules.OP_SESSION_CODE.evening, "E");
  assert.equal(rules.isOpSession("morning"), true);
  assert.equal(rules.isOpSession("night"), false);
});

test("receipts keep a valid session next to a number that is provably today, and drop junk", () => {
  const ctx = { clinicId: "main", now: at("2026-10-21T10:00:00Z") };
  const body = {
    ok: true,
    id: "BW-20261021-E-0003",
    sequence: 3,
    dayTotal: 3,
    checkedInAt: "2026-10-21T09:00:00.000Z",
    clinicDate: "2026-10-21",
    clinicId: "main",
  };
  assert.equal(receipt.parseSaveResponse({ ...body, session: "evening" }, ctx).session, "evening");
  assert.equal(receipt.parseSaveResponse({ ...body, session: "night" }, ctx).session, undefined);
  assert.equal(receipt.parseSaveResponse(body, ctx).session, undefined);
  assert.equal(receipt.parseSaveResponse({ ...body, session: "evening", clinicDate: "2026-10-20" }, ctx).session, undefined);
});
