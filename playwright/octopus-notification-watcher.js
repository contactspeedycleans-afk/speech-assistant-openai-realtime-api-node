import { chromium } from "playwright";
import pg from "pg";

const { Pool } = pg;

const NOTIFICATIONS_URL = process.env.OCTOPUS_NOTIFICATIONS_URL;
const DATABASE_URL = process.env.DATABASE_URL;
const STORAGE_STATE_PATH =
  process.env.OCTOPUS_STORAGE_STATE_PATH ||
  "/app/data/octopus-storage-state.json";

if (!NOTIFICATIONS_URL) {
  throw new Error("Missing OCTOPUS_NOTIFICATIONS_URL");
}

if (!DATABASE_URL) {
  throw new Error("Missing DATABASE_URL");
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false }
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

async function readNotifications(page) {
  await page.goto(NOTIFICATIONS_URL, {
    waitUntil: "domcontentloaded",
    timeout: 60000
  });

  if (
    page.url().toLowerCase().includes("login") ||
    page.url().toLowerCase().includes("signin")
  ) {
    throw new Error("OctopusPro login session expired");
  }

  const links = page.locator('a[href^="/booking/view/"]');

  await links.first().waitFor({
    state: "visible",
    timeout: 20000
  });

  const count = await links.count();

  for (let index = 0; index < Math.min(count, 100); index += 1) {
    const link = links.nth(index);
    const text = (await link.innerText()).trim();
    const href = await link.getAttribute("href");

    if (!text || !href) continue;

    const bookingNumber = extractBookingNumber(text);

    if (!bookingNumber) continue;

    await saveNotification({
      bookingNumber,
      eventType: classifyNotification(text),
      fieldworkerName: extractWorkerName(text),
      text,
      href,
      notificationKey: `${href}|${text}`
    });
  }

  console.log(`Checked ${count} OctopusPro notification links.`);
}

async function main() {
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"]
  });

  const context = await browser.newContext({
    storageState: STORAGE_STATE_PATH
  });

  const page = await context.newPage();

  await readNotifications(page);

  setInterval(async () => {
    try {
      await readNotifications(page);
    } catch (error) {
      console.error("Notification check failed:", error);
    }
  }, 15000);
}

main().catch((error) => {
  console.error("Watcher startup failed:", error);
  process.exit(1);
});
