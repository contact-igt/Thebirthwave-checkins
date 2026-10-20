/**
 * End-to-end tests for the isolated check-in app .
 *
 *   npm run build && npm run test:e2e:checkin
 *
 * Nothing in the browser is mocked here. The harness starts:
 *   1. a local HTTPS TEST DOUBLE of the clinic backend (tests/support/fake-backend.mjs,
 *      atomic per-day numbering, idempotency, staff-confirmed queue), and
 *   2. the real check-in build, configured through the same environment variables
 *      a deployment would use (HTTPS store/status/admin URLs, staff accounts).
 * The browser talks only to the real app; the app talks to the backend over TLS.
 * Screenshots go to docs/registration-qa/.
 */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { after, before } from "node:test";
import qrcode from "qrcode-generator";
import { chromium, request as pwRequest } from "playwright-core";
import { createFakeBackend } from "../support/fake-backend.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const SHOTS = join(root, "docs/registration-qa/");
mkdirSync(SHOTS, { recursive: true });
const axeSource = readFileSync(createRequire(import.meta.url).resolve("axe-core/axe.min.js"), "utf8");

const APP_PORT = 3101;
const BACKEND_PORT = 4443;
const BASE = `http://localhost:${APP_PORT}`;
const BACKEND = `https://localhost:${BACKEND_PORT}`;
const STAFF_PASSWORD = "reception-test-pass-1";
const SECRET_NAMES = ["Priya", "Anitha", "Meena", "Divya", "Kavitha", "Lakshmi"];

const VIEWPORTS = [
  { name: "mobile-360", width: 360, height: 740, mobile: true },
  { name: "mobile-390", width: 390, height: 844, mobile: true },
  { name: "tablet-768", width: 768, height: 1024, mobile: true },
  { name: "tablet-1024", width: 1024, height: 768, mobile: true },
  { name: "desktop-1440", width: 1440, height: 900, mobile: false },
];
const DESKTOP = VIEWPORTS[4];
const PHONE = VIEWPORTS[1];

let browser;
let backend;
let backendServer;
let appProcess;
let serverLog = "";
const seenTokens = new Set();
const seenPhones = new Set();

// ------------------------------------------------------------------ harness

before(async () => {
  if (!existsSync(join(root, ".next"))) {
    throw new Error("Run `npm run build` first.");
  }

  const tmp = mkdtempSync(join(tmpdir(), "bw-checkin-"));
  const key = join(tmp, "key.pem");
  const cert = join(tmp, "cert.pem");
  execFileSync("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert, "-days", "1",
    "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1",
  ], { stdio: "ignore" });

  backend = createFakeBackend({ queueLive: true, estimate: { min: 15, max: 30 } });
  backendServer = await backend.listen(BACKEND_PORT, { key: readFileSync(key), cert: readFileSync(cert) });

  const { hashPassword } = await import(new URL("../../src/lib/staff/auth.ts", import.meta.url).href);
  const env = {
    ...process.env,
   
    NEXT_DIST_DIR: ".next",
    NODE_EXTRA_CA_CERTS: cert,
    CLINIC_LOCATION_ID: "main",
    REGISTRATION_ENABLED: "true",
    REGISTRATION_STORE_URL: `${BACKEND}/intake`,
    REGISTRATION_STATUS_URL: `${BACKEND}/status`,
    QUEUE_ADMIN_URL: `${BACKEND}/admin`,
    REGISTRATION_STORE_ALLOWED_HOSTS: "localhost",
    REGISTRATION_STORE_TOKEN: backend.bearer,
    QUEUE_ADMIN_TOKEN: backend.bearer,
    STAFF_CONSOLE_ENABLED: "true",
    STAFF_SESSION_SECRET: "e2e-session-secret-".padEnd(40, "x"),
    STAFF_ACCOUNTS: JSON.stringify([
      { username: "reception1", passwordHash: hashPassword(STAFF_PASSWORD), role: "reception" },
    ]),
  };
  appProcess = spawn("npx", ["next", "start", "-p", String(APP_PORT)], { cwd: root, env });
  appProcess.stdout.on("data", (d) => (serverLog += d));
  appProcess.stderr.on("data", (d) => (serverLog += d));

  for (let i = 0; i < 60; i += 1) {
    try {
      if ((await fetch(`${BASE}/`)).status === 200) break;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 500));
    if (i === 59) throw new Error(`check-in app did not start:\n${serverLog}`);
  }

  browser = await chromium.launch({ channel: "chrome", headless: true });
});

after(async () => {
  await browser?.close();
  appProcess?.kill("SIGTERM");
  await new Promise((resolve) => backendServer?.close(resolve) ?? resolve());
  writeFileSync(join(SHOTS, "checkin-server.log"), serverLog.slice(-4000));
});

// ------------------------------------------------------------------ helpers

async function newPage(viewport = DESKTOP, options = {}) {
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    isMobile: viewport.mobile,
    hasTouch: viewport.mobile,
    deviceScaleFactor: viewport.mobile ? 2 : 1,
    ...options,
  });
  const page = await context.newPage();
  page.setDefaultTimeout(10_000);
  const requests = [];
  page.on("request", (r) => requests.push({ url: r.url(), method: r.method(), body: r.postData() }));
  const apiResponses = [];
  page.on("response", async (response) => {
    if (response.url().endsWith("/api/registrations") && response.request().method() === "POST") {
      try {
        apiResponses.push({ status: response.status(), json: await response.json() });
      } catch {
        // ignore
      }
    }
  });
  return { page, context, requests, apiResponses };
}

let patientCounter = 0;
async function fillAndSubmit(page, { name, url = `${BASE}/`, submit = true } = {}) {
  patientCounter += 1;
  const phone = `98765${String(10000 + patientCounter)}`;
  seenPhones.add(phone);
  await page.goto(url);
  await page.getByRole("button", { name: /Start registration/ }).click();
  await page.locator("#field-fullName").fill(name);
  await page.getByRole("button", { name: /^Continue/ }).click();
  await page.locator("#field-dobDay").fill("14");
  await page.locator("#field-dobMonth").fill("03");
  await page.locator("#field-dobYear").fill("1993");
  await page.locator("label", { has: page.getByText("Female", { exact: true }) }).click();
  await page.getByRole("button", { name: /^Continue/ }).click();
  await page.locator("#field-phone").fill(phone);
  await page.getByRole("button", { name: /^Continue/ }).click();
  await page.locator("#field-addressLine1").fill("12 Lake View Road");
  await page.locator("#field-city").fill("Chennai");
  await page.locator("#field-pin").fill("600020");
  await page.locator("#field-state").selectOption("Tamil Nadu");
  await page.getByRole("button", { name: /^Continue/ }).click();
  await page.locator("label", { has: page.getByText("Pregnancy", { exact: true }) }).click();
  await page.getByRole("button", { name: /^Continue/ }).click();
  await page.locator("label", { has: page.getByText("Google Maps", { exact: true }) }).click();
  await page.getByRole("button", { name: /^Continue/ }).click();
  await page.getByRole("heading", { name: /Review and sign/ }).waitFor();
  await page.locator("#field-consent").check();
  await page.locator("label", { has: page.getByText("Type your name", { exact: true }) }).click();
  await page.locator("#field-signatureTyped").fill(name);
  if (submit) await page.getByRole("button", { name: "Submit registration" }).click();
}

const pad = (n) => String(n).padStart(3, "0");

async function axeViolations(page) {
  await page.evaluate(axeSource);
  const result = await page.evaluate(() =>
    axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] } }),
  );
  return result.violations.map((v) => `${v.id} (${v.impact}): ${v.nodes.map((n) => n.target.join(" ")).join(" | ")}`);
}

const noOverflow = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

async function smallTargets(page) {
  return page.evaluate(() => {
    const bad = [];
    for (const el of document.querySelectorAll("main button, main a[class*=primary], main a[class*=secondary], main select, main input:not([type=checkbox]):not([type=radio])")) {
      const r = el.getBoundingClientRect();
      if (r.width && r.height && (r.height < 43.5 || r.width < 43.5)) bad.push(`${el.tagName.toLowerCase()} "${el.textContent.trim().slice(0, 20)}" ${Math.round(r.width)}x${Math.round(r.height)}`);
    }
    return bad;
  });
}

// -------------------------------------------------------------------- tests

test("the subdomain root opens the check-in experience directly (no redirect)", async () => {
  const { page, context } = await newPage();
  const response = await page.goto(`${BASE}/`);
  assert.equal(response.status(), 200);
  assert.equal(response.request().redirectedFrom(), null, "no redirect");
  assert.equal(new URL(page.url()).pathname, "/");
  await page.getByRole("heading", { name: "Welcome to The Birthwave" }).waitFor();
  await page.getByText("Let’s get you checked in").waitFor();
  await page.getByRole("button", { name: "Start registration" }).waitFor();
  await page.getByText("Clinic Check-in", { exact: true }).waitFor();
  await page.getByText("Your care begins here.").waitFor();
  await context.close();
});

test("website pages, analytics and structured data are absent on the subdomain", async () => {
  const api = await pwRequest.newContext({ baseURL: BASE });
  for (const path of ["/about", "/services", "/services/vbac", "/doctors", "/contact", "/faq", "/privacy", "/terms", "/api/enquiries", "/sitemap.xml"]) {
    assert.equal((await api.get(path)).status(), 404, path);
  }
  const robots = await (await api.get("/robots.txt")).text();
  assert.match(robots, /Disallow: \//);
  assert.equal(robots.includes("Sitemap"), false);

  const home = await api.get("/");
  const html = await home.text();
  for (const banned of [/googletagmanager/i, /gtag\(/, /ld\+json/, /rel="canonical"/, /thebirthwave\.in\/(services|doctors|about)/]) {
    assert.equal(banned.test(html), false, String(banned));
  }
  assert.match(html, /name="robots" content="noindex, nofollow/);
  assert.match(html, /<title>Clinic Check-in \| The Birthwave<\/title>/);
  assert.match(home.headers()["cache-control"], /no-store/);
  assert.equal(home.headers()["referrer-policy"], "no-referrer");
  assert.equal(home.headers()["x-frame-options"], "DENY");
  await api.dispose();
});

test("personal phone: confirmed save opens /thank-you with the backend's real daily number", async () => {
  const { page, context, requests, apiResponses } = await newPage(PHONE);
  const before = backend.snapshot().length;
  await fillAndSubmit(page, { name: "Priya Raman" });
  await page.getByRole("heading", { name: /all checked in/ }).waitFor();

  assert.equal(new URL(page.url()).pathname, "/thank-you");
  assert.match(new URL(page.url()).hash, /^#t=[A-Za-z0-9_-]{22,}$/);
  assert.equal(new URL(page.url()).search, "", "token never in the query string");

  const api = apiResponses.at(-1);
  assert.equal(api.status, 201);
  assert.ok(api.json.sequence >= 1, "number comes from the backend response");
  const stored = backend.snapshot().find((e) => e.id === api.json.id);
  assert.equal(stored.sequence, api.json.sequence, "backend record holds the same number");
  assert.equal(backend.snapshot().length, before + 1);
  seenTokens.add(api.json.token);

  await page.getByText("Registration confirmed", { exact: true }).first().waitFor();
  await page.getByText("Your registration today").waitFor();
  assert.match((await page.getByTestId("registration-number").innerText()).replace(/\s+/g, " "), new RegExp(`No\\. ${pad(api.json.sequence)}`));
  await page.getByText("Successfully registered at The Birthwave.").waitFor();
  await page.getByText(api.json.id).first().waitFor();
  await page.getByText(/Checked in at/).waitFor();
  await page.getByText(new RegExp(`${api.json.dayTotal} registrations? completed today\\.`)).waitFor();

  // truthful fallback: no staff-confirmed queue yet, so no position, countdown or time
  await page.getByText("Waiting time: Our reception team will update you.").waitFor();
  assert.equal(await page.getByText(/patients? ahead of you/).count(), 0);
  assert.equal(await page.getByText(/About \d+–\d+ minutes/).count(), 0);
  await page.getByText("A consultation usually takes around 10–20 minutes. We always take the time needed to listen, understand and care for you.").waitFor();
  await page.getByText("While you’re here").waitFor();
  await page.getByText("Please make yourself comfortable. Our team will call you when it’s time.").waitFor();

  // privacy
  const body = await page.locator("body").innerText();
  for (const secret of ["Priya", "Raman", "98765", "Lake View", "600020", "Pregnancy"]) {
    assert.equal(body.includes(secret), false, `${secret} must not appear on the receipt`);
  }
  assert.deepEqual(await page.evaluate(() => ({ l: localStorage.length, s: sessionStorage.length, c: document.cookie })), { l: 0, s: 0, c: "" });
  const external = requests.filter((r) => !r.url.startsWith(BASE) && !/^(data|blob):/.test(r.url));
  assert.deepEqual(external.map((r) => r.url), [], "no third-party requests");
  assert.equal(requests.some((r) => /googletagmanager|google-analytics|enquiries/.test(r.url)), false);
  assert.equal(requests.some((r) => r.url.includes(api.json.token)), false, "token is never in a request URL");

  // a personal phone is not wiped; refreshing re-reads the status from the backend
  await page.reload();
  await page.getByRole("heading", { name: /all checked in/ }).waitFor();
  assert.match((await page.getByTestId("registration-number").innerText()).replace(/\s+/g, " "), new RegExp(`No\\. ${pad(api.json.sequence)}`));
  const afterReload = requests.filter((r) => r.url.endsWith("/api/queue/status"));
  assert.ok(afterReload.length >= 1);
  assert.ok(afterReload.every((r) => r.method === "POST" && r.body.includes(api.json.token)), "token travels in the POST body only");

  await page.getByRole("button", { name: "Done" }).click();
  await page.getByRole("heading", { name: /Thank you for visiting/ }).waitFor();
  assert.equal(new URL(page.url()).hash, "", "Done clears the token from the address bar");
  await context.close();
});

test("a failed save never opens the thank-you page and keeps the answers", async () => {
  const { page, context } = await newPage(PHONE);
  const before = backend.snapshot().length;
  backend.failNext(1);
  await fillAndSubmit(page, { name: "Kavitha Nair" });
  await page.getByRole("alert").filter({ hasText: "couldn’t save" }).waitFor();
  assert.equal(new URL(page.url()).pathname, "/", "still on the registration screen");
  assert.equal(await page.getByRole("heading", { name: /all checked in/ }).count(), 0);
  assert.equal(backend.snapshot().length, before);
  await page.getByText("Kavitha Nair").first().waitFor();

  await page.getByRole("button", { name: "Try again" }).click();
  await page.getByRole("heading", { name: /all checked in/ }).waitFor();
  assert.equal(new URL(page.url()).pathname, "/thank-you");
  assert.equal(backend.snapshot().length, before + 1, "exactly one record after the retry");
  await context.close();
});

test("duplicate requests cannot create duplicate registrations or inflate the count", async () => {
  const api = await pwRequest.newContext({ baseURL: BASE, extraHTTPHeaders: { origin: BASE } });
  const before = backend.snapshot().length;
  const payload = {
    idempotencyKey: "dup-0000-1111-2222-3333-444455556666",
    fullName: "Lakshmi Devi", dobDay: "01", dobMonth: "02", dobYear: "1990", gender: "female",
    phone: "9876500001", altPhone: "", email: "", addressLine1: "1 Test Road", addressLine2: "", city: "Chennai",
    state: "Tamil Nadu", pin: "600001", concerns: ["fertility"], sources: ["doctor"], sourceOther: "",
    consent: true, signatureMethod: "typed", signatureData: "", signatureTyped: "Lakshmi Devi", website: "",
  };
  const replies = await Promise.all(Array.from({ length: 5 }, () => api.post("/api/registrations", { data: payload })));
  const bodies = await Promise.all(replies.map((r) => r.json()));
  assert.ok(replies.every((r) => r.status() === 201));
  assert.equal(new Set(bodies.map((b) => b.sequence)).size, 1);
  assert.equal(new Set(bodies.map((b) => b.id)).size, 1);
  for (const b of bodies) if (b.token) seenTokens.add(b.token);
  const again = await (await api.post("/api/registrations", { data: payload })).json();
  assert.equal(again.sequence, bodies[0].sequence);
  assert.equal(backend.snapshot().length, before + 1);

  const next = await (await api.post("/api/registrations", { data: { ...payload, idempotencyKey: "dup-9999-1111-2222-3333-444455556666", fullName: "Lakshmi Devi" } })).json();
  assert.equal(next.sequence, bodies[0].sequence + 1, "the retries consumed no numbers");
  if (next.token) seenTokens.add(next.token);

  // cross-origin and malformed requests are refused
  const evil = await pwRequest.newContext({ baseURL: BASE, extraHTTPHeaders: { origin: "https://evil.example" } });
  assert.equal((await evil.post("/api/registrations", { data: payload })).status(), 403);
  assert.equal((await api.post("/api/registrations", { data: { ...payload, idempotencyKey: "x" } })).status(), 400);
  await api.dispose();
  await evil.dispose();

  // double-clicking Submit in the UI stores one record
  const { page, context } = await newPage(PHONE);
  const count = backend.snapshot().length;
  await fillAndSubmit(page, { name: "Divya Menon", submit: false });
  await page.getByRole("button", { name: "Submit registration" }).dblclick();
  await page.getByRole("heading", { name: /all checked in/ }).waitFor();
  assert.equal(backend.snapshot().length, count + 1);
  await context.close();
});

test("staff console: sign-in, queue updates and the patient's status stay in step", async () => {
  // start from an empty queue: earlier tests left patients who are genuinely still "registered"
  for (const entry of backend.snapshot()) {
    await backend.handle("/admin", { action: "update", id: entry.id, state: "completed" }, `Bearer ${backend.bearer}`);
  }

  // two patients register on their own phones
  const a = await newPage(PHONE);
  await fillAndSubmit(a.page, { name: "Anitha Kumar" });
  await a.page.getByRole("heading", { name: /all checked in/ }).waitFor();
  const seqA = a.apiResponses.at(-1).json.sequence;
  seenTokens.add(a.apiResponses.at(-1).json.token);

  const m = await newPage(PHONE);
  await fillAndSubmit(m.page, { name: "Meena Raj" });
  await m.page.getByRole("heading", { name: /all checked in/ }).waitFor();
  const seqM = m.apiResponses.at(-1).json.sequence;
  seenTokens.add(m.apiResponses.at(-1).json.token);
  assert.equal(seqM, seqA + 1);

  // protected: nothing without a session
  const anon = await pwRequest.newContext({ baseURL: BASE, extraHTTPHeaders: { origin: BASE } });
  assert.equal((await anon.get("/api/staff/queue")).status(), 401);
  assert.equal((await anon.post("/api/staff/queue", { data: { id: "x", state: "waiting" } })).status(), 401);
  await anon.dispose();

  const staff = await newPage(DESKTOP);
  await staff.page.goto(`${BASE}/staff`);
  await staff.page.getByRole("heading", { name: "Reception sign-in" }).waitFor();
  await staff.page.locator("#staff-username").fill("reception1");
  await staff.page.locator("#staff-password").fill("wrong-password");
  await staff.page.getByRole("button", { name: "Sign in" }).click();
  await staff.page.getByRole("alert").filter({ hasText: "weren’t recognised" }).waitFor();
  await staff.page.locator("#staff-password").fill(STAFF_PASSWORD);
  await staff.page.getByRole("button", { name: "Sign in" }).click();
  await staff.page.getByRole("heading", { name: "Today’s queue" }).waitFor();

  const cookie = (await staff.context.cookies()).find((c) => c.name === "__Host-bw_staff");
  assert.ok(cookie);
  assert.equal(cookie.httpOnly, true);
  assert.equal(cookie.secure, true);
  assert.equal(cookie.sameSite, "Strict");
  await staff.page.screenshot({ path: `${SHOTS}checkin-staff-queue.png` });

  const rowOf = (name) => staff.page.locator("li", { hasText: name }).filter({ has: staff.page.getByRole("combobox") });
  await rowOf("Anitha").waitFor();
  await rowOf("Meena").waitFor();
  const move = async (name, label) => {
    await rowOf(name).getByRole("button", { name: label, exact: true }).click();
    await staff.page.waitForResponse((r) => r.url().endsWith("/api/staff/queue") && r.request().method() === "GET");
  };
  await move("Anitha", "Checked in");
  await move("Anitha", "Waiting");
  await move("Meena", "Checked in");
  await move("Meena", "Waiting");

  // Meena refreshes: real queue, one patient ahead — and her registration number is a different thing
  await m.page.getByRole("button", { name: "Refresh my status" }).waitFor();
  await m.page.getByRole("button", { name: "Refresh my status" }).click();
  await m.page.getByText("1 patient ahead of you").waitFor();
  await m.page.getByText("About 15–30 minutes").waitFor();
  await m.page.getByText(/This is approximate\. It can change with clinical priorities/).waitFor();
  assert.match((await m.page.getByTestId("registration-number").innerText()).replace(/\s+/g, " "), new RegExp(`No\\. ${pad(seqM)}`));
  await m.page.getByText(/Last updated \d{1,2}:\d{2} (am|pm)/).waitFor();
  await m.page.locator("p[class*=guidance]", { hasText: "Please wait to be called." }).waitFor();
  await m.page.screenshot({ path: `${SHOTS}checkin-waiting-live-queue.png`, fullPage: true });

  // Anitha is called → she is told to go to reception; Meena becomes next
  await move("Anitha", "Called");
  await a.page.getByRole("button", { name: "Refresh my status" }).click();
  await a.page.locator("p[class*=guidance]", { hasText: /proceed to reception/i }).waitFor();
  await m.page.getByRole("button", { name: "Refresh my status" }).click();
  await m.page.getByText("You’re next").waitFor();

  await move("Anitha", "In consultation");
  await move("Anitha", "Completed");
  await a.page.getByRole("button", { name: "Refresh my status" }).click();
  await a.page.locator("p[class*=guidance]", { hasText: /Your visit is complete/ }).waitFor();

  await staff.page.getByRole("button", { name: "Sign out" }).click();
  await staff.page.getByRole("heading", { name: "Reception sign-in" }).waitFor();
  const after = await staff.page.evaluate(() => fetch("/api/staff/queue").then((r) => r.status));
  assert.equal(after, 401, "session is gone after sign-out");
  await Promise.all([a.context.close(), m.context.close(), staff.context.close()]);
});

test("shared clinic tablet: card + private QR link, then a safe automatic reset", async () => {
  const { page, context, apiResponses } = await newPage(DESKTOP);
  await page.clock.install();
  await fillAndSubmit(page, { name: "Divya Menon", url: `${BASE}/?kiosk=1` });
  await page.getByRole("heading", { name: /all checked in/ }).waitFor();
  const reply = apiResponses.at(-1).json;
  seenTokens.add(reply.token);
  assert.equal(new URL(page.url()).pathname, "/thank-you");
  assert.equal(new URL(page.url()).search, "?kiosk=1");

  await page.getByRole("heading", { name: "Continue on your phone" }).waitFor();
  await page.getByText(/clears for the next patient in \d+ seconds/).waitFor();
  const qr = page.locator('svg[aria-label^="QR code"]');
  await qr.waitFor();
  // the QR encodes exactly the private status link — token only, no personal data
  const expected = qrcode(0, "M");
  expected.addData(`${BASE}/thank-you#t=${reply.token}`);
  expected.make();
  const n = expected.getModuleCount();
  let d = "";
  for (let r = 0; r < n; r += 1) for (let c = 0; c < n; c += 1) if (expected.isDark(r, c)) d += `M${c + 4} ${r + 4}h1v1h-1z`;
  assert.equal(await qr.locator("path").nth(0).getAttribute("d"), d);
  assert.equal((await page.locator("body").innerText()).includes("Divya"), false);
  await page.waitForTimeout(1000);
  await page.screenshot({ path: `${SHOTS}checkin-thank-you-kiosk.png`, fullPage: true });

  await page.clock.fastForward(46_000);
  await page.getByRole("heading", { name: /Welcome to The Birthwave/ }).waitFor();
  assert.equal(new URL(page.url()).pathname, "/");
  assert.equal(new URL(page.url()).search, "?kiosk=1");
  assert.equal(page.url().includes(reply.token), false);
  await page.goBack().catch(() => {});
  assert.equal(page.url().includes(reply.token), false, "the receipt token is not reachable from history");
  await context.close();
});

test("without a receipt or with a bad link the page shows a safe fallback, never an invented number", async () => {
  for (const hash of ["", "#t=short", "#t=AAAAAAAAAAAAAAAAAAAAAAAA", "#x=1"]) {
    const { page, context } = await newPage(PHONE);
    await page.goto(`${BASE}/thank-you${hash}`);
    await page.getByRole("heading", { name: /We can’t show this/ }).waitFor();
    assert.equal(await page.getByTestId("registration-number").count(), 0, hash);
    assert.equal(await page.getByRole("heading", { name: /all checked in/ }).count(), 0, hash);
    await page.getByRole("link", { name: /\+91 93630 31925/ }).waitFor();
    await context.close();
  }
});

for (const viewport of VIEWPORTS) {
  test(`thank-you page @ ${viewport.name}: layout, accessibility, targets, screenshots`, async () => {
    const { page, context, apiResponses } = await newPage(viewport);
    await fillAndSubmit(page, { name: SECRET_NAMES[VIEWPORTS.indexOf(viewport) % SECRET_NAMES.length] + " Test" });
    await page.getByRole("heading", { name: /all checked in/ }).waitFor();
    seenTokens.add(apiResponses.at(-1).json.token);
    await page.waitForTimeout(1600); // let the heartbeat finish drawing
    assert.ok(await noOverflow(page), "no horizontal overflow");
    assert.deepEqual(await smallTargets(page), []);
    const violations = await axeViolations(page);
    assert.deepEqual(violations, [], violations.join("\n"));
    await page.screenshot({ path: `${SHOTS}checkin-thank-you-${viewport.name}.png`, fullPage: true });

    // header: logo, label, date, assistance
    await page.getByText("Clinic Check-in", { exact: true }).waitFor();
    await page.getByRole("button", { name: "Need assistance?" }).click();
    await page.getByRole("link", { name: /\+91 93630 31925/ }).first().waitFor();
    await context.close();
  });
}

test("thank-you: keyboard order, focus on the heading, reduced motion", async () => {
  const { page, context } = await newPage(DESKTOP, { reducedMotion: "reduce" });
  await fillAndSubmit(page, { name: "Priya Keyboard" });
  await page.getByRole("heading", { name: /all checked in/ }).waitFor();
  assert.equal(await page.evaluate(() => document.activeElement?.tagName), "H1");
  const stops = [];
  for (let i = 0; i < 6; i += 1) {
    await page.keyboard.press("Tab");
    stops.push(await page.evaluate(() => document.activeElement?.textContent?.trim().slice(0, 30)));
  }
  assert.ok(stops.includes("Need assistance?"));
  assert.ok(stops.some((t) => /Refresh|Done|\+91/.test(t ?? "")), `reachable controls: ${stops.join(" | ")}`);
  const motion = await page.evaluate(() => ({
    line: getComputedStyle(document.querySelector("svg path[class*=heartbeatLine]")).animationName,
    card: getComputedStyle(document.querySelector("section[class*=card]")).animationName,
  }));
  assert.deepEqual(motion, { line: "none", card: "none" });
  await context.close();
});

test("check-in header and welcome screens at every size", async () => {
  for (const viewport of VIEWPORTS) {
    const { page, context } = await newPage(viewport);
    await page.goto(`${BASE}/`);
    await page.getByRole("button", { name: /Start registration/ }).waitFor();
    await page.waitForTimeout(300);
    assert.ok(await noOverflow(page), `${viewport.name} overflow`);
    const violations = await axeViolations(page);
    assert.deepEqual(violations, [], violations.join("\n"));
    await page.screenshot({ path: `${SHOTS}checkin-welcome-${viewport.name}.png` });
    await page.getByRole("button", { name: /Start registration/ }).click();
    await page.locator("#field-fullName").fill("Header Check");
    await page.waitForTimeout(300);
    await page.getByText(/Step 1 of 7 · 13%/).waitFor();
    await page.screenshot({ path: `${SHOTS}checkin-step1-${viewport.name}.png` });
    await context.close();
  }
});

test("no patient information reached the server logs", () => {
  for (const name of SECRET_NAMES) assert.equal(serverLog.includes(name), false, `log contains ${name}`);
  for (const phone of seenPhones) assert.equal(serverLog.includes(phone), false, "log contains a phone number");
  for (const token of seenTokens) assert.equal(serverLog.includes(token), false, "log contains a receipt token");
  for (const text of ["Lake View", "600020", "Raman", "Menon"]) assert.equal(serverLog.includes(text), false, text);
});
