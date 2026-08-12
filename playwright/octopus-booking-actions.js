import { chromium } from "playwright";

const OCTOPUS_EMAIL = process.env.OCTOPUS_EMAIL;
const OCTOPUS_PASSWORD = process.env.OCTOPUS_PASSWORD;
const ORGANIZATION_NAME =
  process.env.OCTOPUS_ORGANIZATION_NAME || "SpeedyCleans";

const args = process.argv.slice(2);
const requestedMode = args[0]?.toLowerCase();
const mode = ["cancel", "reschedule", "capture-reschedule", "diagnose"].includes(requestedMode)
  ? requestedMode
  : "inspect";
const bookingId = mode === "inspect" ? args[0] : args[1];
const requestedReason =
  mode === "cancel" ? args.slice(2).join(" ").trim() || "Other" : "";
const isRescheduleMode = ["reschedule", "capture-reschedule"].includes(mode);
const requestedDate = isRescheduleMode ? args[2] : "";
const requestedStartTime = isRescheduleMode ? args[3] : "";

if (!OCTOPUS_EMAIL) throw new Error("Missing OCTOPUS_EMAIL");
if (!OCTOPUS_PASSWORD) throw new Error("Missing OCTOPUS_PASSWORD");
if (!/^\d+$/.test(String(bookingId || ""))) {
  throw new Error(
    "A numeric booking ID is required. Example: node playwright/octopus-booking-actions.js inspect 562455"
  );
}
if (
  isRescheduleMode &&
  !/^\d{4}-\d{2}-\d{2}$/.test(requestedDate)
) {
  throw new Error(
    "Rescheduling requires a date in YYYY-MM-DD format."
  );
}
if (
  isRescheduleMode &&
  !/^([01]\d|2[0-3]):[0-5]\d$/.test(requestedStartTime)
) {
  throw new Error(
    "Rescheduling requires a start time in 24-hour HH:MM format."
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

async function waitForLargestVisibleExactText(
  page,
  text,
  timeout = 20000
) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeout) {
    const match = await getLargestVisibleExactText(page, text);
    if (match) return match;
    await page.waitForTimeout(250);
  }
  return null;
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

  const cancelWithoutFeeButton = await getLargestVisibleExactText(
    page,
    "Cancel Without Fee"
  );
  if (!cancelWithoutFeeButton) {
    throw new Error("Could not find the visible Cancel Without Fee button");
  }
  await cancelWithoutFeeButton.click();

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

    const voidInvoiceButton = await getLargestVisibleExactText(
      page,
      "Convert invoice to Void"
    );
    if (!voidInvoiceButton) {
      throw new Error("Could not find the visible Convert invoice to Void button");
    }
    await voidInvoiceButton.click();

    const okButton = await waitForLargestVisibleExactText(page, "Ok", 20000);
    if (!okButton) throw new Error("Could not find the visible Ok button");
    await okButton.click();
    invoiceVoided = true;
  }

  let notificationSent = false;
  let sendButton = await getLargestVisibleExactText(page, "Send");

  if (!sendButton) {
    const saveChangesButton = await waitForLargestVisibleExactText(
      page,
      "Save changes",
      20000
    );
    if (!saveChangesButton) {
      throw new Error("Could not find the visible Save changes button");
    }
    await saveChangesButton.click();
    sendButton = await waitForLargestVisibleExactText(page, "Send", 25000);
  }

  if (sendButton) {
    await sendButton.click();
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

function parseClockTime(value) {
  const text = String(value || "").trim().toUpperCase();
  const twelveHour = text.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/);
  const twentyFourHour = text.match(/^(\d{1,2}):(\d{2})$/);

  if (twelveHour) {
    let hours = Number(twelveHour[1]) % 12;
    if (twelveHour[3] === "PM") hours += 12;
    return hours * 60 + Number(twelveHour[2]);
  }
  if (twentyFourHour) {
    return Number(twentyFourHour[1]) * 60 + Number(twentyFourHour[2]);
  }

  throw new Error(`Could not understand appointment time: ${value}`);
}

function formatClockTime(totalMinutes) {
  const normalized = ((totalMinutes % 1440) + 1440) % 1440;
  const hours24 = Math.floor(normalized / 60);
  const minutes = normalized % 60;
  const suffix = hours24 >= 12 ? "PM" : "AM";
  const hours12 = hours24 % 12 || 12;
  return `${hours12}:${String(minutes).padStart(2, "0")} ${suffix}`;
}

function formatLongDate(isoDate) {
  const [year, month, day] = isoDate.split("-").map(Number);
  return new Intl.DateTimeFormat("en-US", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC"
  }).format(new Date(Date.UTC(year, month - 1, day)));
}

function normalizeDateText(value) {
  return String(value || "")
    .replace(/,/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

async function visibleInputAfterLabel(page, labelText, inputOffset = 0) {
  const labels = page.getByText(labelText, { exact: true });

  for (let labelIndex = 0; labelIndex < (await labels.count()); labelIndex += 1) {
    const label = labels.nth(labelIndex);
    if (!(await label.isVisible().catch(() => false))) continue;

    const inputs = label.locator("xpath=following::input");
    let visibleIndex = 0;

    for (let inputIndex = 0; inputIndex < (await inputs.count()); inputIndex += 1) {
      const input = inputs.nth(inputIndex);
      if (!(await input.isVisible().catch(() => false))) continue;
      if (visibleIndex === inputOffset) return input;
      visibleIndex += 1;
    }
  }

  return null;
}

async function forceInputValue(input, value) {
  await input.scrollIntoViewIfNeeded();

  try {
    await input.fill(value, { timeout: 5000 });
  } catch {
    await input.evaluate((element, nextValue) => {
      element.removeAttribute("readonly");
      const valueSetter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value"
      )?.set;
      if (valueSetter) valueSetter.call(element, nextValue);
      else element.value = nextValue;
      element.dispatchEvent(new Event("input", { bubbles: true }));
      element.dispatchEvent(new Event("change", { bubbles: true }));
      element.dispatchEvent(new Event("blur", { bubbles: true }));
    }, value);
  }

  await input.press("Tab").catch(() => {});
  await input.evaluate((element) => {
    element.dispatchEvent(new Event("change", { bubbles: true }));
    element.dispatchEvent(new Event("blur", { bubbles: true }));
  });
}

async function getVisibleMatches(page, regex) {
  const matches = page.getByText(regex, { exact: true });
  const visible = [];

  for (let index = 0; index < (await matches.count()); index += 1) {
    const match = matches.nth(index);
    if (!(await match.isVisible().catch(() => false))) continue;
    const box = await match.boundingBox();
    if (box) visible.push({ match, box });
  }

  visible.sort((a, b) => a.box.y - b.box.y || a.box.x - b.box.x);
  return visible;
}

async function scrollToScheduledAppointments(page) {
  const datePattern =
    /^(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday),? \d{1,2} (January|February|March|April|May|June|July|August|September|October|November|December) \d{4}$/;
  const timePattern = /^\d{1,2}:\d{2}\s*(AM|PM)$/i;

  for (let attempt = 0; attempt < 18; attempt += 1) {
    const inputs = page.locator("input");
    let visibleDates = 0;
    let visibleTimes = 0;

    for (let index = 0; index < (await inputs.count()); index += 1) {
      const input = inputs.nth(index);
      if (!(await input.isVisible().catch(() => false))) continue;
      const value = (await input.inputValue().catch(() => "")).trim();
      if (datePattern.test(value)) visibleDates += 1;
      if (timePattern.test(value)) visibleTimes += 1;
    }

    if (visibleDates >= 2 && visibleTimes >= 2) {
      await page.waitForTimeout(700);
      return;
    }

    await page.evaluate(() => {
      window.scrollBy(0, 700);
      for (const element of document.querySelectorAll("*")) {
        if (element.scrollHeight > element.clientHeight + 20) {
          element.scrollTop = Math.min(
            element.scrollTop + 700,
            element.scrollHeight
          );
          element.dispatchEvent(new Event("scroll", { bubbles: true }));
        }
      }
    });
    await page.mouse.wheel(0, 700);
    await page.waitForTimeout(500);
  }

  throw new Error(
    "Could not find the Scheduled Appointments date/time controls after scrolling every page panel."
  );
}

async function getVisibleInputValuesMatching(page, regex) {
  const inputs = page.locator("input");
  const visible = [];

  for (let index = 0; index < (await inputs.count()); index += 1) {
    const input = inputs.nth(index);
    if (!(await input.isVisible().catch(() => false))) continue;
    const value = (await input.inputValue().catch(() => "")).trim();
    if (!regex.test(value)) continue;
    const box = await input.boundingBox();
    if (box) visible.push({ match: input, box, value });
  }

  visible.sort((a, b) => a.box.y - b.box.y || a.box.x - b.box.x);
  return visible;
}

async function getAppointmentDisplayValues(page) {
  await scrollToScheduledAppointments(page);

  let dates = await getVisibleInputValuesMatching(
    page,
    /^(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday),? \d{1,2} (January|February|March|April|May|June|July|August|September|October|November|December) \d{4}$/
  );
  let times = await getVisibleInputValuesMatching(
    page,
    /^\d{1,2}:\d{2}\s*(AM|PM)$/i
  );

  if (dates.length < 2) {
    dates = await getVisibleMatches(
      page,
      /^(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday),? \d{1,2} (January|February|March|April|May|June|July|August|September|October|November|December) \d{4}$/
    );
  }
  if (times.length < 2) {
    times = await getVisibleMatches(
      page,
      /^\d{1,2}:\d{2}\s*(AM|PM)$/i
    );
  }

  if (dates.length < 2 || times.length < 2) {
    throw new Error(
      `Could not find the visible appointment date/time controls. Found ${dates.length} dates and ${times.length} times.`
    );
  }

  return {
    fromDate:
      dates[0].value ||
      (await dates[0].match.innerText()).trim(),
    toDate:
      dates[1].value ||
      (await dates[1].match.innerText()).trim(),
    fromTime:
      times[0].value ||
      (await times[0].match.innerText()).trim(),
    toTime:
      times[1].value ||
      (await times[1].match.innerText()).trim()
  };
}

async function findVisibleControlByValueOrText(page, value) {
  const inputs = await getVisibleInputValuesMatching(
    page,
    new RegExp(
      `^${String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`,
      "i"
    )
  );
  if (inputs.length > 0) return inputs[0].match;
  return getLargestVisibleExactText(page, value);
}

function parseLongDate(value) {
  const parsed = new Date(`${String(value).replace(/,/g, "")} 12:00:00 UTC`);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`Could not understand appointment date: ${value}`);
  }
  return parsed;
}

async function chooseCalendarDate(page, controlText, targetIsoDate) {
  const control = await findVisibleControlByValueOrText(page, controlText);
  if (!control) {
    throw new Error(`Could not find date control: ${controlText}`);
  }
  await control.click();
  await page.waitForTimeout(500);

  const current = parseLongDate(controlText);
  const [targetYear, targetMonth, targetDay] = targetIsoDate
    .split("-")
    .map(Number);
  const monthDifference =
    (targetYear - current.getUTCFullYear()) * 12 +
    (targetMonth - (current.getUTCMonth() + 1));

  if (Math.abs(monthDifference) > 18) {
    throw new Error("Automatic rescheduling is limited to 18 months.");
  }

  for (let step = 0; step < Math.abs(monthDifference); step += 1) {
    const monthNames = [
      "Jan", "Feb", "Mar", "Apr", "May", "Jun",
      "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"
    ];
    const shownMonth = monthNames[
      (current.getUTCMonth() +
        (monthDifference > 0 ? step : -step) +
        12) % 12
    ];
    const monthLabel = await getLargestVisibleExactText(page, shownMonth);
    if (!monthLabel) {
      throw new Error("Could not locate the calendar month controls.");
    }
    const box = await monthLabel.boundingBox();
    if (!box) throw new Error("Calendar month control had no position.");

    await page.mouse.click(
      monthDifference > 0 ? box.x + 165 : box.x - 60,
      box.y + box.height / 2
    );
    await page.waitForTimeout(250);
  }

  const dayMatches = await getVisibleMatches(
    page,
    new RegExp(`^${targetDay}$`)
  );
  const day = dayMatches
    .filter(({ box }) => box.width < 80 && box.height < 80)
    .sort((a, b) => b.box.y - a.box.y)[0];

  if (!day) {
    throw new Error(`Could not find day ${targetDay} in the open calendar.`);
  }
  await day.match.click();
  await page.waitForTimeout(500);
}

async function getTimeSpinnerParts(page) {
  const meridiems = await getVisibleMatches(page, /^(AM|PM)$/);
  if (meridiems.length === 0) {
    throw new Error("Could not find the AM/PM control in the time picker.");
  }

  const meridiem = meridiems[meridiems.length - 1];
  const numbers = await getVisibleMatches(page, /^\d{2}$/);
  const nearby = numbers
    .filter(({ box }) =>
      box.y > meridiem.box.y - 40 &&
      box.y < meridiem.box.y + 40 &&
      box.x < meridiem.box.x
    )
    .sort((a, b) => a.box.x - b.box.x);

  if (nearby.length < 2) {
    throw new Error("Could not find the hour and minute spinner values.");
  }

  return {
    hour: nearby[nearby.length - 2],
    minute: nearby[nearby.length - 1],
    meridiem
  };
}

async function spinValue(page, partName, targetValue, maximumClicks) {
  for (let clickCount = 0; clickCount <= maximumClicks; clickCount += 1) {
    const parts = await getTimeSpinnerParts(page);
    const part = parts[partName];
    const currentValue = Number((await part.match.innerText()).trim());

    if (currentValue === targetValue) return;

    let clickUp;
    if (partName === "hour") {
      const upDistance = (targetValue - currentValue + 12) % 12;
      const downDistance = (currentValue - targetValue + 12) % 12;
      clickUp = upDistance <= downDistance;
    } else {
      const upDistance = (targetValue - currentValue + 60) % 60;
      const downDistance = (currentValue - targetValue + 60) % 60;
      clickUp = upDistance <= downDistance;
    }

    await page.mouse.click(
      part.box.x + part.box.width / 2,
      clickUp ? part.box.y - 42 : part.box.y + part.box.height + 20
    );
    await page.waitForTimeout(100);
  }

  throw new Error(`Could not set the ${partName} spinner.`);
}

async function chooseClockTime(page, controlText, targetMinutes) {
  const control = await findVisibleControlByValueOrText(page, controlText);
  if (!control) {
    throw new Error(`Could not find time control: ${controlText}`);
  }
  await control.click();
  await page.waitForTimeout(500);

  const targetHour24 = Math.floor(targetMinutes / 60) % 24;
  const targetHour12 = targetHour24 % 12 || 12;
  const targetMinute = targetMinutes % 60;
  const targetMeridiem = targetHour24 >= 12 ? "PM" : "AM";

  await spinValue(page, "hour", targetHour12, 12);
  await spinValue(page, "minute", targetMinute, 60);

  const parts = await getTimeSpinnerParts(page);
  const currentMeridiem = (await parts.meridiem.match.innerText())
    .trim()
    .toUpperCase();
  if (currentMeridiem !== targetMeridiem) {
    await parts.meridiem.match.click();
  }

  await page.keyboard.press("Escape").catch(() => {});
  await page.waitForTimeout(400);
}

async function getStoredAppointmentControls(page) {
  const fromDate = page.locator('input[name^="multi_stpartdate_"]').first();
  const fromTime = page.locator('input[name^="multi_stparttime_"]').first();
  const toDate = page.locator('input[name^="multi_etpartdate_"]').first();
  const toTime = page.locator('input[name^="multi_etparttime_"]').first();

  if (
    (await fromDate.count()) === 0 ||
    (await fromTime.count()) === 0 ||
    (await toDate.count()) === 0 ||
    (await toTime.count()) === 0
  ) {
    throw new Error(
      "Could not find OctopusPro's stored appointment date/time fields."
    );
  }

  return { fromDate, fromTime, toDate, toTime };
}

async function readStoredAppointment(page) {
  const controls = await getStoredAppointmentControls(page);
  return {
    controls,
    fromDate: (await controls.fromDate.inputValue()).trim(),
    fromTime: (await controls.fromTime.inputValue()).trim(),
    toDate: (await controls.toDate.inputValue()).trim(),
    toTime: (await controls.toTime.inputValue()).trim()
  };
}

async function setStoredAppointmentValue(input, value) {
  await input.evaluate((element, nextValue) => {
    const valueSetter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value"
    )?.set;
    if (valueSetter) valueSetter.call(element, nextValue);
    else element.value = nextValue;
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
    element.dispatchEvent(new Event("blur", { bubbles: true }));
  }, value);
}

async function applyStoredAppointment(page, values) {
  await page.evaluate((nextValues) => {
    const selectors = {
      fromDate: 'input[name^="multi_stpartdate_"]',
      fromTime: 'input[name^="multi_stparttime_"]',
      toDate: 'input[name^="multi_etpartdate_"]',
      toTime: 'input[name^="multi_etparttime_"]'
    };
    const fields = {};

    for (const [key, selector] of Object.entries(selectors)) {
      const field = document.querySelector(selector);
      if (!field) throw new Error(`Missing appointment field: ${key}`);
      fields[key] = field;
    }

    const valueSetter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value"
    )?.set;

    for (const [key, field] of Object.entries(fields)) {
      if (valueSetter) valueSetter.call(field, nextValues[key]);
      else field.value = nextValues[key];
    }

    const dateFlag = document.querySelector("#booking_date_updates_flag");
    const bookingFlag = document.querySelector("#booking_updates_flag");
    if (dateFlag) dateFlag.value = "1";
    if (bookingFlag) bookingFlag.value = "1";

    for (const field of Object.values(fields)) {
      field.dispatchEvent(new Event("input", { bubbles: true }));
      field.dispatchEvent(new Event("change", { bubbles: true }));
    }
  }, values);
}

function summarizeCapturedWrite(request) {
  const rawBody = request.postData() || "";
  const relevant = {};
  try {
    const params = new URLSearchParams(rawBody);
    for (const [key, value] of params.entries()) {
      if (/booking|stpart|etpart|date|time|update/i.test(key)) {
        relevant[key] = value;
      }
    }
  } catch {}

  return {
    method: request.method(),
    url: request.url(),
    content_type: request.headers()["content-type"] || "",
    relevant_fields: relevant,
    body_length: rawBody.length
  };
}

async function rescheduleBooking(page) {
  const initialState = await getPageState(page);

  if (initialState.cancelled) {
    logResult({
      ok: false,
      action: "reschedule",
      booking_id: Number(bookingId),
      outcome: "staff_review_required",
      reason: "A cancelled booking cannot be rescheduled automatically.",
      changed: false
    });
    return;
  }

  if (initialState.unsafeState) {
    logResult({
      ok: false,
      action: "reschedule",
      booking_id: Number(bookingId),
      outcome: "staff_review_required",
      reason: `Fieldworker status may be ${initialState.unsafeState}.`,
      changed: false
    });
    return;
  }

  if (!initialState.toDo) {
    logResult({
      ok: false,
      action: "reschedule",
      booking_id: Number(bookingId),
      outcome: "staff_review_required",
      reason: "Booking is not clearly in TO DO status.",
      changed: false
    });
    return;
  }

  const initialAppointment = await readStoredAppointment(page);
  const oldFromDate = initialAppointment.fromDate;
  const oldFromTime = initialAppointment.fromTime;
  const oldToTime = initialAppointment.toTime;
  const oldDurationMinutes =
    (parseClockTime(oldToTime) - parseClockTime(oldFromTime) + 1440) % 1440;

  if (oldDurationMinutes <= 0 || oldDurationMinutes > 12 * 60) {
    throw new Error(
      `The existing appointment duration is unsafe: ${oldFromTime} to ${oldToTime}.`
    );
  }

  const newDateText = formatLongDate(requestedDate);
  const newStartMinutes = parseClockTime(requestedStartTime);
  const newStartText = formatClockTime(newStartMinutes);
  const newEndText = formatClockTime(
    newStartMinutes + oldDurationMinutes
  );

  console.log("Rescheduling appointment:", {
    oldFromDate,
    oldFromTime,
    oldToTime,
    newDate: newDateText,
    newStartTime: newStartText,
    newEndTime: newEndText,
    preservedDurationMinutes: oldDurationMinutes
  });

  console.log("Applying appointment values...");
  await applyStoredAppointment(page, {
    fromDate: newDateText,
    fromTime: newStartText,
    toDate: newDateText,
    toTime: newEndText
  });
  console.log("Appointment values applied.");
  await page.waitForTimeout(1000);

  let capturedWrite = null;
  if (mode === "capture-reschedule") {
    await page.route("**/*", async (route) => {
      const request = route.request();
      if (!["GET", "HEAD", "OPTIONS"].includes(request.method())) {
        if (!capturedWrite) capturedWrite = summarizeCapturedWrite(request);
        await route.abort("blockedbyclient");
        return;
      }
      await route.continue();
    });
  }

  const saveChangesButton = await waitForLargestVisibleExactText(
    page,
    "Save changes",
    20000
  );
  if (!saveChangesButton) {
    throw new Error("Could not find the visible Save changes button.");
  }
  console.log("Clicking Save changes...");
  await saveChangesButton.click();

  if (mode === "capture-reschedule") {
    await page.waitForTimeout(5000);
    logResult({
      ok: Boolean(capturedWrite),
      action: "capture-reschedule",
      booking_id: Number(bookingId),
      outcome: capturedWrite ? "save_request_captured_and_blocked" : "no_write_request_captured",
      requested_date: newDateText,
      requested_start_time: newStartText,
      requested_end_time: newEndText,
      captured_write: capturedWrite,
      customer_notification_sent: false,
      changed: false
    });
    return;
  }

  console.log("Save changes clicked; waiting for Notify Customer...");

  const notifyHeading = page.getByText("Notify Customer", { exact: true });
  await notifyHeading.waitFor({ state: "visible", timeout: 30000 });

  const verifier = await page.context().newPage();
  await verifier.goto(page.url(), { waitUntil: "domcontentloaded", timeout: 60000 });
  await verifier.waitForTimeout(4000);
  const persistedAppointment = await readStoredAppointment(verifier);
  await verifier.close();
  const persisted =
    normalizeDateText(persistedAppointment.fromDate) === normalizeDateText(newDateText) &&
    normalizeDateText(persistedAppointment.toDate) === normalizeDateText(newDateText) &&
    parseClockTime(persistedAppointment.fromTime) === newStartMinutes &&
    parseClockTime(persistedAppointment.toTime) ===
      (newStartMinutes + oldDurationMinutes) % 1440;

  if (!persisted) {
    logResult({
      ok: false,
      action: "reschedule",
      booking_id: Number(bookingId),
      outcome: "save_not_persisted_notification_blocked",
      previous_date: oldFromDate,
      previous_start_time: oldFromTime,
      previous_end_time: oldToTime,
      requested_date: newDateText,
      requested_start_time: newStartText,
      requested_end_time: newEndText,
      customer_notification_sent: false,
      verified_rescheduled_in_octopus: false,
      changed: false
    });
    return;
  }

  const sendButton = await waitForLargestVisibleExactText(page, "Send", 20000);
  if (!sendButton) {
    throw new Error("Could not find the Notify Customer Send button.");
  }
  await sendButton.click();
  await page.waitForTimeout(4000);

  await page.reload({ waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(5000);

  const savedAppointment = await readStoredAppointment(page);
  const savedFromDate = savedAppointment.fromDate;
  const savedFromTime = savedAppointment.fromTime;
  const savedToDate = savedAppointment.toDate;
  const savedToTime = savedAppointment.toTime;

  const dateVerified =
    normalizeDateText(savedFromDate) === normalizeDateText(newDateText) &&
    normalizeDateText(savedToDate) === normalizeDateText(newDateText);
  const timeVerified =
    parseClockTime(savedFromTime) === newStartMinutes &&
    parseClockTime(savedToTime) ===
      (newStartMinutes + oldDurationMinutes) % 1440;
  const verified = dateVerified && timeVerified;

  logResult({
    ok: verified,
    action: "reschedule",
    booking_id: Number(bookingId),
    outcome: verified ? "rescheduled" : "verification_failed",
    previous_date: oldFromDate,
    previous_start_time: oldFromTime,
    previous_end_time: oldToTime,
    new_date: savedFromDate,
    new_start_time: savedFromTime,
    new_end_time: savedToTime,
    duration_minutes: oldDurationMinutes,
    customer_notification_sent: true,
    verified_rescheduled_in_octopus: verified,
    changed: verified
  });
}

async function diagnoseBookingPage(page) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    await page.evaluate(() => {
      window.scrollBy(0, 800);
      for (const element of document.querySelectorAll("*")) {
        if (element.scrollHeight > element.clientHeight + 20) {
          element.scrollTop = Math.min(
            element.scrollTop + 800,
            element.scrollHeight
          );
          element.dispatchEvent(new Event("scroll", { bubbles: true }));
        }
      }
    });
    await page.waitForTimeout(300);
  }

  const diagnostics = await page.evaluate(() => {
    const bodyText = document.body?.innerText || "";
    const relevantLines = bodyText
      .split("\n")
      .map((line) => line.trim())
      .filter((line) =>
        /scheduled|appointment|from|to|upcoming|fieldworker|save changes/i.test(line)
      )
      .slice(0, 120);

    const inputs = Array.from(document.querySelectorAll("input")).map(
      (input) => {
        const rect = input.getBoundingClientRect();
        const style = window.getComputedStyle(input);
        return {
          type: input.type,
          name: input.name,
          id: input.id,
          value: input.value,
          placeholder: input.placeholder,
          visible:
            style.display !== "none" &&
            style.visibility !== "hidden" &&
            rect.width > 0 &&
            rect.height > 0,
          x: Math.round(rect.x),
          y: Math.round(rect.y)
        };
      }
    );

    const scrollableElements = Array.from(document.querySelectorAll("*"))
      .filter((element) => element.scrollHeight > element.clientHeight + 20)
      .slice(0, 40)
      .map((element) => ({
        tag: element.tagName,
        id: element.id,
        className: String(element.className || "").slice(0, 180),
        clientHeight: element.clientHeight,
        scrollHeight: element.scrollHeight,
        scrollTop: element.scrollTop
      }));

    return {
      url: location.href,
      title: document.title,
      body_contains_scheduled_appointments:
        /scheduled appointments/i.test(bodyText),
      relevant_text_lines: relevantLines,
      inputs,
      scrollable_elements: scrollableElements
    };
  });

  diagnostics.frames = page.frames().map((frame) => frame.url());

  logResult({
    ok: true,
    action: "diagnose",
    booking_id: Number(bookingId),
    changed: false,
    diagnostics
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
    else if (["reschedule", "capture-reschedule"].includes(mode)) await rescheduleBooking(page);
    else if (mode === "diagnose") await diagnoseBookingPage(page);
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
