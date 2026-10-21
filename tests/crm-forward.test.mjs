import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

const payload = await import(new URL("../src/lib/crm/payload.ts", import.meta.url).href);
const forward = await import(new URL("../src/lib/crm/forward.ts", import.meta.url).href);

const SECRET = "s".repeat(40);

const record = {
  registrationDate: "2026-10-20",
  fullName: "Test Patient",
  dateOfBirth: "1995-03-07",
  gender: "female",
  phone: "+919876543210",
  email: "test@example.com",
  address: { line1: "1 Test Road", city: "Chennai", state: "Tamil Nadu", pin: "600034" },
  concerns: ["pregnancy"],
  sources: ["google_search"],
  consent: true,
  signature: { method: "drawn", imagePng: "data:image/png;base64,AAAA" },
  flags: { guardianReviewRequired: false, typedSignaturePendingClinicApproval: false },
};

test("lead event is filed under Clinic registrations and never carries the signature", () => {
  const event = payload.buildLeadEvent({
    reference: "BW-20261020-0001",
    clinicId: "main",
    clinicDate: "2026-10-20",
    session: "evening",
    registeredAt: "2026-10-20T08:00:00.000Z",
    record,
  });
  assert.equal(event.reference, "BW-20261020-0001");
  assert.equal(event.session, "evening");
  assert.equal(event.lead.category, "Clinic registrations");
  assert.equal(event.lead.source, "clinic_registration");
  assert.equal(event.lead.phone, "+919876543210");
  assert.equal(/signature|imagePng|base64/i.test(JSON.stringify(event)), false);
});

test("CRM config needs an https URL without credentials and a 32+ character secret", () => {
  const ok = { CRM_INTAKE_URL: "https://crm.example.com/birthwave/leads/intake", CRM_SHARED_SECRET: SECRET };
  assert.ok(forward.crmConfigFromEnv(ok));
  assert.equal(forward.crmConfigFromEnv({}), null);
  assert.equal(forward.crmConfigFromEnv({ ...ok, CRM_SHARED_SECRET: "short" }), null);
  assert.equal(forward.crmConfigFromEnv({ ...ok, CRM_INTAKE_URL: "http://crm.example.com/x" }), null);
  assert.equal(forward.crmConfigFromEnv({ ...ok, CRM_INTAKE_URL: "https://user:pw@crm.example.com/x" }), null);
  assert.equal(forward.crmConfigFromEnv({ ...ok, CRM_INTAKE_URL: "not a url" }), null);
});

test("signature is HMAC-SHA256 over timestamp.body", () => {
  const expected = `sha256=${crypto.createHmac("sha256", SECRET).update("123.{\"a\":1}").digest("hex")}`;
  assert.equal(forward.signBody(SECRET, "123", '{"a":1}'), expected);
  assert.notEqual(forward.signBody(SECRET, "124", '{"a":1}'), expected);
});

test("retry delay backs off and is capped at one hour", () => {
  assert.equal(forward.retryDelayMs(1), 30_000);
  assert.equal(forward.retryDelayMs(2), 60_000);
  assert.equal(forward.retryDelayMs(3), 120_000);
  assert.equal(forward.retryDelayMs(30), 3_600_000);
});

test("bearer check is constant-shape and rejects missing or short secrets", () => {
  assert.equal(forward.bearerMatches(`Bearer ${SECRET}`, SECRET), true);
  assert.equal(forward.bearerMatches(`Bearer wrong`, SECRET), false);
  assert.equal(forward.bearerMatches(null, SECRET), false);
  assert.equal(forward.bearerMatches("Bearer x", undefined), false);
  assert.equal(forward.bearerMatches("Bearer short", "short"), false);
});

function fakePool(rows) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql, params });
      return /RETURNING id, registration_id/.test(sql) ? { rows } : { rows: [] };
    },
  };
}

const config = { url: new URL("https://crm.example.com/birthwave/leads/intake"), secret: SECRET };
const outboxRow = (n) => ({ id: n, registration_id: `BW-20261020-000${n}`, payload: { reference: `BW-20261020-000${n}` }, attempts: 1 });

test("dispatch signs each lead, sends an idempotency key and marks 2xx and 409 delivered", async () => {
  const pool = fakePool([outboxRow(1), outboxRow(2)]);
  const seen = [];
  const statuses = [201, 409];
  const result = await forward.dispatchPending(pool, config, async (url, init) => {
    seen.push({ url: String(url), init });
    return new Response("{}", { status: statuses.shift() });
  });
  assert.deepEqual(result, { sent: 2, failed: 0 });
  assert.equal(seen[0].init.headers["Idempotency-Key"], "BW-20261020-0001");
  const { "X-Birthwave-Timestamp": ts, "X-Birthwave-Signature": sig } = seen[0].init.headers;
  assert.equal(sig, forward.signBody(SECRET, ts, seen[0].init.body));
  assert.equal(seen[0].init.redirect, "error");
  assert.equal(pool.calls.filter((c) => /SET delivered_at/.test(c.sql)).length, 2);
});

test("failures are kept for retry and store only a status or error name", async () => {
  const pool = fakePool([outboxRow(1), outboxRow(2)]);
  let n = 0;
  const result = await forward.dispatchPending(pool, config, async () => {
    n += 1;
    if (n === 1) return new Response("{}", { status: 500 });
    throw new TypeError("fetch failed for https://crm.example.com Test Patient");
  });
  assert.deepEqual(result, { sent: 0, failed: 2 });
  const stored = pool.calls.filter((c) => /SET last_error/.test(c.sql)).map((c) => c.params[1]);
  assert.deepEqual(stored, ["http_500", "TypeError"]);
  assert.equal(pool.calls.some((c) => /delivered_at = NOW\(\)/.test(c.sql)), false);
});
