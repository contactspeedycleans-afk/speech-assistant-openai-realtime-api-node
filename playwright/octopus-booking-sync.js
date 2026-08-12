import { chromium } from "playwright";
import pg from "pg";

const { Pool } = pg;

const DATABASE_URL = process.env.DATABASE_URL;
const OCTOPUS_EMAIL = process.env.OCTOPUS_EMAIL;
const OCTOPUS_PASSWORD = process.env.OCTOPUS_PASSWORD;

const ORGANIZATION_NAME =
  process.env.OCTOPUS_ORGANIZATION_NAME || "SpeedyCleans";

const SYNC_INTERVAL_MS = Number(
  process.env.BOOKING_SYNC_INTERVAL_MS || 300000
);

if (!DATABASE_URL) {
  throw new Error("Missing DATABASE_URL");
}

if (!OCTOPUS_EMAIL) {
  throw new Error("Missing OCTOPUS_EMAIL");
}

if (!OCTOPUS_PASSWORD) {
  throw new Error("Missing OCTOPUS_PASSWORD");
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

function parseNumber(value) {
  if (value === null || value === undefined) {
    return null;
  }

  const cleaned = String(value)
    .replace(/[$,%]/g, "")
    .replace(/,/g, "")
    .trim();

  if (!cleaned) {
    return null;
  }

  const number = Number(cleaned);

  return Number.isFinite(number) ? number : null;
}

async function selectOrganization(page) {
  console.log(
    `Selecting OctopusPro organization: ${ORGANIZATION_NAME}...`
  );

  await page.waitForTimeout(2500);

  const selects = page.locator("select");
  const selectCount = await selects.count();

  for (let index = 0; index < selectCount; index += 1) {
    const select = selects.nth(index);
    const options = await select.locator("option").allTextContents();

    const match = options.find((option) =>
      option
        .toLowerCase()
        .includes(ORGANIZATION_NAME.toLowerCase())
    );

    if (match) {
      await select.selectOption({
        label: match.trim()
      });

      console.log(`Selected organization: ${match.trim()}`);

      const submitButton = page
        .locator(
          'button[type="submit"], input[type="submit"]'
        )
        .first();

      if (await submitButton.isVisible().catch(() => false)) {
        await submitButton.click();
      } else {
        await page.keyboard.press("Enter");
      }

      await page.waitForTimeout(4000);
      return;
    }
  }

  const organizationText = page
    .getByText(ORGANIZATION_NAME, {
      exact: false
    })
    .first();

  if (await organizationText.isVisible().catch(() => false)) {
    await organizationText.click();
    await page.waitForTimeout(1000);

    const submitButton = page
      .locator(
        'button[type="submit"], input[type="submit"]'
      )
      .first();

    if (await submitButton.isVisible().catch(() => false)) {
      await submitButton.click();
    } else {
      await page.keyboard.press("Enter");
    }

    await page.waitForTimeout(4000);
    return;
  }

  throw new Error(
    `Could not select organization ${ORGANIZATION_NAME}`
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

  await passwordInput.waitFor({
    state: "visible",
    timeout: 30000
  });

  await emailInput.fill(OCTOPUS_EMAIL);
  await passwordInput.fill(OCTOPUS_PASSWORD);

  const submitButton = page
    .locator(
      'button[type="submit"], input[type="submit"]'
    )
    .first();

  await submitButton.click();

  await page.waitForTimeout(5000);

  if (
    page
      .url()
      .toLowerCase()
      .includes("/checkuserinmulticompanies")
  ) {
    await selectOrganization(page);
  }

  if (page.url().toLowerCase().includes("/login")) {
    throw new Error("OctopusPro login did not complete.");
  }

  console.log("OctopusPro login successful.");
}

async function ensureBookingPage(page, bookingUrl) {
  await page.goto(bookingUrl, {
    waitUntil: "domcontentloaded",
    timeout: 60000
  });

  await page.waitForTimeout(5000);

  if (page.url().toLowerCase().includes("/login")) {
    await loginToOctopus(page);

    await page.goto(bookingUrl, {
      waitUntil: "domcontentloaded",
      timeout: 60000
    });

    await page.waitForTimeout(5000);
  }

  if (
    page
      .url()
      .toLowerCase()
      .includes("/checkuserinmulticompanies")
  ) {
    await selectOrganization(page);

    await page.goto(bookingUrl, {
      waitUntil: "domcontentloaded",
      timeout: 60000
    });

    await page.waitForTimeout(5000);
  }
}

async function getInputValueNearText(page, labelText) {
  return page.evaluate((label) => {
    const normalize = (value) =>
      String(value || "")
        .replace(/\s+/g, " ")
        .trim()
        .toLowerCase();

    const target = normalize(label);

    const elements = Array.from(
      document.querySelectorAll(
        "label, div, span, p, h1, h2, h3, h4, h5, td, th"
      )
    );

    const labelElement = elements.find((element) => {
      const text = normalize(element.textContent);

      return text === target;
    });

    if (!labelElement) {
      return null;
    }

    let container = labelElement.parentElement;

    for (let level = 0; level < 5 && container; level += 1) {
      const input = container.querySelector(
        "input, select, textarea"
      );

      if (input) {
        return input.value || input.textContent || null;
      }

      container = container.parentElement;
    }

    return null;
  }, labelText);
}

async function extractBookingPricing(page) {
  const bodyText = await page.locator("body").innerText();

  const hourlyRateInput =
    await getInputValueNearText(page, "Price Per hour");

  const discountInput =
    await getInputValueNearText(page, "Discount");

  const subtotalInput =
    await getInputValueNearText(page, "Sub Total");

  const totalInput =
    await getInputValueNearText(page, "Total");

  let hourlyRate = parseNumber(hourlyRateInput);
  let discountPercent = parseNumber(discountInput);
  let subtotal = parseNumber(subtotalInput);
  let finalTotal = parseNumber(totalInput);

  // OctopusPro can place unrelated numeric inputs near the Discount label.
  // Never save an impossible percentage to PostgreSQL.
  if (
    discountPercent !== null &&
    (discountPercent < 0 || discountPercent > 100)
  ) {
    discountPercent = null;
  }

  if (hourlyRate === null) {
    const match = bodyText.match(
      /Price\s*Per\s*hour[\s\S]{0,80}?\$?\s*([\d,.]+)/i
    );

    hourlyRate = match ? parseNumber(match[1]) : null;
  }

  if (discountPercent === null) {
    const match = bodyText.match(
      /Discount[\s\S]{0,80}?([\d,.]+)\s*%/i
    );

    discountPercent = match
      ? parseNumber(match[1])
      : null;
  }

  if (
    discountPercent !== null &&
    (discountPercent < 0 || discountPercent > 100)
  ) {
    discountPercent = null;
  }

  if (subtotal === null) {
    const match = bodyText.match(
      /Sub\s*Total[\s\S]{0,80}?\$?\s*([\d,.]+)/i
    );

    subtotal = match ? parseNumber(match[1]) : null;
  }

  if (finalTotal === null) {
    const matches = Array.from(
      bodyText.matchAll(
        /(?:^|\n)Total\s*\$?\s*([\d,.]+)/gim
      )
    );

    if (matches.length > 0) {
      finalTotal = parseNumber(
        matches[matches.length - 1][1]
      );
    }
  }

  const durationMatch = bodyText.match(
    /Duration[\s\S]{0,150}?(\d+)\s*hrs?[\s\S]{0,50}?(\d+)\s*min/i
  );

  let durationMinutes = null;

  if (durationMatch) {
    const hours = Number(durationMatch[1]);
    const minutes = Number(durationMatch[2]);

    if (
      Number.isFinite(hours) &&
      Number.isFinite(minutes)
    ) {
      durationMinutes = hours * 60 + minutes;
    }
  }

const minimumTotal =
  hourlyRate !== null
    ? hourlyRate * 2
    : null;

if (
  finalTotal !== null &&
  minimumTotal !== null &&
  finalTotal < minimumTotal
) {
  finalTotal =
    subtotal !== null
      ? subtotal
      : minimumTotal;
}

return {
  hourlyRate,
  discountPercent,
  subtotal,
  finalTotal,
  durationMinutes
};
}

async function loadBookingsToSync() {
  const result = await pool.query(
    `
    SELECT
      booking_number,
      octopus_booking_id,
      octopus_booking_url,
      status,
      pricing_synced_at,
      updated_at
    FROM public.booking_tracking
    WHERE octopus_booking_url IS NOT NULL
      AND (
        pricing_synced_at IS NULL
        OR pricing_synced_at < updated_at
      )
    ORDER BY updated_at ASC
    LIMIT 10;
    `
  );

  return result.rows;
}

async function savePricing(bookingNumber, pricing) {
  await pool.query(
    `
    UPDATE public.booking_tracking
    SET
      hourly_rate = $2,
      discount_percent = $3,
      subtotal = $4,
      final_total = $5,
      duration_minutes = $6,
      invoice_total = $5,
      billing_synced_at = CASE
        WHEN customer_phone_normalized IS NOT NULL
        THEN NOW()
        ELSE billing_synced_at
      END,
      pricing_synced_at = NOW(),
      pricing_sync_error = NULL
    WHERE booking_number = $1;
    `,
    [
      bookingNumber,
      pricing.hourlyRate,
      pricing.discountPercent,
      pricing.subtotal,
      pricing.finalTotal,
      pricing.durationMinutes
    ]
  );
}

async function saveSyncError(bookingNumber, error) {
  await pool.query(
    `
    UPDATE public.booking_tracking
    SET
      pricing_sync_error = $2
    WHERE booking_number = $1;
    `,
    [
      bookingNumber,
      String(error?.message || error).slice(0, 2000)
    ]
  );
}

async function syncBooking(page, booking) {
  console.log(
    `Syncing pricing for ${booking.booking_number}...`
  );

  await ensureBookingPage(
    page,
    booking.octopus_booking_url
  );

  const pricing = await extractBookingPricing(page);

  console.log(
    `Pricing extracted for ${booking.booking_number}:`,
    pricing
  );

  if (
    pricing.hourlyRate === null &&
    pricing.subtotal === null &&
    pricing.finalTotal === null
  ) {
    throw new Error(
      "Could not find pricing values on the booking page."
    );
  }

  await savePricing(
    booking.booking_number,
    pricing
  );

  console.log(
    `Pricing saved for ${booking.booking_number}.`
  );
}

async function runSyncCycle(page) {
  const bookings = await loadBookingsToSync();

  if (bookings.length === 0) {
    console.log("No booking pricing records need syncing.");
    return;
  }

  console.log(
    `Found ${bookings.length} booking(s) needing pricing sync.`
  );

  for (const booking of bookings) {
    try {
      await syncBooking(page, booking);
    } catch (error) {
      console.error(
        `Pricing sync failed for ${booking.booking_number}:`,
        error
      );

      await saveSyncError(
        booking.booking_number,
        error
      ).catch(() => {});
    }
  }
}

async function main() {
  await pool.query("SELECT 1");

  console.log("PostgreSQL connected successfully.");

  const browser = await chromium.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage"
    ]
  });

  const context = await browser.newContext({
    viewport: {
      width: 1440,
      height: 1200
    }
  });

  const page = await context.newPage();

  page.setDefaultTimeout(30000);
  page.setDefaultNavigationTimeout(60000);

  await runSyncCycle(page);

  let cycleRunning = false;

  const interval = setInterval(async () => {
    if (cycleRunning) {
      console.log(
        "Previous pricing sync is still running. Skipping this cycle."
      );

      return;
    }

    cycleRunning = true;

    try {
      await runSyncCycle(page);
    } catch (error) {
      console.error("Booking sync cycle failed:", error);
    } finally {
      cycleRunning = false;
    }
  }, SYNC_INTERVAL_MS);

  const shutdown = async (signal) => {
    console.log(
      `Received ${signal}. Shutting down booking sync.`
    );

    clearInterval(interval);

    await browser.close().catch(() => {});
    await pool.end().catch(() => {});

    process.exit(0);
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch(async (error) => {
  console.error("Booking sync startup failed:", error);

  await pool.end().catch(() => {});

  process.exit(1);
});
