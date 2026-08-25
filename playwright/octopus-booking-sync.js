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

function normalizeUsPhone(value) {
  const digits = String(value || "").replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) return digits.slice(1);
  return digits.length === 10 ? digits : null;
}

async function extractHiddenCustomerPhones(page) {
  const candidates = new Set();

  const collect = async () => {
    const values = await page.evaluate(() => {
      const results = [];

      for (const anchor of document.querySelectorAll('a[href^="tel:"]')) {
        results.push(anchor.getAttribute("href") || "");
      }

      for (const input of document.querySelectorAll("input")) {
        const identity = [
          input.type,
          input.name,
          input.id,
          input.placeholder,
          input.getAttribute("aria-label")
        ].filter(Boolean).join(" ");

        if (/phone|mobile|cell|telephone|tel/i.test(identity)) {
          results.push(input.value || "");
        }
      }

      return results;
    });

    for (const value of values) {
      const phone = normalizeUsPhone(value);
      if (phone) candidates.add(phone);
    }
  };

  await collect();

  const customerHeading = page.getByText("Customers", { exact: true }).first();
  if (!(await customerHeading.isVisible().catch(() => false))) {
    return [...candidates];
  }

  const marker = `booking-sync-customer-${Date.now()}`;
  await customerHeading.evaluate((heading, value) => {
    let region = heading.parentElement;

    while (region && region !== document.body) {
      const text = String(region.innerText || "").trim();
      const controls = region.querySelectorAll(
        'button, [role="button"], a, [data-toggle], [data-bs-toggle]'
      ).length;
      if (controls > 0 && text.length < 1000) break;
      region = region.parentElement;
    }

    (region || heading.parentElement || heading)
      .setAttribute("data-booking-sync-customer", value);
  }, marker);

  const region = page.locator(
    `[data-booking-sync-customer="${marker}"]`
  );
  const controls = region.locator(
    'button:visible, [role="button"]:visible, a:visible, [data-toggle]:visible, [data-bs-toggle]:visible'
  );
  const count = Math.min(await controls.count(), 10);

  for (let index = 0; index < count; index += 1) {
    await controls.nth(index).click().catch(() => {});
    await page.waitForTimeout(500);

    const editChoice = page
      .locator(
        '[role="menu"]:visible >> text=/^edit$/i, .dropdown-menu:visible >> text=/^edit$/i, button:visible >> text=/^edit$/i'
      )
      .first();

    if (await editChoice.isVisible().catch(() => false)) {
      await editChoice.click().catch(() => {});
      await page.waitForTimeout(700);
    }

    await collect();
    if (candidates.size > 0) break;
  }

  const close = page
    .locator(
      '[role="dialog"] button[aria-label*="close" i], .modal.show button[aria-label*="close" i], .modal.show .close'
    )
    .first();
  if (await close.isVisible().catch(() => false)) {
    await close.click().catch(() => {});
  }

  return [...candidates];
}

async function extractBookingDetails(page) {
  const details = await page.evaluate(() => {
    const phoneValues = [];

    for (const anchor of document.querySelectorAll('a[href^="tel:"]')) {
      phoneValues.push(anchor.getAttribute("href") || "");
    }

    for (const input of document.querySelectorAll("input")) {
      const identity = [
        input.type,
        input.name,
        input.id,
        input.placeholder,
        input.getAttribute("aria-label")
      ].filter(Boolean).join(" ");

      if (/phone|mobile|cell|telephone|tel/i.test(identity)) {
        phoneValues.push(input.value || "");
      }
    }

    return {
      bodyText: document.body.innerText || "",
      phoneValues
    };
  });

  const customerPhones = [...new Set(
    details.phoneValues
      .map(normalizeUsPhone)
      .filter(Boolean)
  )];

  if (customerPhones.length === 0) {
    const hiddenPhones = await extractHiddenCustomerPhones(page);
    customerPhones.push(...hiddenPhones);
  }
  const dateMatch = details.bodyText.match(
    /\b(\d{1,2})\s+(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+(20\d{2})\b/i
  );
  const timeMatch = details.bodyText.match(
    /\b(\d{1,2}):(\d{2})\s*(am|pm)\s*-\s*(\d{1,2}):(\d{2})\s*(am|pm)\b/i
  );

  let bookingDate = null;
  if (dateMatch) {
    const months = {
      jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
      jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12
    };
    const month = months[dateMatch[2].slice(0, 3).toLowerCase()];
    bookingDate = `${dateMatch[3]}-${String(month).padStart(2, "0")}-${String(dateMatch[1]).padStart(2, "0")}T12:00:00.000Z`;
  }

  return {
    customerPhone: customerPhones[0] || null,
    customerPhones: [...new Set(customerPhones)],
    bookingDate,
    arrivalWindow: timeMatch
      ? timeMatch[0].replace(/\s+/g, " ").trim()
      : null
  };
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
async function seedMissingDispatchBookings() {
  const result = await pool.query(
    `
    INSERT INTO public.booking_tracking (
      booking_number,
      tracking_token,
      status,
      octopus_booking_id,
      octopus_booking_url,
      updated_at
    )
    SELECT
      dispatch.booking_number,
      md5(
        dispatch.booking_number
        || '-'
        || COALESCE(dispatch.octopus_booking_id::text, '')
        || '-'
        || NOW()::text
        || '-'
        || random()::text
      ),
      dispatch.assignment_status,
      dispatch.octopus_booking_id,
      dispatch.octopus_booking_url,
      NOW()
    FROM public.booking_dispatch_state AS dispatch
    LEFT JOIN public.booking_tracking AS tracking
      ON tracking.booking_number = dispatch.booking_number
    WHERE
      tracking.booking_number IS NULL
      AND dispatch.assignment_status = 'NEEDS CLEANER'
      AND dispatch.octopus_booking_id IS NOT NULL
      AND dispatch.octopus_booking_url IS NOT NULL
    ON CONFLICT (booking_number)
    DO UPDATE SET
      octopus_booking_id = COALESCE(
        EXCLUDED.octopus_booking_id,
        public.booking_tracking.octopus_booking_id
      ),
      octopus_booking_url = COALESCE(
        EXCLUDED.octopus_booking_url,
        public.booking_tracking.octopus_booking_url
      ),
      updated_at = NOW()
    RETURNING booking_number;
    `
  );

  if (result.rowCount > 0) {
    console.log(
      `Seeded ${result.rowCount} missing dispatch booking(s) into booking_tracking:`,
      result.rows.map((row) => row.booking_number)
    );
  }

  return result.rows;
}
async function loadBookingsToSync() {
  const result = await pool.query(
    `
    SELECT
      booking_number,
      octopus_booking_id,
      octopus_booking_url,
      status,
      billing_synced_at,
      booking_details_synced_at,
      pricing_synced_at,
      updated_at
    FROM public.booking_tracking
    WHERE octopus_booking_url IS NOT NULL
      AND (
        pricing_synced_at IS NULL
        OR billing_synced_at IS NULL
        OR booking_details_synced_at IS NULL
        OR pricing_synced_at < updated_at
      )
    ORDER BY
      CASE
        WHEN booking_date >= CURRENT_DATE THEN 0
        WHEN booking_date IS NULL THEN 1
        ELSE 2
      END,
      CASE WHEN booking_details_synced_at IS NULL THEN 0 ELSE 1 END,
      updated_at DESC
    LIMIT 25;
    `
  );

  return result.rows;
}

async function savePricing(bookingNumber, pricing, details) {
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
      customer_phone_normalized = COALESCE($7, customer_phone_normalized),
      customer_phones_normalized = CASE
        WHEN COALESCE(array_length($10::text[], 1), 0) > 0
        THEN $10::text[]
        ELSE customer_phones_normalized
      END,
      booking_date = COALESCE($8, booking_date),
      arrival_window = COALESCE($9, arrival_window),
      customer_id = COALESCE(
        customer_id,
        (
          SELECT id
          FROM public.customers
          WHERE RIGHT(
            REGEXP_REPLACE(
              COALESCE(phone_normalized, phone, ''),
              '[^0-9]', '', 'g'
            ), 10
          ) = RIGHT(COALESCE($7, ''), 10)
          ORDER BY id DESC
          LIMIT 1
        )
      ),
      billing_synced_at = NOW(),
      booking_details_synced_at = NOW(),
      pricing_synced_at = NOW(),
      pricing_sync_error = NULL
      ,sync_retry_count = 0
      ,last_sync_attempt_at = NOW()
    WHERE booking_number = $1;
    `,
    [
      bookingNumber,
      pricing.hourlyRate,
      pricing.discountPercent,
      pricing.subtotal,
      pricing.finalTotal,
      pricing.durationMinutes,
      details.customerPhone,
      details.bookingDate,
      details.arrivalWindow,
      details.customerPhones || []
    ]
  );
}

async function saveSyncError(bookingNumber, error) {
  await pool.query(
    `
    UPDATE public.booking_tracking
    SET
      pricing_sync_error = $2
      ,sync_retry_count = COALESCE(sync_retry_count, 0) + 1
      ,last_sync_attempt_at = NOW()
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
  const details = await extractBookingDetails(page);

  console.log(
    `Pricing extracted for ${booking.booking_number}:`,
    pricing
  );

  console.log(
    `Customer and appointment details extracted for ${booking.booking_number}:`,
    {
      phoneLast4: details.customerPhone?.slice(-4) || null,
      phoneCount: details.customerPhones?.length || 0,
      bookingDate: details.bookingDate,
      arrivalWindow: details.arrivalWindow
    }
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
    pricing,
    details
  );

  console.log(
    `Pricing saved for ${booking.booking_number}.`
  );
}

async function runSyncCycle(page) {
  await seedMissingDispatchBookings();

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