import { chromium } from "playwright";
import pg from "pg";

const { Pool } = pg;

const NOTIFICATIONS_URL = process.env.OCTOPUS_NOTIFICATIONS_URL;
const OCTOPUS_EMAIL = process.env.OCTOPUS_EMAIL;
const OCTOPUS_PASSWORD = process.env.OCTOPUS_PASSWORD;
const DATABASE_URL = process.env.DATABASE_URL;

if (!NOTIFICATIONS_URL) {
  throw new Error("Missing OCTOPUS_NOTIFICATIONS_URL");
}

if (!OCTOPUS_EMAIL) {
  throw new Error("Missing OCTOPUS_EMAIL");
}

if (!OCTOPUS_PASSWORD) {
  throw new Error("Missing OCTOPUS_PASSWORD");
}

if (!DATABASE_URL) {
  throw new Error("Missing DATABASE_URL");
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

function classifyNotification(text) {
  const value = text.toLowerCase();

  if (value.includes("on the way")) return "ON_THE_WAY";
  if (value.includes("automatically checked in")) return "CHECKED_IN";
  if (value.includes("has arrived")) return "ARRIVED";
  if (value.includes("has started")) return "STARTED";
  if (value.includes("has finished")) return "FINISHED";
  if (value.includes("new photos added")) return "PHOTOS_ADDED";
  if (value.includes("wrote")) return "DISCUSSION";

  return "OTHER";
}

function extractBookingNumber(text) {
  const match = text.match(/BOK-\d+/i);
  return match ? match[0].toUpperCase() : null;
}

function extractWorkerName(text) {
  const match = text.match(
    /^(.*?)\s+(?:has finished|has started|has arrived|is on the way|has been automatically checked in)/i
  );

  return match ? match[1].trim() : null;
}

async function saveNotification(notification) {
  await pool.query(
    `
    INSERT INTO public.booking_activity (
      booking_number,
      event_type,
      fieldworker_name,
      service_address,
      event_time,
      eta_text,
      notification_text,
      notification_key
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    ON CONFLICT (notification_key) DO NOTHING;
    `,
    [
      notification.bookingNumber,
      notification.eventType,
      notification.fieldworkerName,
      null,
      null,
      null,
      notification.text,
      notification.notificationKey
    ]
  );
}

async function loginToOctopus(page) {
  console.log("Logging into OctopusPro...");

  await page.goto("https://admin.octopuspro.com/login", {
    waitUntil: "domcontentloaded",
    timeout: 60000
  });

  const emailInput = page
    .locator(
      'input[type="email"], input[name="email"], input[name="username"], #email'
    )
    .first();

  const passwordInput = page
    .locator(
      'input[type="password"], input[name="password"], #password'
    )
    .first();

  await emailInput.waitFor({
    state: "visible",
    timeout: 30000
  });

  await emailInput.fill(OCTOPUS_EMAIL);
  await passwordInput.fill(OCTOPUS_PASSWORD);

  const submitButton = page
    .locator('button[type="submit"], input[type="submit"]')
    .first();

  await submitButton.click();

  try {
    await page.waitForURL(
      (url) => !url.toString().toLowerCase().includes("/login"),
      {
        timeout: 60000
      }
    );
  } catch {
    throw new Error(
      `OctopusPro login did not leave the login page. Current URL: ${page.url()}`
    );
  }

  await page.waitForLoadState("domcontentloaded");
  await page.waitForTimeout(3000);

  console.log("URL after login:", page.url());

  if (page.url().toLowerCase().includes("/login")) {
    throw new Error("OctopusPro login failed or returned to the login page.");
  }

  console.log("OctopusPro login successful.");
}

async function ensureLoggedIn(page) {
  await page.goto(NOTIFICATIONS_URL, {
    waitUntil: "domcontentloaded",
    timeout: 60000
  });

  if (page.url().toLowerCase().includes("/login")) {
    await loginToOctopus(page);

    await page.goto(NOTIFICATIONS_URL, {
      waitUntil: "domcontentloaded",
      timeout: 60000
    });

    await page.waitForTimeout(5000);
  }

  if (page.url().toLowerCase().includes("/login")) {
    throw new Error(
      `Still logged out after login attempt. Current URL: ${page.url()}`
    );
  }
}

async function readNotifications(page) {
  await ensureLoggedIn(page);

  console.log("Current Octopus URL:", page.url());
  console.log("Page title:", await page.title());

  const bodyText = await page.locator("body").innerText();

  console.log("Page text preview:", bodyText.slice(0, 1000));

  const links = page.locator('a[href^="/booking/view/"]');

  try {
    await links.first().waitFor({
      state: "visible",
      timeout: 20000
    });
  } catch {
    console.log("No booking notification links were found.");
    return;
  }

  const count = await links.count();

  for (let index = 0; index < Math.min(count, 100); index += 1) {
    const link = links.nth(index);
    const text = (await link.innerText()).trim();
    const href = await link.getAttribute("href");

    if (!text || !href) {
      continue;
    }

    const bookingNumber = extractBookingNumber(text);

    if (!bookingNumber) {
      continue;
    }

    await saveNotification({
      bookingNumber,
      eventType: classifyNotification(text),
      fieldworkerName: extractWorkerName(text),
      text,
      notificationKey: `${href}|${text}`
    });
  }

  console.log(`Checked ${count} OctopusPro notification links.`);
}

async function main() {
  const browser = await chromium.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage"
    ]
  });

  const context = await browser.newContext();
  const page = await context.newPage();

  await readNotifications(page);

  let checkRunning = false;

  setInterval(async () => {
    if (checkRunning) {
      return;
    }

    checkRunning = true;

    try {
      await readNotifications(page);
    } catch (error) {
      console.error("Notification check failed:", error);
    } finally {
      checkRunning = false;
    }
  }, 15000);
}

main().catch((error) => {
  console.error("Watcher startup failed:", error);
  process.exit(1);
});
