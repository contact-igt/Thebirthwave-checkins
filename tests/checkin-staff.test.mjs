import assert from "node:assert/strict";
import test from "node:test";
import { createFakeBackend } from "./support/fake-backend.mjs";

const auth = await import(new URL("../src/lib/staff/auth.ts", import.meta.url).href);
const { createStaffHandlers } = await import(new URL("../src/lib/staff/handlers.ts", import.meta.url).href);
const { createAdminClient } = await import(new URL("../src/lib/staff/admin.ts", import.meta.url).href);
const { createRegistrationHandler } = await import(new URL("../src/lib/registration/handler.ts", import.meta.url).href);
const { createStoreFromEnv, createStatusClientFromEnv } = await import(new URL("../src/lib/registration/store.ts", import.meta.url).href);
const { createStatusHandler } = await import(new URL("../src/lib/registration/status-handler.ts", import.meta.url).href);
const { createRateLimiter } = await import(new URL("../src/lib/registration/rate-limit.ts", import.meta.url).href);

const ORIGIN = "http://localhost:3000";
const SECRET = "s".repeat(40);
const NOW = new Date("2026-10-20T08:00:00Z");

const recep = auth.hashPassword("reception-pass-1");
const clin = auth.hashPassword("clinician-pass-2");
const baseEnv = (backend) => ({
  STAFF_CONSOLE_ENABLED: "true",
  STAFF_SESSION_SECRET: SECRET,
  STAFF_ACCOUNTS: JSON.stringify([
    { username: "reception1", passwordHash: recep, role: "reception" },
    { username: "doctor1", passwordHash: clin, role: "clinician" },
  ]),
  QUEUE_ADMIN_URL: "https://backend.test/admin",
  QUEUE_ADMIN_TOKEN: backend.bearer,
  REGISTRATION_ENABLED: "true",
  REGISTRATION_STORE_URL: "https://backend.test/intake",
  REGISTRATION_STATUS_URL: "https://backend.test/status",
  REGISTRATION_STORE_ALLOWED_HOSTS: "backend.test",
  REGISTRATION_STORE_TOKEN: backend.bearer,
});

// ---- configuration gates ----------------------------------------------------

test("staff console is off unless every gate is configured, ", () => {
  const backend = createFakeBackend();
  const env = baseEnv(backend);
  assert.ok(auth.loadStaffConfig(env, backend.fetch));
  for (const drop of ["STAFF_CONSOLE_ENABLED", "STAFF_SESSION_SECRET", "STAFF_ACCOUNTS", "QUEUE_ADMIN_URL", "QUEUE_ADMIN_TOKEN"]) {
    assert.equal(auth.loadStaffConfig({ ...env, [drop]: "" }, backend.fetch), null, drop);
  }
  assert.equal(auth.loadStaffConfig({ ...env, STAFF_SESSION_SECRET: "short" }, backend.fetch), null);
  assert.equal(auth.loadStaffConfig({ ...env, STAFF_ACCOUNTS: "not json" }, backend.fetch), null);
  assert.equal(auth.loadStaffConfig({ ...env, STAFF_ACCOUNTS: JSON.stringify([{ username: "x", passwordHash: "plain", role: "reception" }]) }, backend.fetch), null);
  assert.equal(auth.loadStaffConfig({ ...env, STAFF_ACCOUNTS: JSON.stringify([{ username: "ab", passwordHash: recep, role: "admin" }]) }, backend.fetch), null);
  assert.equal(auth.loadStaffConfig({ ...env, QUEUE_ADMIN_URL: "https://script.google.com/macros/s/x/exec" }, backend.fetch), null);
});

test("passwords are stored as salted scrypt hashes and compared safely", () => {
  assert.match(recep, /^scrypt\$\d+\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+$/);
  assert.notEqual(auth.hashPassword("reception-pass-1"), recep, "fresh salt every time");
  assert.equal(auth.verifyPassword("reception-pass-1", recep), true);
  assert.equal(auth.verifyPassword("reception-pass-2", recep), false);
  assert.equal(auth.verifyPassword("", recep), false);
  assert.equal(auth.verifyPassword("x", "garbage"), false);
});

test("sessions are signed, expire and cannot be forged", () => {
  const cookie = auth.signSession({ username: "reception1", role: "reception" }, SECRET, NOW, 3600);
  assert.deepEqual(auth.verifySession(cookie, SECRET, NOW), { username: "reception1", role: "reception" });
  assert.equal(auth.verifySession(cookie, "t".repeat(40), NOW), null, "wrong secret");
  assert.equal(auth.verifySession(cookie, SECRET, new Date(NOW.getTime() + 3601_000)), null, "expired");
  const [body, sig] = cookie.split(".");
  const forged = Buffer.from(JSON.stringify({ username: "reception1", role: "clinician", exp: 9e12 })).toString("base64url");
  assert.equal(auth.verifySession(`${forged}.${sig}`, SECRET, NOW), null, "payload swap");
  assert.equal(auth.verifySession(`${body}.${sig.slice(0, -2)}AA`, SECRET, NOW), null, "bad signature");
  for (const junk of ["", "a", "a.b", "...", undefined]) assert.equal(auth.verifySession(junk, SECRET, NOW), null);
});

// ---- handlers -----------------------------------------------------------------

function setup(over = {}) {
  const backend = createFakeBackend({ now: () => NOW, queueLive: true, ...over });
  const env = baseEnv(backend);
  const config = auth.loadStaffConfig(env, backend.fetch);
  const admin = createAdminClient(env, backend.fetch);
  const handlers = createStaffHandlers({ config, admin, now: () => NOW, clinicId: "main", loginLimiter: createRateLimiter({ limit: 5, windowMs: 600_000, now: () => 0 }) });
  const store = createStoreFromEnv(env, backend.fetch);
  const register = createRegistrationHandler({ store, now: () => NOW, clinicId: "main" });
  const statusClient = createStatusClientFromEnv(env, backend.fetch);
  const status = createStatusHandler({ client: statusClient, now: () => NOW });
  return { backend, handlers, register, status };
}

const req = (path, body, { method = "POST", headers = {}, cookie } = {}) =>
  new Request(`${ORIGIN}${path}`, {
    method,
    headers: { "content-type": "application/json", origin: ORIGIN, "x-forwarded-for": "198.51.100.4", ...(cookie ? { cookie } : {}), ...headers },
    ...(method === "GET" ? {} : { body: JSON.stringify(body) }),
  });

const login = async (handlers, username = "reception1", password = "reception-pass-1", headers = {}) => {
  const res = await handlers.login(req("/api/staff/login", { username, password }, { headers }));
  const setCookie = res.headers.get("set-cookie");
  return { res, cookie: setCookie ? setCookie.split(";")[0] : undefined, setCookie };
};

const patient = (n) => ({
  idempotencyKey: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
  fullName: "Priya Raman", dobDay: "14", dobMonth: "03", dobYear: "1993", gender: "female",
  phone: "9876543210", altPhone: "", email: "", addressLine1: "12 Lake View Road", addressLine2: "", city: "Chennai",
  state: "Tamil Nadu", pin: "600020", concerns: ["pregnancy"], sources: ["doctor"], sourceOther: "",
  consent: true, signatureMethod: "typed", signatureData: "", signatureTyped: "Priya Raman", website: "",
});

test("login sets a locked-down session cookie; bad credentials all look the same", async () => {
  const { handlers } = setup();
  const ok = await login(handlers);
  assert.equal(ok.res.status, 200);
  assert.match(ok.setCookie, /HttpOnly/i);
  assert.match(ok.setCookie, /Secure/i);
  assert.match(ok.setCookie, /SameSite=Strict/i);
  assert.match(ok.setCookie, /Path=\//);
  assert.match(ok.setCookie, /Max-Age=\d+/);
  assert.match(ok.setCookie, /^__Host-bw_staff=/);
  assert.equal(ok.res.headers.get("cache-control"), "no-store");
  const wrong = await login(handlers, "reception1", "nope");
  const unknown = await login(handlers, "nobody", "nope");
  assert.equal(wrong.res.status, 401);
  assert.equal(unknown.res.status, 401);
  assert.equal(await wrong.res.text(), await unknown.res.text(), "no username enumeration");
  assert.equal(wrong.setCookie, null);
});

test("login is same-origin only and rate limited", async () => {
  const { handlers } = setup();
  assert.equal((await login(handlers, "reception1", "reception-pass-1", { origin: "https://evil.example" })).res.status, 403);
  for (let i = 0; i < 5; i += 1) assert.equal((await login(handlers, "reception1", "wrong")).res.status, 401);
  const blocked = await login(handlers, "reception1", "reception-pass-1");
  assert.equal(blocked.res.status, 429);
  assert.equal(blocked.cookie, undefined);
});

test("queue needs a valid session: none, forged and expired are refused", async () => {
  const { handlers } = setup();
  assert.equal((await handlers.listQueue(req("/api/staff/queue", null, { method: "GET" }))).status, 401);
  assert.equal((await handlers.listQueue(req("/api/staff/queue", null, { method: "GET", cookie: "__Host-bw_staff=abc.def" }))).status, 401);
  const expired = auth.signSession({ username: "reception1", role: "reception" }, SECRET, new Date(NOW.getTime() - 10 * 3600_000), 60);
  assert.equal((await handlers.listQueue(req("/api/staff/queue", null, { method: "GET", cookie: `__Host-bw_staff=${expired}` }))).status, 401);
  const wrongSecret = auth.signSession({ username: "reception1", role: "reception" }, "z".repeat(40), NOW, 3600);
  assert.equal((await handlers.listQueue(req("/api/staff/queue", null, { method: "GET", cookie: `__Host-bw_staff=${wrongSecret}` }))).status, 401);
});

test("reception sees today's queue and moves a patient through the states; the patient's status follows", async () => {
  const { handlers, register, status, backend } = setup();
  const r1 = await (await register(req("/api/registrations", patient(1)))).json();
  const r2 = await (await register(req("/api/registrations", patient(2)))).json();
  const { cookie } = await login(handlers);

  const list = await (await handlers.listQueue(req("/api/staff/queue", null, { method: "GET", cookie }))).json();
  assert.equal(list.ok, true);
  assert.deepEqual(list.entries.map((e) => [e.sequence, e.state]), [[1, "registered"], [2, "registered"]]);
  assert.equal(list.entries[0].displayName, "Priya");
  assert.deepEqual(Object.keys(list.entries[0]).sort(), ["checkedInAt", "displayName", "id", "reference", "sequence", "state", "updatedAt"]);

  for (const state of ["checked_in", "waiting"]) {
    const up = await handlers.updateQueue(req("/api/staff/queue", { id: r2.id, state }, { cookie }));
    assert.equal(up.status, 200);
  }
  const mine = (await (await status(req("/api/queue/status", { token: r2.token }))).json()).status;
  assert.equal(mine.state, "waiting");
  assert.equal(mine.queue.ahead, 1, "patient 1 is still ahead");
  assert.equal(mine.sequence, 2);
  await handlers.updateQueue(req("/api/staff/queue", { id: r1.id, state: "completed" }, { cookie }));
  const after = (await (await status(req("/api/queue/status", { token: r2.token }))).json()).status;
  assert.equal(after.queue.ahead, 0);
  assert.ok(backend.calls.admin >= 4);
});

test("updates are validated, same-origin and role-restricted", async () => {
  const { handlers, register } = setup();
  const r = await (await register(req("/api/registrations", patient(1)))).json();
  const reception = (await login(handlers)).cookie;
  const doctor = (await login(handlers, "doctor1", "clinician-pass-2", { "x-forwarded-for": "198.51.100.77" })).cookie;
  assert.ok(doctor);
  const bad = (body, cookie, headers) => handlers.updateQueue(req("/api/staff/queue", body, { cookie, headers }));
  assert.equal((await bad({ id: r.id, state: "vip" }, reception)).status, 400);
  assert.equal((await bad({ id: "", state: "waiting" }, reception)).status, 400);
  assert.equal((await bad({ id: r.id, state: "waiting" }, undefined)).status, 401);
  assert.equal((await bad({ id: r.id, state: "waiting" }, reception, { origin: "https://evil.example" })).status, 403);
  assert.equal((await bad({ id: r.id, state: "registered" }, doctor)).status, 403, "clinicians cannot rewind check-in states");
  assert.equal((await bad({ id: r.id, state: "called" }, doctor)).status, 200);
  assert.equal((await bad({ id: r.id, state: "in_consultation" }, doctor)).status, 200);
});

test("logout clears the cookie; unconfigured console answers 503/404 and never lists anything", async () => {
  const { handlers } = setup();
  const res = await handlers.logout(req("/api/staff/logout", {}));
  assert.match(res.headers.get("set-cookie"), /Max-Age=0/);
  const off = createStaffHandlers({ config: null, admin: null, now: () => NOW, clinicId: "main" });
  assert.equal((await off.login(req("/api/staff/login", { username: "a", password: "b" }))).status, 503);
  assert.equal((await off.listQueue(req("/api/staff/queue", null, { method: "GET" }))).status, 503);
});

test("admin client keeps only whitelisted fields from the backend", async () => {
  const backend = createFakeBackend({ now: () => NOW });
  const env = baseEnv(backend);
  const admin = createAdminClient(env, async () =>
    new Response(JSON.stringify({ ok: true, entries: [{ id: "A1", reference: "BW-1", sequence: 1, displayName: "Priya", state: "waiting", phone: "+91999", concerns: ["x"], checkedInAt: "2026-10-20T07:00:00Z" }, { id: "bad", state: "nope" }] }), { status: 200 }),
  );
  const out = await admin.list("main", "2026-10-20");
  assert.equal(out.length, 1, "invalid entries are dropped");
  assert.equal("phone" in out[0], false);
  assert.equal("concerns" in out[0], false);
});
