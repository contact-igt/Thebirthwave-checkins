/**
 * End-to-end checks for /registration against a running build.
 *
 *   npm run build && npx next start -p 3100 &
 *   BASE_URL=http://localhost:3100 npm run test:e2e
 *
 * Uses system Chrome through playwright-core (no browser download).
 * The success path mocks /api/registrations at the network layer ONLY inside
 * these tests; the application itself contains no mock-success code.
 * Screenshots are written to docs/registration-qa/.
 */
import assert from "node:assert/strict";
import { mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import test, { after, before } from "node:test";
import { chromium } from "playwright-core";

const BASE = process.env.BASE_URL ?? "http://localhost:3100";
const URL_REG = `${BASE}/registration`;
const SHOTS = fileURLToPath(new URL("../../docs/registration-qa/", import.meta.url));
mkdirSync(SHOTS, { recursive: true });
const axeSource = readFileSync(createRequire(import.meta.url).resolve("axe-core/axe.min.js"), "utf8");

const VIEWPORTS = [
  { name: "mobile-360", width: 360, height: 740, mobile: true },
  { name: "mobile-390", width: 390, height: 844, mobile: true },
  { name: "tablet-768", width: 768, height: 1024, mobile: true },
  { name: "tablet-1024", width: 1024, height: 768, mobile: true },
  { name: "desktop-1440", width: 1440, height: 900, mobile: false },
];

const DATA = {
  name: "Priya Raman",
  day: "14",
  month: "03",
  year: "1993",
  phone: "98765 43210",
  email: "priya@example.com",
  line1: "12, Lake View Road",
  line2: "Adyar",
  city: "Chennai",
  state: "Tamil Nadu",
  pin: "600020",
};

let browser;
before(async () => {
  browser = await chromium.launch({ channel: "chrome", headless: true });
});
after(async () => {
  await browser?.close();
});

async function newPage(viewport = VIEWPORTS[4], options = {}) {
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    isMobile: viewport.mobile,
    hasTouch: viewport.mobile,
    deviceScaleFactor: viewport.mobile ? 2 : 1,
    ...options,
  });
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  const requests = [];
  page.on("request", (request) => requests.push({ url: request.url(), method: request.method() }));
  const consoleErrors = [];
  page.on("console", (message) => {
    if (["error", "warning"].includes(message.type())) consoleErrors.push(message.text());
  });
  return { page, context, requests, consoleErrors };
}

// --- step drivers ---------------------------------------------------------

/** A choice card / segmented option, found by its exact visible title. */
const card = (page, title) => page.locator("label", { has: page.getByText(title, { exact: true }) });

const start = async (page) => {
  await page.goto(URL_REG);
  await page.getByRole("button", { name: /Start registration/ }).click();
};
const next = (page) => page.getByRole("button", { name: /^Continue/ }).click();

const steps = {
  async name(page) {
    await page.locator("#field-fullName").fill(DATA.name);
  },
  async birth(page) {
    await page.locator("#field-dobDay").fill(DATA.day);
    await page.locator("#field-dobMonth").fill(DATA.month);
    await page.locator("#field-dobYear").fill(DATA.year);
    await card(page, "Female").click();
  },
  async contact(page) {
    await page.locator("#field-phone").fill(DATA.phone);
    await page.locator("#field-email").fill(DATA.email);
  },
  async address(page) {
    await page.locator("#field-addressLine1").fill(DATA.line1);
    await page.locator("#field-addressLine2").fill(DATA.line2);
    await page.locator("#field-city").fill(DATA.city);
    await page.locator("#field-pin").fill(DATA.pin);
    await page.locator("#field-state").selectOption(DATA.state);
  },
  async concerns(page) {
    await card(page, "Pregnancy").click();
    await card(page, "Fertility").click();
  },
  async sources(page) {
    await card(page, "Google Maps").click();
    await card(page, "Instagram").click();
  },
};
const STEP_NAMES = Object.keys(steps);

async function gotoReview(page, hooks = {}) {
  await start(page);
  for (const name of STEP_NAMES) {
    await steps[name](page);
    await hooks[name]?.(page);
    await next(page);
  }
  await page.getByRole("heading", { name: /Review and sign/ }).waitFor();
}

const typeSignature = async (page) => {
  await card(page, "Type your name").click();
  await page.locator("#field-signatureTyped").fill(DATA.name);
};

async function drawSignature(page) {
  const box = await page.locator("#signature-canvas").boundingBox();
  await page.mouse.move(box.x + 20, box.y + 90);
  await page.mouse.down();
  for (let i = 1; i <= 14; i += 1) {
    await page.mouse.move(box.x + 20 + i * 14, box.y + 90 + Math.sin(i) * 30, { steps: 2 });
  }
  await page.mouse.up();
}

async function axeViolations(page) {
  await page.evaluate(axeSource);
  const result = await page.evaluate(() =>
    axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] } }),
  );
  return result.violations.map((v) => `${v.id} (${v.impact}): ${v.nodes.map((n) => n.target.join(" ")).join(" | ")}`);
}

/** Titles must wrap between words, never inside one ("Facebo/ok"). */
async function midWordBreaks(page) {
  return page.evaluate(() =>
    [...document.querySelectorAll("[class*=optionTitle]")]
      .filter((el) => {
        const before = el.style.overflowWrap;
        el.style.overflowWrap = "normal";
        const overflows = el.scrollWidth > el.clientWidth + 1;
        el.style.overflowWrap = before;
        return overflows;
      })
      .map((el) => el.textContent),
  );
}

async function noHorizontalOverflow(page) {
  return page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
}

async function smallTargets(page) {
  return page.evaluate(() => {
    const bad = [];
    const check = (el, label) => {
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;
      if (rect.height < 44 - 0.5 || rect.width < 44 - 0.5) bad.push(`${label} ${Math.round(rect.width)}x${Math.round(rect.height)}`);
    };
    for (const el of document.querySelectorAll("main button, main select, main input:not([type=checkbox]):not([type=radio])")) {
      check(el, el.tagName.toLowerCase() + (el.id ? `#${el.id}` : ""));
    }
    for (const el of document.querySelectorAll("main label")) {
      if (el.querySelector("input[type=checkbox], input[type=radio]")) check(el, `label "${el.textContent.trim().slice(0, 24)}"`);
    }
    return bad;
  });
}

// ---------------------------------------------------------------------------

test("welcome screen: brand, copy, logo and primary action", async () => {
  const { page, context } = await newPage();
  await page.goto(URL_REG);
  await page.getByRole("heading", { name: "Welcome to The Birthwave" }).waitFor();
  await page.getByText("Let’s get you checked in").waitFor();
  await page.getByText("This will take just a few minutes.").waitFor();
  await page.getByRole("button", { name: "Start registration" }).waitFor();
  const logo = await page.locator('img[src*="wordmark-cream"]').evaluate((img) => img.naturalWidth);
  assert.ok(logo > 500, "official cream wordmark loads on desktop");
  assert.match(await page.title(), /Registration \| The Birthwave/);
  const robots = await page.locator('meta[name="robots"]').getAttribute("content");
  assert.match(robots, /noindex/);
  assert.match(robots, /nofollow/);
  await context.close();
});

for (const viewport of VIEWPORTS) {
  test(`responsive walk-through @ ${viewport.name}: layout, targets, axe, screenshots`, async () => {
    const { page, context } = await newPage(viewport);
    const problems = [];
    const record = async (label) => {
      assert.ok(await noHorizontalOverflow(page), `${label}: horizontal overflow`);
      const broken = await midWordBreaks(page);
      if (broken.length) problems.push(`${label}: mid-word breaks in ${broken.join(", ")}`);
      const small = await smallTargets(page);
      if (small.length) problems.push(`${label}: small targets ${small.join(", ")}`);
      const violations = await axeViolations(page);
      if (violations.length) problems.push(`${label}: axe ${violations.join(" || ")}`);
      await page.screenshot({ path: `${SHOTS}${viewport.name}-${label}.png` });
    };

    await page.goto(URL_REG);
    await page.getByRole("button", { name: /Start registration/ }).waitFor();
    await page.waitForTimeout(400);
    await record("00-welcome");

    // Split layout only from 1024px
    const split = await page.evaluate(() => {
      const brand = document.querySelector("aside").getBoundingClientRect();
      const main = document.querySelector("main").getBoundingClientRect();
      return { brandWidth: brand.width, mainLeft: main.left, vw: window.innerWidth };
    });
    if (viewport.width >= 1024) {
      const ratio = split.brandWidth / split.vw;
      assert.ok(ratio > 0.4 && ratio < 0.44, `brand panel ~42% (got ${ratio.toFixed(3)})`);
      assert.ok(split.mainLeft >= split.brandWidth - 1);
    } else {
      assert.equal(split.brandWidth, 0, "brand panel is hidden when stacked");
      assert.equal(await page.locator('img[src*="consultation2"]').isVisible(), false, "photo hidden when stacked");
      assert.equal(await page.locator('img[alt="The Birthwave"]').isVisible(), true, "compact official logo shown in the clinic header");
    }

    await page.getByRole("button", { name: /Start registration/ }).click();
    let index = 1;
    for (const name of STEP_NAMES) {
      await page.waitForTimeout(350);
      if (name === "name") {
        const box = await page.locator("#field-fullName").boundingBox();
        assert.ok(box.y + box.height <= viewport.height, "first input is above the fold");
      }
      await record(`${String(index).padStart(2, "0")}-${name}-empty`);
      await steps[name](page);
      await next(page);
      index += 1;
    }
    await page.getByRole("heading", { name: /Review and sign/ }).waitFor();
    await page.waitForTimeout(350);
    await typeSignature(page);
    await record(`${String(index).padStart(2, "0")}-review-typed`);
    await page.screenshot({ path: `${SHOTS}${viewport.name}-${String(index).padStart(2, "0")}-review-full.png`, fullPage: true });

    await card(page, "Draw signature").click();
    await drawSignature(page);
    await page.waitForTimeout(100);
    await page.screenshot({ path: `${SHOTS}${viewport.name}-${String(index + 1).padStart(2, "0")}-review-drawn.png` });

    assert.deepEqual(problems, [], problems.join("\n"));
    await context.close();
  });
}

test("keyboard-only path completes every step to the review screen", async () => {
  const { page, context } = await newPage();
  await page.goto(URL_REG);
  await page.keyboard.press("Tab"); // skip link
  await page.keyboard.press("Tab"); // Need assistance?
  await page.keyboard.press("Tab"); // Start registration
  const focused = await page.evaluate(() => document.activeElement?.textContent);
  assert.match(focused, /Start registration/);
  await page.keyboard.press("Enter");

  // focus moves to the step heading
  await page.getByRole("heading", { name: /full name/ }).waitFor();
  assert.equal(await page.evaluate(() => document.activeElement?.tagName), "H1");

  await page.keyboard.press("Tab");
  await page.keyboard.type(DATA.name);
  await page.keyboard.press("Enter"); // Enter advances

  await page.getByRole("heading", { name: /about you/ }).waitFor();
  await page.keyboard.press("Tab");
  await page.keyboard.type("14");
  await page.keyboard.type("03"); // auto-advances to month
  await page.keyboard.type("1993");
  await page.keyboard.press("Tab"); // gender radio group
  await page.keyboard.press("ArrowRight"); // Female
  await page.keyboard.press("Enter");

  await page.getByRole("heading", { name: /reach you/ }).waitFor();
  await page.keyboard.press("Tab");
  await page.keyboard.type("9876543210");
  await page.keyboard.press("Enter");

  await page.getByRole("heading", { name: /live/ }).waitFor();
  await page.keyboard.press("Tab");
  await page.keyboard.type(DATA.line1);
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  await page.keyboard.type(DATA.city);
  await page.keyboard.press("Tab");
  await page.keyboard.type(DATA.pin);
  await page.keyboard.press("Tab");
  await page.keyboard.type("Tamil"); // native select type-ahead
  await page.keyboard.press("Tab"); // Back
  await page.keyboard.press("Tab"); // Continue
  await page.keyboard.press("Enter");

  await page.getByRole("heading", { name: /brings you/ }).waitFor();
  await page.keyboard.press("Tab");
  await page.keyboard.press("Space"); // Pregnancy
  await page.keyboard.press("Enter");

  await page.getByRole("heading", { name: /hear/ }).waitFor();
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  await page.keyboard.press("Space"); // Google Maps
  await page.keyboard.press("Enter");

  await page.getByRole("heading", { name: /Review and sign/ }).waitFor();
  await page.getByText(DATA.name).first().waitFor();
  await context.close();
});

test("validation: inline errors, focus on first invalid field, live clearing", async () => {
  const { page, context } = await newPage(VIEWPORTS[1]);
  await start(page);
  await next(page);
  await page.getByText("Please enter your full name.").waitFor();
  await page.waitForFunction(() => document.activeElement?.id === "field-fullName");
  assert.equal(await page.locator("#field-fullName").getAttribute("aria-invalid"), "true");
  const describedBy = await page.locator("#field-fullName").getAttribute("aria-describedby");
  assert.ok(describedBy && (await page.locator(`[id="${describedBy}"]`).textContent()).includes("full name"));
  await page.locator("#field-fullName").fill("Priya Raman");
  assert.equal(await page.getByText("Please enter your full name").count(), 0, "error clears as it is fixed");
  await next(page);

  // DOB: impossible / future / incomplete
  await card(page, "Male").first().click();
  await page.locator("#field-dobDay").fill("31");
  await page.locator("#field-dobMonth").fill("02");
  await page.locator("#field-dobYear").fill("1990");
  await next(page);
  await page.getByText("That date doesn’t exist").waitFor();
  await page.locator("#field-dobYear").fill("2999");
  await page.locator("#field-dobDay").fill("14");
  await page.locator("#field-dobMonth").fill("03");
  await page.getByText("can’t be in the future").waitFor();
  await page.locator("#field-dobYear").fill("2015");
  await page.getByText("under 18").waitFor(); // guardian note, no guessing
  await page.locator("#field-dobYear").fill("1993");
  await next(page);

  // Contact: bad mobile, bad email (optional but validated)
  await page.locator("#field-phone").fill("12345");
  await page.locator("#field-email").fill("nope");
  await next(page);
  await page.getByText("10-digit Indian mobile").waitFor();
  await page.getByText("valid email").waitFor();
  assert.equal(await page.locator("#field-phone").getAttribute("inputmode"), "numeric");
  assert.equal(await page.locator("#field-phone").getAttribute("autocomplete"), "tel-national");
  await page.locator("#field-phone").fill("+91 98765-43210");
  await page.locator("#field-email").fill("");
  await next(page);

  // Address: bad PIN
  assert.equal(await page.locator("#field-pin").getAttribute("inputmode"), "numeric");
  assert.equal(await page.locator("#field-pin").getAttribute("autocomplete"), "postal-code");
  await page.locator("#field-addressLine1").fill("1 Test Street");
  await page.locator("#field-city").fill("Chennai");
  await page.locator("#field-state").selectOption("Tamil Nadu");
  await page.locator("#field-pin").fill("060020");
  await next(page);
  await page.getByText("valid 6-digit PIN").waitFor();
  await page.locator("#field-pin").fill("600020");
  await next(page);

  // Concerns & sources need a choice; "Other" needs text
  await next(page);
  await page.getByText("Please choose at least one option, or").waitFor();
  await card(page, "Not sure yet").click();
  await next(page);
  await card(page, "Other").click();
  await next(page);
  await page.getByText("Please tell us a little more").waitFor();
  await context.close();
});

test("Back keeps answers; Edit from review returns to review", async () => {
  const { page, context } = await newPage(VIEWPORTS[4]);
  await gotoReview(page);
  // walk back through every step: values are preserved
  await page.getByRole("button", { name: /Back/ }).click();
  await page.getByRole("heading", { name: /hear/ }).waitFor();
  assert.equal(await page.getByRole("checkbox", { name: /Google Maps/ }).isChecked(), true);
  assert.equal(await page.getByRole("checkbox", { name: /Instagram/ }).isChecked(), true);
  await page.getByRole("button", { name: /Back/ }).click();
  assert.equal(await page.getByRole("checkbox", { name: /Pregnancy/ }).isChecked(), true);
  await page.getByRole("button", { name: /Back/ }).click();
  assert.equal(await page.locator("#field-city").inputValue(), DATA.city);
  assert.equal(await page.locator("#field-state").inputValue(), DATA.state);
  await page.getByRole("button", { name: /Back/ }).click();
  assert.equal(await page.locator("#field-email").inputValue(), DATA.email);
  await page.getByRole("button", { name: /Back/ }).click();
  assert.equal(await page.locator("#field-dobYear").inputValue(), DATA.year);
  assert.equal(await page.getByRole("radio", { name: "Female" }).isChecked(), true);
  await page.getByRole("button", { name: /Back/ }).click();
  assert.equal(await page.locator("#field-fullName").inputValue(), DATA.name);
  await page.getByRole("button", { name: /Back/ }).click();
  await page.getByRole("heading", { name: /Welcome to The Birthwave/ }).waitFor();
  await page.getByRole("button", { name: /Start registration/ }).click();
  assert.equal(await page.locator("#field-fullName").inputValue(), DATA.name, "answers survive going back to welcome");

  // Edit from review
  for (let i = 0; i < STEP_NAMES.length; i += 1) await next(page);
  await page.getByRole("heading", { name: /Review and sign/ }).waitFor();
  await page.getByRole("button", { name: "Edit contact details" }).click();
  await page.locator("#field-phone").fill("9123456789");
  await next(page);
  await page.getByRole("heading", { name: /Review and sign/ }).waitFor();
  await page.getByText("+919123456789").waitFor();
  await page.getByText("Date of registration").waitFor();
  await context.close();
});

test("progress bar is derived from the displayed stages and grows with each step", async () => {
  const { page, context } = await newPage();
  await start(page);
  const readings = [];
  for (const name of STEP_NAMES) {
    const bar = page.getByRole("progressbar");
    readings.push({
      now: Number(await bar.getAttribute("aria-valuenow")),
      text: await page.getByText(/^Step \d of 7$/).first().textContent(),
    });
    await steps[name](page);
    await next(page);
  }
  assert.deepEqual(
    readings.map((r) => r.text),
    ["Step 1 of 7", "Step 2 of 7", "Step 3 of 7", "Step 4 of 7", "Step 5 of 7", "Step 6 of 7"],
  );
  const values = readings.map((r) => r.now);
  assert.deepEqual([...values].sort((a, b) => a - b), values, "strictly increasing");
  assert.equal(new Set(values).size, values.length);
  assert.ok(values.at(-1) < 100, "not complete until the receipt");
  await context.close();
});

test("multi-select cards, exclusive 'Not sure yet', conditional 'Other' field", async () => {
  const { page, context } = await newPage();
  await start(page);
  await steps.name(page);
  await next(page);
  await steps.birth(page);
  await next(page);
  await steps.contact(page);
  await next(page);
  await steps.address(page);
  await next(page);

  // each explanation sits directly under its title
  for (const [title, text] of [
    ["Pregnancy", "Antenatal check-ups, pregnancy guidance, and care through each trimester."],
    ["Fertility", "Planning a pregnancy, preconception advice, or support with conception."],
    ["Gynaecology", "Periods, hormonal changes, pelvic health, or other women’s health concerns."],
    ["Paediatrics", "Newborn and child health, growth, feeding, or routine care."],
  ]) {
    const option = card(page, title);
    assert.equal((await option.locator("span:last-child > span").allTextContents()).join("|"), `${title}|${text}`);
  }
  assert.equal(await page.getByRole("checkbox").count(), 7);
  for (const [title, text] of [
    ["VBAC", "Vaginal birth after a previous caesarean: planning and discussing your options."],
    ["Vaginismus", "Supportive, sensitive care for intimate health concerns, in a private and respectful setting."],
  ]) {
    assert.equal((await card(page, title).locator("span:last-child > span").allTextContents()).join("|"), `${title}|${text}`);
  }
  await card(page, "VBAC").click();
  await card(page, "Vaginismus").click();
  assert.equal(await page.getByRole("checkbox", { name: /VBAC/ }).isChecked(), true);
  assert.equal(await page.getByRole("checkbox", { name: /Vaginismus/ }).isChecked(), true);
  await card(page, "VBAC").click();
  await card(page, "Vaginismus").click();

  await card(page, "Pregnancy").click();
  await card(page, "Gynaecology").click();
  assert.equal(await page.getByRole("checkbox", { name: /Pregnancy/ }).isChecked(), true);
  assert.equal(await page.getByRole("checkbox", { name: /Gynaecology/ }).isChecked(), true);
  await card(page, "Not sure yet").click();
  assert.equal(await page.getByRole("checkbox", { name: /Pregnancy/ }).isChecked(), false);
  assert.equal(await page.getByRole("checkbox", { name: /Not sure yet/ }).isChecked(), true);
  await card(page, "Fertility").click();
  assert.equal(await page.getByRole("checkbox", { name: /Not sure yet/ }).isChecked(), false);
  await next(page);

  // sources: nine, labelled, with distinct Google Maps and Google Search icons
  const labels = ["Doctor", "Google Maps", "Google Search", "Friends / Family", "ChatGPT", "Instagram", "Facebook", "YouTube", "Other"];
  assert.equal(await page.getByRole("checkbox").count(), 9);
  for (const label of labels) await page.getByRole("checkbox", { name: label }).waitFor();
  const icon = async (label) =>
    card(page, label).locator("[class*=optionIcon] svg").first().evaluate((svg) => ({
      html: svg.innerHTML,
      fills: [...svg.querySelectorAll("path")].map((p) => p.getAttribute("fill")),
    }));
  const maps = await icon("Google Maps");
  const search = await icon("Google Search");
  assert.notEqual(maps.html, search.html, "Maps and Search icons differ");
  assert.deepEqual(search.fills, ["#EA4335", "#4285F4", "#FBBC05", "#34A853"], "Google G is the four-colour mark");
  assert.equal(maps.fills.length, 1, "Maps uses the single map-pin glyph");
  for (const label of labels) {
    const svgs = await card(page, label).locator("[class*=optionIcon] svg[aria-hidden=true]").count();
    assert.ok(svgs >= 1, `${label} has a decorative icon alongside its visible text`);
  }

  await card(page, "Other").click();
  await page.locator("#field-sourceOther").fill("A poster near the bus stop");
  await card(page, "Google Maps").click();
  await card(page, "Google Search").click();
  await next(page);
  await page.getByRole("heading", { name: /Review/ }).waitFor();
  await page.getByText("Google Maps, Google Search, Other (A poster near the bus stop)").waitFor();
  await context.close();
});

test("submitting with no approved backend fails clearly and keeps answers (no mock success)", async () => {
  const { page, context, requests } = await newPage(VIEWPORTS[1]);
  await gotoReview(page);
  await page.locator("#field-consent").check();
  await typeSignature(page);
  await page.getByRole("button", { name: "Submit registration" }).click();
  await page.getByRole("alert").filter({ hasText: "isn’t available right now" }).waitFor();
  assert.equal(await page.getByRole("heading", { name: /checked in/ }).count(), 0);
  // answers are still there, user can retry
  await page.getByRole("button", { name: "Try again" }).waitFor();
  await page.getByText(DATA.name, { exact: false }).first().waitFor();
  assert.equal(requests.filter((r) => r.url.endsWith("/api/registrations")).length, 1);
  await page.getByRole("button", { name: "Try again" }).click();
  await page.getByRole("alert").filter({ hasText: "isn’t available right now" }).waitFor();
  await context.close();
});

const mockSuccess = async (page, captured, delay = 0) => {
  await page.route("**/api/registrations", async (route) => {
    captured.push({ body: route.request().postData(), headers: route.request().headers() });
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
    await route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify({ ok: true, id: "BW-TEST-0001" }) });
  });
};

test("successful submission (network-mocked): payload, receipt, data cleared, kiosk reset", async () => {
  const { page, context, requests, consoleErrors } = await newPage(VIEWPORTS[4]);
  let unloadDialog = false;
  page.on("dialog", async (dialog) => {
    unloadDialog = true;
    await dialog.dismiss();
  });
  await page.clock.install();
  const captured = [];
  await mockSuccess(page, captured);
  await gotoReview(page);

  // Required consent + signature are enforced
  await page.getByRole("button", { name: "Submit registration" }).click();
  await page.getByText("Please confirm to continue.").waitFor();
  await page.getByText(/Please sign in the box/).waitFor();
  assert.equal(captured.length, 0);
  await page.locator("#field-consent").check();
  await drawSignature(page);
  await page.getByRole("button", { name: "Submit registration" }).click();
  await page.getByRole("heading", { name: /checked in/ }).waitFor();
  await page.getByText("BW-TEST-0001").waitFor();
  assert.equal(unloadDialog, false, "a confirmed registration must navigate without a leave-page warning");

  assert.equal(captured.length, 1);
  const body = JSON.parse(captured[0].body);
  assert.equal(body.fullName, DATA.name);
  assert.deepEqual(body.concerns, ["pregnancy", "fertility"]);
  assert.deepEqual(body.sources, ["google_maps", "instagram"], "unambiguous source ids");
  assert.equal(body.signatureMethod, "drawn");
  assert.match(body.signatureData, /^data:image\/png;base64,/);
  assert.ok(body.signatureData.length < 200_000);
  assert.match(body.idempotencyKey, /^[0-9a-f-]{36}$/);
  assert.equal(body.website, "");
  assert.equal(captured[0].headers["content-type"], "application/json");

  // nothing typed remains in the DOM after success
  const text = await page.locator("body").innerText();
  assert.equal(text.includes(DATA.name), false);
  assert.equal(text.includes("Lake View"), false);

  // storage stays empty
  const storage = await page.evaluate(() => ({
    local: localStorage.length,
    session: sessionStorage.length,
    cookie: document.cookie,
  }));
  assert.deepEqual(storage, { local: 0, session: 0, cookie: "" });

  // privacy: only same-origin traffic, never GA / pixels / the enquiry API
  const external = requests.filter((r) => !r.url.startsWith(BASE) && !r.url.startsWith("data:") && !r.url.startsWith("blob:"));
  assert.deepEqual(external.map((r) => r.url), [], "no third-party requests on /registration");
  assert.equal(requests.some((r) => /api\/enquiries/.test(r.url)), false);
  assert.equal(requests.some((r) => /google-analytics|googletagmanager|collect\?/.test(r.url)), false);
  assert.equal(consoleErrors.filter((m) => /registration|Priya|9876/.test(m)).length, 0);

  // a personal phone is never wiped on a timer; "Done" closes the receipt
  assert.match(new URL(page.url()).pathname, /^\/thank-you$/);
  await page.clock.fastForward(10 * 60 * 1000);
  await page.getByRole("heading", { name: /checked in/ }).waitFor();
  await page.getByRole("button", { name: "Done" }).click();
  await page.getByRole("heading", { name: /Thank you for visiting/ }).waitFor();
  await context.close();
});

test("shared clinic tablet (?kiosk=1) clears itself for the next patient", async () => {
  const { page, context } = await newPage(VIEWPORTS[4]);
  await page.clock.install();
  const captured = [];
  await mockSuccess(page, captured);
  await page.goto(`${URL_REG}?kiosk=1`);
  await page.getByRole("button", { name: /Start registration/ }).click();
  for (const name of STEP_NAMES) {
    await steps[name](page);
    await next(page);
  }
  await typeSignature(page);
  await page.locator("#field-consent").check();
  await page.getByRole("button", { name: "Submit registration" }).click();
  await page.getByRole("heading", { name: /checked in/ }).waitFor();
  assert.match(page.url(), /\/thank-you\?kiosk=1/);
  await page.getByText(/clears for the next patient in \d+ seconds/).waitFor();
  await page.clock.fastForward(46_000);
  await page.getByRole("heading", { name: /Welcome to The Birthwave/ }).waitFor();
  assert.match(page.url(), /\/registration\?kiosk=1$/);
  await page.getByRole("button", { name: /Start registration/ }).click();
  assert.equal(await page.locator("#field-fullName").inputValue(), "");
  await context.close();
});

test("clinic header: label, welcome line, IST date, assistance and live step percentage", async () => {
  const { page, context } = await newPage(VIEWPORTS[1]);
  await page.goto(URL_REG);
  await page.getByText("Clinic Check-in", { exact: true }).waitFor();
  await page.getByText("Your care begins here.").waitFor();
  assert.match(await page.locator("header").first().innerText(), /\b\d{2}\/\d{2}\/\d{4}\b/, "Indian date format");
  assert.equal(await page.locator("header nav, header a[href]").count(), 0, "no marketing navigation");
  const help = page.getByRole("button", { name: "Need assistance?" });
  assert.equal(await help.getAttribute("aria-expanded"), "false");
  await help.click();
  assert.equal(await help.getAttribute("aria-expanded"), "true");
  const tel = page.getByRole("link", { name: /\+91 93630 31925/ });
  assert.equal(await tel.getAttribute("href"), "tel:+919363031925");
  await page.keyboard.press("Escape");
  assert.equal(await help.getAttribute("aria-expanded"), "false");
  assert.equal(await page.evaluate(() => document.activeElement?.textContent), "Need assistance?");
  await page.getByRole("button", { name: /Start registration/ }).click();
  await page.getByText("Step 1 of 7 · 13%").waitFor();
  await steps.name(page);
  await next(page);
  await page.getByText("Step 2 of 7 · 25%").waitFor();
  await context.close();
});

test("typed signature is flagged in payload; success screenshot at mobile", async () => {
  const { page, context } = await newPage(VIEWPORTS[1]);
  const captured = [];
  await mockSuccess(page, captured);
  await gotoReview(page);
  await page.locator("#field-consent").check();
  await typeSignature(page);
  await page.getByRole("button", { name: "Submit registration" }).click();
  await page.getByRole("heading", { name: /checked in/ }).waitFor();
  await page.waitForTimeout(350);
  await page.screenshot({ path: `${SHOTS}mobile-390-99-receipt.png` });
  const body = JSON.parse(captured[0].body);
  assert.equal(body.signatureMethod, "typed");
  assert.equal(body.signatureTyped, DATA.name);
  await context.close();
});

test("duplicate submit protection and retry after failure/offline keep answers", async () => {
  const { page, context } = await newPage(VIEWPORTS[1]);
  const captured = [];
  await mockSuccess(page, captured, 600);
  await gotoReview(page);
  await page.locator("#field-consent").check();
  await typeSignature(page);
  const submit = page.getByRole("button", { name: "Submit registration" });
  await submit.dblclick();
  await page.getByRole("heading", { name: /checked in/ }).waitFor();
  assert.equal(captured.length, 1, "double-click sends one request");
  await context.close();

  // failure then retry: same idempotency key, answers intact
  const second = await newPage(VIEWPORTS[1]);
  const seen = [];
  let calls = 0;
  await second.page.route("**/api/registrations", async (route) => {
    calls += 1;
    seen.push(JSON.parse(route.request().postData()).idempotencyKey);
    if (calls === 1) return route.fulfill({ status: 502, contentType: "application/json", body: JSON.stringify({ ok: false }) });
    return route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify({ ok: true, id: "BW-RETRY" }) });
  });
  await gotoReview(second.page);
  await second.page.locator("#field-consent").check();
  await typeSignature(second.page);
  await second.page.getByRole("button", { name: "Submit registration" }).click();
  await second.page.getByRole("alert").filter({ hasText: "couldn’t save" }).waitFor();
  const btn = second.page.getByRole("button", { name: "Try again" });
  await btn.waitFor();
  await btn.click();
  await second.page.getByText("BW-RETRY").waitFor();
  assert.equal(seen[0], seen[1], "retry reuses the idempotency key");
  await second.context.close();

  // offline: message, nothing sent, then online retry works
  const third = await newPage(VIEWPORTS[1]);
  const sent = [];
  await mockSuccess(third.page, sent);
  await gotoReview(third.page);
  await third.page.locator("#field-consent").check();
  await typeSignature(third.page);
  await third.context.setOffline(true);
  await third.page.getByRole("button", { name: "Submit registration" }).click();
  await third.page.getByRole("alert").filter({ hasText: "offline" }).waitFor();
  assert.equal(sent.length, 0);
  await third.context.setOffline(false);
  await third.page.getByRole("button", { name: "Try again" }).click();
  await third.page.getByText("BW-TEST-0001").waitFor();
  await third.context.close();
});

test("a personal phone is not wiped while the form sits idle", async () => {
  const { page, context } = await newPage(VIEWPORTS[1]);
  await page.clock.install();
  await start(page);
  await steps.name(page);
  await page.clock.fastForward(10 * 60 * 1000);
  assert.equal(await page.getByText(/Are you still there/).count(), 0);
  assert.equal(await page.locator("#field-fullName").inputValue(), DATA.name);
  await context.close();
});

test("shared-tablet idle timeout warns then clears an abandoned form", async () => {
  const { page, context } = await newPage();
  await page.clock.install();
  await page.goto(`${URL_REG}?kiosk=1`);
  await page.getByRole("button", { name: /Start registration/ }).click();
  await steps.name(page);
  await page.clock.fastForward(3 * 60 * 1000 + 500);
  await page.getByText(/Are you still there/).waitFor();
  await page.getByRole("button", { name: "I’m still here" }).click();
  assert.equal(await page.getByText(/Are you still there/).count(), 0);
  assert.equal(await page.locator("#field-fullName").inputValue(), DATA.name);
  await page.clock.fastForward(3 * 60 * 1000 + 500);
  await page.getByText(/Are you still there/).waitFor();
  await page.clock.fastForward(61 * 1000);
  await page.getByRole("heading", { name: /Welcome to The Birthwave/ }).waitFor();
  await page.getByRole("button", { name: /Start registration/ }).click();
  assert.equal(await page.locator("#field-fullName").inputValue(), "");
  await context.close();
});

test("reduced motion disables step transitions", async () => {
  const { page, context } = await newPage(VIEWPORTS[4], { reducedMotion: "reduce" });
  await start(page);
  const animation = await page.evaluate(() => {
    const el = document.querySelector("main > div > div:last-child");
    const cs = getComputedStyle(el);
    return { name: cs.animationName, duration: cs.animationDuration };
  });
  assert.equal(animation.name, "none");
  await context.close();

  const normal = await newPage(VIEWPORTS[4], { reducedMotion: "no-preference" });
  await start(normal.page);
  const anim = await normal.page.evaluate(() => getComputedStyle(document.querySelector("main > div > div:last-child")).animationDuration);
  assert.equal(anim, "0.24s", "transitions are short (240ms)");
  await normal.context.close();
});

test("analytics: public pages still load GA, /registration never does", async () => {
  const home = await newPage();
  await home.page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
  await home.page.waitForTimeout(2500);
  assert.ok(
    home.requests.some((r) => r.url.includes("googletagmanager.com/gtag/js")),
    "home page still requests gtag.js",
  );
  await home.context.close();

  const reg = await newPage();
  await reg.page.goto(URL_REG, { waitUntil: "domcontentloaded" });
  await reg.page.waitForTimeout(2500);
  assert.equal(reg.requests.some((r) => /googletagmanager|google-analytics/.test(r.url)), false);
  assert.equal(await reg.page.evaluate(() => typeof window.gtag), "undefined");
  await reg.context.close();
});

test("response headers and crawl controls", async () => {
  const response = await fetch(URL_REG);
  assert.match(response.headers.get("cache-control"), /no-store/);
  assert.match(response.headers.get("x-robots-tag"), /noindex/);
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  const sitemap = await (await fetch(`${BASE}/sitemap.xml`)).text();
  assert.equal(sitemap.includes("/registration"), false);
  const robots = await (await fetch(`${BASE}/robots.txt`)).text();
  assert.match(robots, /Disallow: \/registration/);
  const api = await fetch(`${BASE}/api/registrations`, { method: "POST", body: "{}", headers: { "content-type": "application/json" } });
  assert.equal(api.status, 403, "cross-origin / originless posts are refused");
  assert.match(api.headers.get("cache-control"), /no-store/);
  const get = await fetch(`${BASE}/api/registrations`);
  assert.equal(get.status, 405);
});
