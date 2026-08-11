import { chromium } from "playwright";

const OCTOPUS_EMAIL = process.env.OCTOPUS_EMAIL;
const OCTOPUS_PASSWORD = process.env.OCTOPUS_PASSWORD;
const ORGANIZATION_NAME =
  process.env.OCTOPUS_ORGANIZATION_NAME || "SpeedyCleans";

const args = process.argv.slice(2);
const mode = args[0]?.toLowerCase() === "cancel" ? "cancel" : "inspect";
const bookingId = mode === "cancel" ? args[1] : args[0];
const requestedReason =
  mode === "cancel" ? args.slice(2).join(" ").trim() || "Other" : "";

if (!OCTOPUS_EMAIL) throw new Error("Missing OCTOPUS_EMAIL");
if (!OCTOPUS_PASSWORD) throw new Error("Missing OCTOPUS_PASSWORD");
if (!/^\d+$/.test(String(bookingId || ""))) {
  throw new Error(
    "A numeric booking ID is required. Example: node playwright/octopus-booking-actions.js inspect 562455"
  );
}

function logResult(result) {
  console.log("\n===== BOOKING ACTION RESULT =====");
  console.log(JSON.stringify(result, null, 2));
  console.log("===== END BOOKING ACTION RESULT =====\n");
}

async function selectOrganization(page) {
  await page.waitForTimeout(2000);
  const selects = page.locator("select");

  for (let index = 0; index < (await selects.count()); index += 1) {
    const select = selects.nth(index);
    const options = await select.locator("option").allTextContents();
    const match = options.find((option) =>
      option.toLowerCase().includes(ORGANIZATION_NAME.toLowerCase())
    );

    if (match) {
      await select.selectOption({ label: match.trim() });
      const submit = page
        .locator('button[type="submit"], input[type="submit"]')
        .first();
      if (await submit.isVisible().catch(() => false)) await submit.click();
      else await page.keyboard.press("Enter");
      await page.waitForTimeout(4000);
      return;
    }
  }

  const organization = page
    .getByText(ORGANIZATION_NAME, { exact: false })
    .first();
  if (await organization.isVisible().catch(() => false)) {
    await organization.click();
    const submit = page
      .locator('button[type="submit"], input[type="submit"]')
      .first();
    if (await submit.isVisible().catch(() => false)) await submit.click();
    else await page.keyboard.press("Enter");
    await page.waitForTimeout(4000);
    return;
  }

  throw new Error(`Could not select organization ${ORGANIZATION_NAME}`);
}

async function loginToOctopus(page) {
  console.log("Logging into OctopusPro...");
  await page.goto("https://admin.octopuspro.com/login", {
    waitUntil: "domcontentloaded",
    timeout: 60000
  });

  const email = page
    .locator(
      'input[type="email"], input[name="email"], input[name="username"], #email'
    )
    .first();
  const password = page
    .locator('input[type="password"], input[name="password"], #password')
    .first();

  await email.waitFor({ state: "visible", timeout: 30000 });
  await email.fill(OCTOPUS_EMAIL);
  await password.fill(OCTOPUS_PASSWORD);
  await page
    .locator('button[type="submit"], input[type="submit"]')
    .first()
    .click();
  await page.waitForTimeout(5000);

  if (page.url().toLowerCase().includes("/checkuserinmulticompanies")) {
    await selectOrganization(page);
  }
  if (page.url().toLowerCase().includes("/login")) {
    throw new Error("OctopusPro login did not complete");
  }
}

async function openBooking(page) {
  const url = `https://admin.octopuspro.com/booking/view/${bookingId}`;
  console.log(`Opening booking ${bookingId}...`);
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(5000);

  if (page.url().toLowerCase().includes("/login")) {
    await loginToOctopus(page);
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(5000);
  }
  if (page.url().toLowerCase().includes("/checkuserinmulticompanies")) {
    await selectOrganization(page);
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(5000);
  }
  if (!page.url().includes(`/booking/view/${bookingId}`)) {
    throw new Error(`Booking page did not open. Current URL: ${page.url()}`);
  }
}

async function getPageState(page) {
  const text = (await page.locator("body").innerText()).toUpperCase();
  const blockedStates = [
    "EN ROUTE",
    "ON THE WAY",
    "ARRIVED",
    "CHECKED IN",
    "JOB STARTED",
    "WORK STARTED",
    "IN PROGRESS"
  ];
  const unsafeState = blockedStates.find((state) => text.includes(state)) || null;
  return {
    cancelled: text.includes("CANCELLED"),
    toDo: text.includes("TO DO"),
    unsafeState
  };
}

async function inspectBooking(page) {
  const state = await getPageState(page);
  const title = await page.title();
  const statusControl = page
    .locator("a.title-booking.status-label, .title-booking.status-label")
    .first();

  logResult({
    ok: true,
    action: "inspect",
    booking_id: Number(bookingId),
    page_title: title,
    status_control_found: await statusControl.isVisible().catch(() => false),
    ...state,
    changed: false
  });
}

async function closeVisibleDialog(page) {
  const close = page
    .locator(
      '[role="dialog"] button[aria-label*="close" i], [role="dialog"] .close, .modal.show button.close, .modal.show [data-dismiss="modal"]'
    )
    .first();
  if (await close.isVisible().catch(() => false)) await close.click();
}

async function getLargestVisibleExactText(page, text) {
  const matches = page.getByText(text, { exact: true });
  const candidates = [];

  for (let index = 0; index < (await matches.count()); index += 1) {
    const match = matches.nth(index);
    if (!(await match.isVisible().catch(() => false))) continue;
    const box = await match.boundingBox();
    if (!box) continue;
    candidates.push({ match, area: box.width * box.height });
  }

  candidates.sort((a, b) => b.area - a.area);
  return candidates[0]?.match || null;
}

async function cancelBooking(page) {
  const initialState = await getPageState(page);

  if (initialState.cancelled) {
    logResult({
      ok: true,
      action: "cancel",
      booking_id: Number(bookingId),
      outcome: "already_cancelled",
      changed: false
    });
    return;
  }

  if (initialState.unsafeState) {
    logResult({
      ok: false,
      action: "cancel",
      booking_id: Number(bookingId),
      outcome: "staff_review_required",
      reason: `Fieldworker status may be ${initialState.unsafeState}. Possible lockout or cancellation fee.`,
      changed: false
    });
    return;
  }

  if (!initialState.toDo) {
    logResult({
      ok: false,
      action: "cancel",
      booking_id: Number(bookingId),
      outcome: "staff_review_required",
      reason: "Booking is not clearly in TO DO status.",
      changed: false
    });
    return;
  }

  const statusControl = await getLargestVisibleExactText(page, "TO DO");
  if (!statusControl) {
    throw new Error("Could not find the visible TO DO booking status badge");
  }
  await statusControl.click();
  await page.waitForTimeout(500);

  const firstStatusOption = await getLargestVisibleExactText(
    page,
    "IN PROGRESS"
  );
  if (!firstStatusOption) {
    throw new Error("The visible booking status menu did not open");
  }
  await firstStatusOption.evaluate((element) => {
    let current = element.parentElement;
    while (current) {
      if (current.scrollHeight > current.clientHeight + 5) {
        current.scrollTop = current.scrollHeight;
        current.dispatchEvent(new Event("scroll", { bubbles: true }));
        return;
      }
      current = current.parentElement;
    }
    throw new Error("Could not find the scrollable booking status menu");
  });
  await page.waitForTimeout(750);

  const cancelledOption = await getLargestVisibleExactText(page, "CANCELLED");
  if (!cancelledOption) {
    throw new Error("CANCELLED did not become visible in the status menu");
  }
  await cancelledOption.click();

  const noticeHeading = page.getByText("Cancellation Notice", { exact: true });
  await noticeHeading.waitFor({ state: "visible", timeout: 20000 });

  const dialog = noticeHeading.locator("xpath=ancestor::*[@role='dialog'][1]");
  const modal = (await dialog.count()) > 0 ? dialog : page.locator(".modal.show").last();
  const noticeText = await modal.innerText();

  if (!/no cancellation fee will be charged/i.test(noticeText)) {
    await closeVisibleDialog(page);
    logResult({
      ok: false,
      action: "cancel",
      booking_id: Number(bookingId),
      outcome: "staff_review_required",
      reason: "OctopusPro did not confirm that this cancellation is fee-free. Possible late cancellation or lockout fee.",
      changed: false
    });
    return;
  }

  const reasonSelect = modal.locator("select").first();
  if (await reasonSelect.isVisible().catch(() => false)) {
    const options = await reasonSelect.locator("option").allTextContents();
    const requestedMatch = options.find(
      (option) => option.trim().toLowerCase() === requestedReason.toLowerCase()
    );
    const otherMatch = options.find(
      (option) => option.trim().toLowerCase() === "other"
    );
    await reasonSelect.selectOption({
      label: (requestedMatch || otherMatch || options.find(Boolean)).trim()
    });
  }

  await modal
    .getByRole("button", { name: /cancel without fee/i })
    .click();

  const invoiceHeading = page.getByText("Update invoice status", {
    exact: true
  });
  const notifyHeading = page.getByText("Notify Customer", { exact: true });

  await Promise.race([
    invoiceHeading.waitFor({ state: "visible", timeout: 25000 }),
    notifyHeading.waitFor({ state: "visible", timeout: 25000 })
  ]).catch(() => {});

  let invoiceVoided = false;
  if (await invoiceHeading.isVisible().catch(() => false)) {
    const invoiceDialog = invoiceHeading.locator(
      "xpath=ancestor::*[@role='dialog'][1]"
    );
    const invoiceModal =
      (await invoiceDialog.count()) > 0
        ? invoiceDialog
        : page.locator(".modal.show").last();

    await invoiceModal
      .getByRole("button", { name: /convert invoice to void/i })
      .click();

    const success = page.getByText("Success", { exact: true });
    await success.waitFor({ state: "visible", timeout: 20000 });
    const successDialog = success.locator("xpath=ancestor::*[@role='dialog'][1]");
    const successModal =
      (await successDialog.count()) > 0
        ? successDialog
        : page.locator(".modal.show").last();
    await successModal.getByRole("button", { name: /^ok$/i }).click();
    invoiceVoided = true;
  }

  await notifyHeading.waitFor({ state: "visible", timeout: 25000 }).catch(() => {});
  let notificationSent = false;
  if (await notifyHeading.isVisible().catch(() => false)) {
    const notifyDialog = notifyHeading.locator(
      "xpath=ancestor::*[@role='dialog'][1]"
    );
    const notifyModal =
      (await notifyDialog.count()) > 0
        ? notifyDialog
        : page.locator(".modal.show").last();
    await notifyModal.getByRole("button", { name: /^send$/i }).click();
    notificationSent = true;
    await page.waitForTimeout(3000);
  }

  await page.reload({ waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(5000);
  const finalState = await getPageState(page);

  logResult({
    ok: finalState.cancelled,
    action: "cancel",
    booking_id: Number(bookingId),
    outcome: finalState.cancelled ? "cancelled" : "verification_failed",
    cancellation_reason: requestedReason,
    invoice_voided: invoiceVoided,
    customer_notification_sent: notificationSent,
    verified_cancelled_in_octopus: finalState.cancelled,
    changed: finalState.cancelled
  });
}

async function main() {
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"]
  });

  try {
    const context = await browser.newContext({
      viewport: { width: 1600, height: 1000 }
    });
    const page = await context.newPage();
    await openBooking(page);

    if (mode === "cancel") await cancelBooking(page);
    else await inspectBooking(page);
  } catch (error) {
    console.error("Octopus booking action failed:");
    console.error(error);
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
}

main();
