import { chromium } from "playwright";
import pg from "pg";

const { Pool } = pg;

const NOTIFICATIONS_URL = process.env.OCTOPUS_NOTIFICATIONS_URL;
const OCTOPUS_EMAIL = process.env.OCTOPUS_EMAIL;
const OCTOPUS_PASSWORD = process.env.OCTOPUS_PASSWORD;
const DATABASE_URL = process.env.DATABASE_URL;

const MAKE_WEBHOOK_URL = process.env.MAKE_WEBHOOK_URL;

const ASSIGNMENT_MAKE_WEBHOOK_URL =
  process.env.ASSIGNMENT_MAKE_WEBHOOK_URL;

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
if (!MAKE_WEBHOOK_URL) {
  throw new Error("Missing MAKE_WEBHOOK_URL");
}
if (!ASSIGNMENT_MAKE_WEBHOOK_URL) {
  throw new Error("Missing ASSIGNMENT_MAKE_WEBHOOK_URL");
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

function classifyNotification(text) {
  const value = text.toLowerCase();

  if (value.includes("accepted booking request")) return "ASSIGNED";
  if (value.includes("is no longer attending")) return "DROPPED";

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
function extractOctopusBookingId(href) {
  if (!href) return null;

  const match = href.match(/\/booking\/view\/(\d+)/i);

  return match ? Number(match[1]) : null;
}

function buildOctopusBookingUrl(href) {
  if (!href) return null;

  if (href.startsWith("http://") || href.startsWith("https://")) {
    return href;
  }

  return `https://admin.octopuspro.com${href}`;
}

function extractWorkerName(text) {
  const match = text.match(
    /^(.*?)\s+(?:has accepted booking request|is no longer attending|has finished|has started|has arrived|is on the way|has been automatically checked in)/i
  );

  return match ? match[1].trim() : null;
}


async function sendToMake(notification) {
  let eventType = notification.eventType;

  if (eventType === "CHECKED_IN") {
    eventType = "ARRIVED";
  }

  const supportedStatuses = [
    "ON_THE_WAY",
    "ARRIVED",
    "FINISHED"
  ];

  if (!supportedStatuses.includes(eventType)) {
    console.log(
      `Skipping Make webhook for unsupported event: ${eventType}`
    );

    return;
  }

  const trackingResult = await pool.query(
    `
    SELECT tracking_token
    FROM public.booking_tracking
    WHERE booking_number = $1
    LIMIT 1;
    `,
    [notification.bookingNumber]
  );

  const trackingToken =
    trackingResult.rows[0]?.tracking_token || "";

  const trackingLink =
    trackingToken
      ? `https://track.speedycleans.com/track/${trackingToken}`
      : "";

  const payload = {
    event_type: eventType,
    booking_number: notification.bookingNumber,
    fieldworker_name: notification.fieldworkerName || "",
    notification_text: notification.text || "",
    tracking_link: trackingLink,
    detected_at: new Date().toISOString()
  };

  const response = await fetch(MAKE_WEBHOOK_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  const responseText = await response.text();

  if (!response.ok) {
    throw new Error(
      `Make webhook failed with status ${response.status}: ${responseText}`
    );
  }

  console.log(
    `Make webhook sent: ${eventType} ${notification.bookingNumber}`
  );

  if (trackingLink) {
    console.log(
      `Tracking link included: ${trackingLink}`
    );
  } else {
    console.log(
      `No tracking link found for ${notification.bookingNumber}`
    );
  }
}

async function sendAssignmentToMake({
  bookingNumber,
  cleanerName = "",
  assignmentAction,
  notificationText = ""
}) {
  if (!bookingNumber || !assignmentAction) {
    return;
  }

  const payload = {
    detected_at: new Date().toISOString(),
    booking_number: bookingNumber,
    assignment_action: assignmentAction,
    notification_text: notificationText,
    cleaner_name: cleanerName
  };

  const response = await fetch(ASSIGNMENT_MAKE_WEBHOOK_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  const responseText = await response.text();

  if (!response.ok) {
    throw new Error(
      `Assignment webhook failed: ${response.status} ${responseText}`
    );
  }

  console.log(
    `Assignment webhook sent: ${assignmentAction} ${bookingNumber}`
  );
}
  

async function updateBookingTracking(notification) {
  const eventType =
    notification.eventType === "CHECKED_IN"
      ? "ARRIVED"
      : notification.eventType;

  const supportedStatuses = [
    "ON_THE_WAY",
    "ARRIVED",
    "STARTED",
    "FINISHED"
  ];

  if (!supportedStatuses.includes(eventType)) {
    console.log(
      `Skipping tracker update for unsupported event: ${eventType}`
    );

    return;
  }

  const trackingToken =
    `${notification.bookingNumber}-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2, 10)}`;

await pool.query(
  `
  INSERT INTO public.booking_tracking (
    booking_number,
    tracking_token,
    status,
    worker_name,
    octopus_booking_id,
    octopus_booking_url,
    on_the_way_at,
    arrived_at,
    started_at,
    finished_at,
    updated_at
  )
  VALUES (
    $1,
    $2,
    $3,
    $4,
    $5,
    $6,
    CASE WHEN $3 = 'ON_THE_WAY' THEN NOW() ELSE NULL END,
    CASE WHEN $3 = 'ARRIVED' THEN NOW() ELSE NULL END,
    CASE WHEN $3 = 'STARTED' THEN NOW() ELSE NULL END,
    CASE WHEN $3 = 'FINISHED' THEN NOW() ELSE NULL END,
    NOW()
  )
  ON CONFLICT (booking_number)
  DO UPDATE SET
    status = EXCLUDED.status,

    worker_name = COALESCE(
      EXCLUDED.worker_name,
      public.booking_tracking.worker_name
    ),

    octopus_booking_id = COALESCE(
      EXCLUDED.octopus_booking_id,
      public.booking_tracking.octopus_booking_id
    ),

    octopus_booking_url = COALESCE(
      EXCLUDED.octopus_booking_url,
      public.booking_tracking.octopus_booking_url
    ),

    on_the_way_at = CASE
      WHEN EXCLUDED.status = 'ON_THE_WAY'
      THEN COALESCE(
        public.booking_tracking.on_the_way_at,
        NOW()
      )
      ELSE public.booking_tracking.on_the_way_at
    END,

    arrived_at = CASE
      WHEN EXCLUDED.status = 'ARRIVED'
      THEN COALESCE(
        public.booking_tracking.arrived_at,
        NOW()
      )
      ELSE public.booking_tracking.arrived_at
    END,

    started_at = CASE
      WHEN EXCLUDED.status = 'STARTED'
      THEN COALESCE(
        public.booking_tracking.started_at,
        NOW()
      )
      ELSE public.booking_tracking.started_at
    END,

    finished_at = CASE
      WHEN EXCLUDED.status = 'FINISHED'
      THEN COALESCE(
        public.booking_tracking.finished_at,
        NOW()
      )
      ELSE public.booking_tracking.finished_at
    END,

    updated_at = NOW();
  `,
  [
    notification.bookingNumber,
    trackingToken,
    eventType,
    notification.fieldworkerName,
    notification.octopusBookingId,
    notification.octopusBookingUrl
  ]
);

  console.log(
    `Tracking updated: ${eventType} ${notification.bookingNumber}`
  );
}

async function upsertDispatchState(notification) {
 
  console.log(
  `Dispatch function called: ${notification.eventType} ${notification.bookingNumber}`
);
  
  const eventType = notification.eventType;

  if (
    eventType !== "ASSIGNED" &&
    eventType !== "DROPPED"
  ) {
    return;
  }

  const assignmentStatus =
    eventType === "ASSIGNED"
      ? "ASSIGNED"
      : "DROPPED";

  const jobRequestStatus =
    eventType === "ASSIGNED"
      ? "ACCEPTED"
      : "NOT_SENT";

  await pool.query(
    `
    INSERT INTO public.booking_dispatch_state (
      booking_number,
      assignment_status,
      current_cleaner,
      job_request_status,
      last_event_type,
      last_notification_text,
      last_assignment_change_at,
      octopus_booking_id,
      octopus_booking_url,
      updated_at
    )
    VALUES (
      $1,
      $2,
      $3,
      $4,
      $5,
      $6,
      NOW(),
      $7,
      $8,
      NOW()
    )
    ON CONFLICT (booking_number)
    DO UPDATE SET
      assignment_status = EXCLUDED.assignment_status,
      current_cleaner = EXCLUDED.current_cleaner,
      job_request_status = EXCLUDED.job_request_status,
      last_event_type = EXCLUDED.last_event_type,
      last_notification_text = EXCLUDED.last_notification_text,
      last_assignment_change_at = NOW(),
      octopus_booking_id = COALESCE(
        EXCLUDED.octopus_booking_id,
        public.booking_dispatch_state.octopus_booking_id
      ),
      octopus_booking_url = COALESCE(
        EXCLUDED.octopus_booking_url,
        public.booking_dispatch_state.octopus_booking_url
      ),
      updated_at = NOW();
    `,
    [
      notification.bookingNumber,
      assignmentStatus,
      notification.fieldworkerName || null,
      jobRequestStatus,
      eventType,
      notification.text || "",
      notification.octopusBookingId || null,
      notification.octopusBookingUrl || null
    ]
  );

  console.log(
    `Dispatch state updated: ${assignmentStatus} ${notification.bookingNumber}`
  );
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

if (result.rowCount === 0) {
  console.log(
    `Duplicate notification found: ${notification.eventType} ${notification.bookingNumber}`
  );

  try {
    await updateBookingTracking(notification);
  } catch (error) {
    console.error(
      `Failed backfilling tracker for ${notification.bookingNumber}:`,
      error
    );
  }

  try {
    await upsertDispatchState(notification);
  } catch (error) {
    console.error(
      `Failed backfilling dispatch state for ${notification.bookingNumber}:`,
      error
    );
  }

  return false;
}

  console.log(
    `Saved ${notification.eventType} event for ${notification.bookingNumber}.`
  );

  try {
    await updateBookingTracking(notification);
  } catch (error) {
    console.error(
      `Failed updating tracker for ${notification.bookingNumber}:`,
      error
    );
  }

  try {
    await sendToMake(notification);
  } catch (error) {
    console.error(
      `Failed sending ${notification.eventType} ${notification.bookingNumber} to Make:`,
      error
    );
  }

try {
  if (
    notification.eventType === "ASSIGNED" ||
    notification.eventType === "DROPPED"
  ) {
    await sendAssignmentToMake({
      bookingNumber: notification.bookingNumber,
      cleanerName: notification.fieldworkerName,
      assignmentAction: notification.eventType,
      notificationText: notification.text
    });
  }
} catch (error) {
  console.error(
    `Failed sending assignment event for ${notification.bookingNumber}:`,
    error
  );
}
  try {
  await upsertDispatchState(notification);
} catch (error) {
  console.error(
    `Failed updating dispatch state for ${notification.bookingNumber}:`,
    error
  );
}
  return true;
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

  const octopusBookingId = extractOctopusBookingId(href);
const octopusBookingUrl = buildOctopusBookingUrl(href);
console.log("Booking ID:", octopusBookingId);
console.log("Booking URL:", octopusBookingUrl);
const inserted = await saveNotification({
  bookingNumber,
  eventType: classifyNotification(text),
  fieldworkerName: extractWorkerName(text),
  octopusBookingId,
  octopusBookingUrl,
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
async function openJobRequestModal(page, bookingId) {
  const bookingUrl =
    `https://admin.octopuspro.com/booking/view/${bookingId}`;

  console.log(
    `DRY RUN: Opening Octopus booking ${bookingId}...`
  );

  await page.goto(bookingUrl, {
    waitUntil: "domcontentloaded",
    timeout: 60000
  });

  const availableFieldworkers = page.getByText(
    "Available Fieldworkers",
    { exact: true }
  );

  await availableFieldworkers.waitFor({
    state: "visible",
    timeout: 60000
  });

  await availableFieldworkers.scrollIntoViewIfNeeded();

  console.log(
    `DRY RUN: Waiting for Octopus to calculate fieldworkers for ${bookingId}...`
  );

  await page.waitForFunction(
    () => {
      const text =
        document.body?.innerText?.replace(/\s+/g, " ") || "";

      return (
        /\d+\s+of\s+\d+\s+available/i.test(text) ||
        /showing\s+\d+\s+of\s+\d+\s+matches/i.test(text)
      );
    },
    undefined,
    {
      timeout: 120000,
      polling: 1000
    }
  );

  console.log(
    `DRY RUN: Fieldworker calculation finished for ${bookingId}.`
  );

  const sendJobRequestButton = page.getByRole("button", {
    name: /send job request/i
  });

  await sendJobRequestButton.waitFor({
    state: "visible",
    timeout: 30000
  });

  await sendJobRequestButton.click({
    timeout: 30000
  });

  console.log(
    `DRY RUN: Clicked Send Job Request for ${bookingId}.`
  );

  const smsOption = page.getByText(
    "Also send as SMS",
    { exact: true }
  );

  await smsOption.waitFor({
    state: "visible",
    timeout: 60000
  });

 console.log(
  `LIVE TEST: Request window opened for ${bookingId}.`
);

console.log(
  `LIVE TEST: Clicking the final Send button for ${bookingId}...`
);

const sendClicked = await page.evaluate(() => {
  const buttons = Array.from(
    document.querySelectorAll("button")
  );

  const sendButton = buttons.find((button) => {
    const text = button.textContent?.trim();
    const styles = window.getComputedStyle(button);
    const rectangle = button.getBoundingClientRect();

    return (
      text === "Send" &&
      styles.display !== "none" &&
      styles.visibility !== "hidden" &&
      rectangle.width > 0 &&
      rectangle.height > 0
    );
  });

  if (!sendButton) {
    return false;
  }

  sendButton.click();
  return true;
});

if (!sendClicked) {
  throw new Error(
    `Final Send button was not found for ${bookingId}.`
  );
}

await smsOption.waitFor({
  state: "hidden",
  timeout: 60000
});

console.log(
  `LIVE TEST PASSED: Job request was sent for ${bookingId}.`
);
  await page.waitForTimeout(1000);

  await page.goto(NOTIFICATIONS_URL, {
    waitUntil: "domcontentloaded",
    timeout: 60000
  });
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


} catch (error) {
  console.error("Job request dry run failed:", error);

  await page.goto(NOTIFICATIONS_URL, {
    waitUntil: "domcontentloaded",
    timeout: 60000
  }).catch(() => {});
}

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
