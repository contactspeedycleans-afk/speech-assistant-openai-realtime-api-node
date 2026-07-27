import { chromium } from "playwright";
import pg from "pg";

const { Pool } = pg;

const NOTIFICATIONS_URL = process.env.OCTOPUS_NOTIFICATIONS_URL;
const OCTOPUS_EMAIL = process.env.OCTOPUS_EMAIL;
const OCTOPUS_PASSWORD = process.env.OCTOPUS_PASSWORD;
const DATABASE_URL = process.env.DATABASE_URL;

const ORGANIZATION_NAME =
  process.env.OCTOPUS_ORGANIZATION_NAME || "SpeedyCleans";

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
  if (value.includes("photos added")) return "PHOTOS_ADDED";
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
  const result = await pool.query(
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
    ON CONFLICT (notification_key) DO NOTHING
    RETURNING id;
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

  if (result.rowCount > 0) {
    console.log(
      `Saved ${notification.eventType} event for ${notification.bookingNumber}.`
    );

    return true;
  }

  return false;
}

async function selectOrganization(page) {
  console.log(
    `Selecting OctopusPro organization: ${ORGANIZATION_NAME}...`
  );

  await page.waitForTimeout(3000);

  console.log(
    "Organization page text:",
    (await page.locator("body").innerText()).slice(0, 1500)
  );

  const selects = page.locator("select");
  const selectCount = await selects.count();

  let organizationSelected = false;

  for (let index = 0; index < selectCount; index += 1) {
    const select = selects.nth(index);
    const options = await select.locator("option").allTextContents();

    console.log(`Select ${index + 1} options:`, options);

    const matchingOption = options.find((option) =>
      option.toLowerCase().includes(ORGANIZATION_NAME.toLowerCase())
    );

    if (matchingOption) {
      await select.selectOption({
        label: matchingOption.trim()
      });

      console.log(`Selected option: ${matchingOption.trim()}`);
      organizationSelected = true;
      await page.waitForTimeout(1500);
      break;
    }
  }

  if (!organizationSelected) {
    const organizationText = page
      .getByText(ORGANIZATION_NAME, {
        exact: true
      })
      .first();

    if (await organizationText.isVisible().catch(() => false)) {
      await organizationText.click();
      console.log(`Clicked organization text: ${ORGANIZATION_NAME}`);
      organizationSelected = true;
      await page.waitForTimeout(1500);
    }
  }

  if (!organizationSelected) {
    const organizationContainingText = page
      .getByText(ORGANIZATION_NAME, {
        exact: false
      })
      .first();

    if (
      await organizationContainingText.isVisible().catch(() => false)
    ) {
      await organizationContainingText.click();
      console.log(
        `Clicked organization containing text: ${ORGANIZATION_NAME}`
      );
      organizationSelected = true;
      await page.waitForTimeout(1500);
    }
  }

  if (!organizationSelected) {
    throw new Error(
      `Could not find the ${ORGANIZATION_NAME} organization option.`
    );
  }

  const fieldworkerChoice = page
    .getByText("Fieldworker", {
      exact: false
    })
    .first();

  if (await fieldworkerChoice.isVisible().catch(() => false)) {
    try {
      await fieldworkerChoice.click();
      console.log("Selected Fieldworker role.");
      await page.waitForTimeout(1000);
    } catch {
      console.log(
        "Fieldworker role was visible but did not require a separate click."
      );
    }
  }

  const submitCandidates = [
    page.locator('button[type="submit"]').first(),
    page.locator('input[type="submit"]').first(),
    page.getByRole("button", { name: /continue/i }).first(),
    page.getByRole("button", { name: /select/i }).first(),
    page.getByRole("button", { name: /login/i }).first(),
    page.getByRole("button", { name: /submit/i }).first(),
    page.getByRole("button", { name: /^go$/i }).first(),
    page.getByRole("button", { name: /^ok$/i }).first()
  ];

  let submitted = false;

  for (const candidate of submitCandidates) {
    if (await candidate.isVisible().catch(() => false)) {
      try {
        await candidate.click();
        submitted = true;
        console.log("Submitted organization selection.");
        break;
      } catch {
        // Try the next possible button.
      }
    }
  }

  if (!submitted) {
    console.log(
      "No visible organization submit button found. Pressing Enter."
    );

    await page.keyboard.press("Enter");
  }

  try {
    await page.waitForURL(
      (url) =>
        !url
          .toString()
          .toLowerCase()
          .includes("/checkuserinmulticompanies"),
      {
        timeout: 60000
      }
    );
  } catch {
    throw new Error(
      `Organization selection did not complete. Current URL: ${page.url()}`
    );
  }

  await page.waitForLoadState("domcontentloaded").catch(() => {});
  await page.waitForTimeout(4000);

  console.log("URL after organization selection:", page.url());
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

  const keepSignedIn = page
    .locator(
      'input[type="checkbox"][name*="remember"], input[type="checkbox"]'
    )
    .first();

  if (await keepSignedIn.isVisible().catch(() => false)) {
    if (!(await keepSignedIn.isChecked().catch(() => false))) {
      await keepSignedIn.check().catch(() => {});
    }
  }

  const submitButton = page
    .locator('button[type="submit"], input[type="submit"]')
    .first();

  await submitButton.waitFor({
    state: "visible",
    timeout: 30000
  });

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

  await page.waitForLoadState("domcontentloaded").catch(() => {});
  await page.waitForTimeout(3000);

  console.log("URL after credentials:", page.url());

  if (
    page
      .url()
      .toLowerCase()
      .includes("/checkuserinmulticompanies")
  ) {
    await selectOrganization(page);
  }

  const finalUrl = page.url().toLowerCase();

  if (
    finalUrl.includes("/login") ||
    finalUrl.includes("logout=1") ||
    finalUrl.includes("/checkuserinmulticompanies")
  ) {
    throw new Error(
      `OctopusPro login did not complete. Current URL: ${page.url()}`
    );
  }

  console.log("OctopusPro login successful.");
}

async function ensureLoggedIn(page) {
  await page.goto(NOTIFICATIONS_URL, {
    waitUntil: "domcontentloaded",
    timeout: 60000
  });

  await page.waitForTimeout(3000);

  let currentUrl = page.url().toLowerCase();

  if (
    currentUrl.includes("/login") ||
    currentUrl.includes("logout=1")
  ) {
    await loginToOctopus(page);

    await page.goto(NOTIFICATIONS_URL, {
      waitUntil: "domcontentloaded",
      timeout: 60000
    });

    await page.waitForTimeout(5000);
  }

  currentUrl = page.url().toLowerCase();

  if (
    currentUrl.includes("/checkuserinmulticompanies")
  ) {
    await selectOrganization(page);

    await page.goto(NOTIFICATIONS_URL, {
      waitUntil: "domcontentloaded",
      timeout: 60000
    });

    await page.waitForTimeout(5000);
  }

  currentUrl = page.url().toLowerCase();

  if (
    currentUrl.includes("/login") ||
    currentUrl.includes("logout=1") ||
    currentUrl.includes("/checkuserinmulticompanies")
  ) {
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

  const links = page.locator(
    'a[href^="/booking/view/"], a[href*="/booking/view/"]'
  );

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
  let newNotifications = 0;

  for (
    let index = 0;
    index < Math.min(count, 100);
    index += 1
  ) {
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

    const inserted = await saveNotification({
      bookingNumber,
      eventType: classifyNotification(text),
      fieldworkerName: extractWorkerName(text),
      text,
      notificationKey: `${href}|${text}`
    });

    if (inserted) {
      newNotifications += 1;
    }
  }

  console.log(
    `Checked ${count} OctopusPro notification links. New events saved: ${newNotifications}.`
  );
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
      height: 1000
    }
  });

  const page = await context.newPage();

  page.setDefaultTimeout(30000);
  page.setDefaultNavigationTimeout(60000);

  await readNotifications(page);

  let checkRunning = false;

  setInterval(async () => {
    if (checkRunning) {
      console.log(
        "Previous notification check is still running. Skipping this cycle."
      );
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
  }, 60000);

  const shutdown = async (signal) => {
    console.log(`Received ${signal}. Shutting down watcher.`);

    await browser.close().catch(() => {});
    await pool.end().catch(() => {});

    process.exit(0);
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch(async (error) => {
  console.error("Watcher startup failed:", error);

  await pool.end().catch(() => {});

  process.exit(1);
});
