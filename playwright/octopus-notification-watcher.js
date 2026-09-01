import { chromium } from "playwright";
import http from "http";
import twilio from "twilio";
import pg from "pg";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const { Pool } = pg;

const NOTIFICATIONS_URL =
  process.env.OCTOPUS_NOTIFICATIONS_URL;

const OCTOPUS_EMAIL =
  process.env.OCTOPUS_EMAIL;

const OCTOPUS_PASSWORD =
  process.env.OCTOPUS_PASSWORD;

const DATABASE_URL =
  process.env.DATABASE_URL;

const MAKE_WEBHOOK_URL =
  process.env.MAKE_WEBHOOK_URL;

const ASSIGNMENT_MAKE_WEBHOOK_URL =
  process.env.ASSIGNMENT_MAKE_WEBHOOK_URL;

const JOB_REQUEST_SENT_WEBHOOK_URL =
  process.env.JOB_REQUEST_SENT_WEBHOOK_URL;

const DISPATCH_ROUNDS = [
  { sendNumber: 1, radiusMiles: 30, timestampColumn: "job_request_30_sent_at" },
  { sendNumber: 2, radiusMiles: 45, timestampColumn: "job_request_45_sent_at" },
  { sendNumber: 3, radiusMiles: 60, timestampColumn: "job_request_60_sent_at" },
  { sendNumber: 4, radiusMiles: 75, timestampColumn: "job_request_75_sent_at" }
];

const DISPATCH_ROUND_DELAY_MINUTES = 15;

const MAX_JOB_REQUEST_RECIPIENTS = 100;

const ORGANIZATION_NAME =
  process.env.OCTOPUS_ORGANIZATION_NAME ||
  "SpeedyCleans";


if (!NOTIFICATIONS_URL) {
  throw new Error(
    "Missing OCTOPUS_NOTIFICATIONS_URL"
  );
}

if (!JOB_REQUEST_SENT_WEBHOOK_URL) {
  throw new Error(
    "Missing JOB_REQUEST_SENT_WEBHOOK_URL"
  );
}

if (!OCTOPUS_EMAIL) {
  throw new Error(
    "Missing OCTOPUS_EMAIL"
  );
}

if (!OCTOPUS_PASSWORD) {
  throw new Error(
    "Missing OCTOPUS_PASSWORD"
  );
}

if (!DATABASE_URL) {
  throw new Error(
    "Missing DATABASE_URL"
  );
}

if (!MAKE_WEBHOOK_URL) {
  throw new Error(
    "Missing MAKE_WEBHOOK_URL"
  );
}

if (!ASSIGNMENT_MAKE_WEBHOOK_URL) {
  throw new Error(
    "Missing ASSIGNMENT_MAKE_WEBHOOK_URL"
  );
}


const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});


function classifyNotification(text) {
  const value = text.toLowerCase();

  if (
    value.includes(
      "accepted appointment for booking"
    ) ||
    value.includes(
      "accepted booking request"
    ) ||
    value.includes(
      "has accepted booking request"
    )
  ) {
    return "ASSIGNED";
  }

  if (
    value.includes(
      "is no longer attending"
    )
  ) {
    return "NEEDS CLEANER";
  }

  if (
    value.includes(
      "on the way"
    )
  ) {
    return "ON_THE_WAY";
  }

  if (
    value.includes(
      "automatically checked in"
    )
  ) {
    return "ARRIVED";
  }

  if (
    value.includes(
      "has arrived"
    )
  ) {
    return "ARRIVED";
  }

  if (
    value.includes(
      "has started"
    )
  ) {
    return "STARTED";
  }

  if (
    value.includes(
      "has finished"
    )
  ) {
    return "FINISHED";
  }

  if (
    value.includes(
      "new photos added"
    )
  ) {
    return "PHOTOS_ADDED";
  }

  if (
    value.includes(
      "photos added"
    )
  ) {
    return "PHOTOS_ADDED";
  }

  if (
    value.includes(
      "wrote"
    )
  ) {
    return "DISCUSSION";
  }

  return "OTHER";
}


function extractBookingNumber(text) {
  const match =
    text.match(/BOK-\d+/i);

  return match
    ? match[0].toUpperCase()
    : null;
}


function extractOctopusBookingId(href) {
  if (!href) {
    return null;
  }

  const match =
    href.match(
      /\/booking\/view\/(\d+)/i
    );

  return match
    ? Number(match[1])
    : null;
}


function buildOctopusBookingUrl(href) {
  if (!href) {
    return null;
  }

  if (
    href.startsWith("http://") ||
    href.startsWith("https://")
  ) {
    return href;
  }

  return (
    `https://admin.octopuspro.com${href}`
  );
}


function extractWorkerName(text) {
  const match = text.match(
    /^(.*?)\s+(?:accepted appointment for booking|has accepted booking request|accepted booking request|is no longer attending|has finished|has started|has arrived|is on the way|has been automatically checked in)/i
  );

  return match
    ? match[1].trim()
    : null;
}


async function sendToMake(
  notification
) {
  let eventType =
    notification.eventType;

  if (
    eventType === "CHECKED_IN"
  ) {
    eventType = "ARRIVED";
  }

  const supportedStatuses = [
    "ASSIGNED",
    "ON_THE_WAY",
    "ARRIVED",
    "STARTED",
    "FINISHED"
  ];

  if (
    !supportedStatuses.includes(
      eventType
    )
  ) {
    console.log(
      `Skipping Make webhook for unsupported event: ${eventType}`
    );

    return;
  }


  const trackingResult =
    await pool.query(
      `
      SELECT tracking_token
      FROM public.booking_tracking
      WHERE booking_number = $1
      LIMIT 1;
      `,
      [
        notification.bookingNumber
      ]
    );


  const trackingToken =
    trackingResult.rows[0]
      ?.tracking_token || "";


  const trackingLink =
    trackingToken
      ? `https://track.speedycleans.com/track/${trackingToken}`
      : "";


  const payload = {
    event_type:
      eventType,

    booking_number:
      notification.bookingNumber,

    fieldworker_name:
      notification.fieldworkerName ||
      "",

    notification_text:
      notification.text || "",

    tracking_link:
      trackingLink,

    detected_at:
      new Date().toISOString()
  };


  const response =
    await fetch(
      MAKE_WEBHOOK_URL,
      {
        method: "POST",

        headers: {
          "Content-Type":
            "application/json"
        },

        body:
          JSON.stringify(payload)
      }
    );


  const responseText =
    await response.text();


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
  if (
    !bookingNumber ||
    !assignmentAction
  ) {
    return;
  }


  const payload = {
    detected_at:
      new Date().toISOString(),

    booking_number:
      bookingNumber,

    assignment_action:
      assignmentAction,

    notification_text:
      notificationText,

    cleaner_name:
      cleanerName
  };


  const response =
    await fetch(
      ASSIGNMENT_MAKE_WEBHOOK_URL,
      {
        method: "POST",

        headers: {
          "Content-Type":
            "application/json"
        },

        body:
          JSON.stringify(payload)
      }
    );


  const responseText =
    await response.text();


  if (!response.ok) {
    throw new Error(
      `Assignment webhook failed: ${response.status} ${responseText}`
    );
  }


  console.log(
    `Assignment webhook sent: ${assignmentAction} ${bookingNumber}`
  );
}


async function updateBookingTracking(
  notification
) {
  const eventType =
    notification.eventType;


  const supportedStatuses = [
    "ASSIGNED",
    "ON_THE_WAY",
    "ARRIVED",
    "STARTED",
    "FINISHED"
  ];


  const trackedStatus = supportedStatuses.includes(eventType)
    ? eventType
    : "DISCOVERED";


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

      CASE
        WHEN $3 = 'ON_THE_WAY'
        THEN NOW()
        ELSE NULL
      END,

      CASE
        WHEN $3 = 'ARRIVED'
        THEN NOW()
        ELSE NULL
      END,

      CASE
        WHEN $3 = 'STARTED'
        THEN NOW()
        ELSE NULL
      END,

      CASE
        WHEN $3 = 'FINISHED'
        THEN NOW()
        ELSE NULL
      END,

      NOW()
    )

    ON CONFLICT (booking_number)

    DO UPDATE SET

      status = CASE
        WHEN EXCLUDED.status = 'DISCOVERED'
        THEN public.booking_tracking.status
        ELSE EXCLUDED.status
      END,

      worker_name =
        COALESCE(
          EXCLUDED.worker_name,
          public.booking_tracking.worker_name
        ),

      octopus_booking_id =
        COALESCE(
          EXCLUDED.octopus_booking_id,
          public.booking_tracking.octopus_booking_id
        ),

      octopus_booking_url =
        COALESCE(
          EXCLUDED.octopus_booking_url,
          public.booking_tracking.octopus_booking_url
        ),

      on_the_way_at =
        CASE
          WHEN EXCLUDED.status =
            'ON_THE_WAY'
          THEN COALESCE(
            public.booking_tracking.on_the_way_at,
            NOW()
          )
          ELSE
            public.booking_tracking.on_the_way_at
        END,

      arrived_at =
        CASE
          WHEN EXCLUDED.status =
            'ARRIVED'
          THEN COALESCE(
            public.booking_tracking.arrived_at,
            NOW()
          )
          ELSE
            public.booking_tracking.arrived_at
        END,

      started_at =
        CASE
          WHEN EXCLUDED.status =
            'STARTED'
          THEN COALESCE(
            public.booking_tracking.started_at,
            NOW()
          )
          ELSE
            public.booking_tracking.started_at
        END,

      finished_at =
        CASE
          WHEN EXCLUDED.status =
            'FINISHED'
          THEN COALESCE(
            public.booking_tracking.finished_at,
            NOW()
          )
          ELSE
            public.booking_tracking.finished_at
        END,

      updated_at =
        NOW(),

      booking_details_synced_at =
        CASE
          WHEN public.booking_tracking.octopus_booking_url IS DISTINCT FROM EXCLUDED.octopus_booking_url
          THEN NULL
          ELSE public.booking_tracking.booking_details_synced_at
        END;
    `,
    [
      notification.bookingNumber,
      trackingToken,
      trackedStatus,
      notification.fieldworkerName,
      notification.octopusBookingId,
      notification.octopusBookingUrl
    ]
  );


  console.log(
    `Tracking updated: ${eventType} ${notification.bookingNumber}`
  );
}


async function writeThroughLisaCreatedBooking(body, result) {
  const bookingNumber = String(
    result?.bookingNumber || result?.booking_number || result?.bokNumber || ""
  ).trim().toUpperCase();

  const bookingId = Number(
    String(
      result?.bookingId || result?.booking_id || result?.octopusBookingId || result?.octopus_booking_id || ""
    ).replace(/\D/g, "")
  );

  if (!/^BOK-\d+$/.test(bookingNumber) || !Number.isInteger(bookingId) || bookingId < 1) {
    console.error("Lisa Postgres write-through skipped: missing verified booking number/id", {
      bookingNumber,
      bookingId: Number.isFinite(bookingId) ? bookingId : null
    });
    return false;
  }

  const phoneDigits = String(body.customerPhone || body.phone || "").replace(/\D/g, "");
  const normalizedPhone = phoneDigits.length >= 10 ? phoneDigits.slice(-10) : (phoneDigits || null);
  const requestedDate = String(body.requestedDate || "").trim();
  const requestedStartTime = String(body.requestedStartTime || "").trim();
  const bookingUrl = `https://admin.octopuspro.com/booking/view/${bookingId}`;

  let bookingDate = null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(requestedDate)) {
    const hhmm = /^([01]\d|2[0-3]):[0-5]\d$/.test(requestedStartTime)
      ? requestedStartTime
      : "09:00";
    // PostgreSQL interprets this explicitly in America/Detroit below.
    bookingDate = `${requestedDate} ${hhmm}:00`;
  }

  const trackingToken = `${bookingNumber}-lisa-create-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

  await pool.query(
    `
      INSERT INTO public.booking_tracking (
        booking_number,
        tracking_token,
        status,
        octopus_booking_id,
        octopus_booking_url,
        customer_phone_normalized,
        customer_phones_normalized,
        booking_date,
        booking_details_synced_at,
        octopus_updated_at,
        updated_at
      )
      VALUES (
        $1,
        $2,
        'DISCOVERED',
        $3,
        $4,
        $5,
        CASE WHEN $5::text IS NULL THEN NULL ELSE ARRAY[$5::text] END,
        CASE
          WHEN $6::text IS NULL THEN NULL
          ELSE ($6::timestamp AT TIME ZONE 'America/Detroit')
        END,
        NULL,
        NOW(),
        NOW()
      )
      ON CONFLICT (booking_number)
      DO UPDATE SET
        octopus_booking_id = COALESCE(EXCLUDED.octopus_booking_id, public.booking_tracking.octopus_booking_id),
        octopus_booking_url = COALESCE(EXCLUDED.octopus_booking_url, public.booking_tracking.octopus_booking_url),
        customer_phone_normalized = COALESCE(EXCLUDED.customer_phone_normalized, public.booking_tracking.customer_phone_normalized),
        customer_phones_normalized = COALESCE(EXCLUDED.customer_phones_normalized, public.booking_tracking.customer_phones_normalized),
        booking_date = COALESCE(EXCLUDED.booking_date, public.booking_tracking.booking_date),
        booking_details_synced_at = NULL,
        octopus_updated_at = NOW(),
        updated_at = NOW();
    `,
    [bookingNumber, trackingToken, bookingId, bookingUrl, normalizedPhone, bookingDate]
  );

  console.log(`LISA_POSTGRES_WRITE_THROUGH_OK ${bookingNumber} octopusId=${bookingId}`);
  return true;
}


async function upsertDispatchState(
  notification
) {
  console.log(
    `Dispatch function called: ${notification.eventType} ${notification.bookingNumber}`
  );


  const eventType =
    notification.eventType;


  if (
    eventType !== "ASSIGNED" &&
    eventType !== "NEEDS CLEANER"
  ) {
    return;
  }


  const assignmentStatus =
    eventType;


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

      assignment_status =
        EXCLUDED.assignment_status,

      current_cleaner =
        EXCLUDED.current_cleaner,

      job_request_status =
        EXCLUDED.job_request_status,

      last_event_type =
        EXCLUDED.last_event_type,

      last_notification_text =
        EXCLUDED.last_notification_text,

      last_assignment_change_at =
        NOW(),

      octopus_booking_id =
        COALESCE(
          EXCLUDED.octopus_booking_id,
          public.booking_dispatch_state.octopus_booking_id
        ),

      octopus_booking_url =
        COALESCE(
          EXCLUDED.octopus_booking_url,
          public.booking_dispatch_state.octopus_booking_url
        ),

      updated_at =
        NOW();
    `,
    [
      notification.bookingNumber,
      assignmentStatus,

      notification.fieldworkerName ||
        null,

      jobRequestStatus,
      eventType,
            notification.text ||
        "",

      notification.octopusBookingId ||
        null,

      notification.octopusBookingUrl ||
        null
    ]
  );


  console.log(
    `Dispatch state updated: ${assignmentStatus} ${notification.bookingNumber}`
  );
}


async function saveNotification(
  notification
) {
  const result =
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
      VALUES (
        $1,
        $2,
        $3,
        $4,
        $5,
        $6,
        $7,
        $8
      )

      ON CONFLICT (
        notification_key
      )
      DO NOTHING

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


  if (
    result.rowCount === 0
  ) {
    console.log(
      `Duplicate notification found: ${notification.eventType} ${notification.bookingNumber}`
    );


    try {
      await updateBookingTracking(
        notification
      );
    } catch (error) {
      console.error(
        `Failed backfilling tracker for ${notification.bookingNumber}:`,
        error
      );
    }


    return false;
  }


  console.log(
    `Saved ${notification.eventType} event for ${notification.bookingNumber}.`
  );


  try {
    await updateBookingTracking(
      notification
    );
  } catch (error) {
    console.error(
      `Failed updating tracker for ${notification.bookingNumber}:`,
      error
    );
  }


  try {
    await sendToMake(
      notification
    );
  } catch (error) {
    console.error(
      `Failed sending ${notification.eventType} ${notification.bookingNumber} to Make:`,
      error
    );
  }


  try {
    if (
      notification.eventType ===
        "ASSIGNED" ||
      notification.eventType ===
        "NEEDS CLEANER"
    ) {
      await sendAssignmentToMake({
        bookingNumber:
          notification.bookingNumber,

        cleanerName:
          notification.fieldworkerName,

        assignmentAction:
          notification.eventType,

        notificationText:
          notification.text
      });
    }
  } catch (error) {
    console.error(
      `Failed sending assignment event for ${notification.bookingNumber}:`,
      error
    );
  }


  try {
    await upsertDispatchState(
      notification
    );
  } catch (error) {
    console.error(
      `Failed updating dispatch state for ${notification.bookingNumber}:`,
      error
    );
  }


  return true;
}


async function selectOrganization(
  page
) {
  console.log(
    `Selecting OctopusPro organization: ${ORGANIZATION_NAME}...`
  );


  await page.waitForTimeout(
    3000
  );


  console.log(
    "Organization page text:",
    (
      await page
        .locator("body")
        .innerText()
    ).slice(
      0,
      1500
    )
  );


  const selects =
    page.locator("select");


  const selectCount =
    await selects.count();


  let organizationSelected =
    false;


  for (
    let index = 0;
    index < selectCount;
    index += 1
  ) {
    const select =
      selects.nth(index);


    const options =
      await select
        .locator("option")
        .allTextContents();


    console.log(
      `Select ${index + 1} options:`,
      options
    );


    const matchingOption =
      options.find(
        (option) =>
          option
            .toLowerCase()
            .includes(
              ORGANIZATION_NAME
                .toLowerCase()
            )
      );


    if (matchingOption) {
      await select.selectOption({
        label:
          matchingOption.trim()
      });


      console.log(
        `Selected option: ${matchingOption.trim()}`
      );


      organizationSelected =
        true;


      await page.waitForTimeout(
        1500
      );


      break;
    }
  }


  if (!organizationSelected) {
    const organizationText =
      page
        .getByText(
          ORGANIZATION_NAME,
          {
            exact: true
          }
        )
        .first();


    if (
      await organizationText
        .isVisible()
        .catch(() => false)
    ) {
      await organizationText.click();


      console.log(
        `Clicked organization text: ${ORGANIZATION_NAME}`
      );


      organizationSelected =
        true;


      await page.waitForTimeout(
        1500
      );
    }
  }


  if (!organizationSelected) {
    const organizationContainingText =
      page
        .getByText(
          ORGANIZATION_NAME,
          {
            exact: false
          }
        )
        .first();


    if (
      await organizationContainingText
        .isVisible()
        .catch(() => false)
    ) {
      await organizationContainingText.click();


      console.log(
        `Clicked organization containing text: ${ORGANIZATION_NAME}`
      );


      organizationSelected =
        true;


      await page.waitForTimeout(
        1500
      );
    }
  }


  if (!organizationSelected) {
    throw new Error(
      `Could not find the ${ORGANIZATION_NAME} organization option.`
    );
  }


  const fieldworkerChoice =
    page
      .getByText(
        "Fieldworker",
        {
          exact: false
        }
      )
      .first();


  if (
    await fieldworkerChoice
      .isVisible()
      .catch(() => false)
  ) {
    try {
      await fieldworkerChoice.click();


      console.log(
        "Selected Fieldworker role."
      );


      await page.waitForTimeout(
        1000
      );
    } catch {
      console.log(
        "Fieldworker role was visible but did not require a separate click."
      );
    }
  }


  const submitCandidates = [
    page
      .locator(
        'button[type="submit"]'
      )
      .first(),

    page
      .locator(
        'input[type="submit"]'
      )
      .first(),

    page
      .getByRole(
        "button",
        {
          name: /continue/i
        }
      )
      .first(),

    page
      .getByRole(
        "button",
        {
          name: /select/i
        }
      )
      .first(),

    page
      .getByRole(
        "button",
        {
          name: /login/i
        }
      )
      .first(),

    page
      .getByRole(
        "button",
        {
          name: /submit/i
        }
      )
      .first(),

    page
      .getByRole(
        "button",
        {
          name: /^go$/i
        }
      )
      .first(),

    page
      .getByRole(
        "button",
        {
          name: /^ok$/i
        }
      )
      .first()
  ];


  let submitted =
    false;


  for (
    const candidate
    of submitCandidates
  ) {
    if (
      await candidate
        .isVisible()
        .catch(() => false)
    ) {
      try {
        await candidate.click();


        submitted =
          true;


        console.log(
          "Submitted organization selection."
        );


        break;
      } catch {
        // Try next candidate.
      }
    }
  }


  if (!submitted) {
    console.log(
      "No visible organization submit button found. Pressing Enter."
    );


    await page.keyboard.press(
      "Enter"
    );
  }


  try {
    await page.waitForURL(
      (url) =>
        !url
          .toString()
          .toLowerCase()
          .includes(
            "/checkuserinmulticompanies"
          ),
      {
        timeout: 60000
      }
    );
  } catch {
    throw new Error(
      `Organization selection did not complete. Current URL: ${page.url()}`
    );
  }


  await page
    .waitForLoadState(
      "domcontentloaded"
    )
    .catch(() => {});


  await page.waitForTimeout(
    4000
  );


  console.log(
    "URL after organization selection:",
    page.url()
  );
}


async function loginToOctopus(
  page
) {
  console.log(
    "Logging into OctopusPro..."
  );


  await page.goto(
    "https://admin.octopuspro.com/login",
    {
      waitUntil:
        "domcontentloaded",

      timeout:
        60000
    }
  );


  const emailInput =
    page
      .locator(
        'input[type="email"], input[name="email"], input[name="username"], #email'
      )
      .first();


  const passwordInput =
    page
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


  await emailInput.fill(
    OCTOPUS_EMAIL
  );


  await passwordInput.fill(
    OCTOPUS_PASSWORD
  );


  const keepSignedIn =
    page
      .locator(
        'input[type="checkbox"][name*="remember"], input[type="checkbox"]'
      )
      .first();


  if (
    await keepSignedIn
      .isVisible()
      .catch(() => false)
  ) {
    if (
      !(
        await keepSignedIn
          .isChecked()
          .catch(() => false)
      )
    ) {
      await keepSignedIn
        .check()
        .catch(() => {});
    }
  }


  const submitButton =
    page
      .locator(
        'button[type="submit"], input[type="submit"]'
      )
      .first();


  await submitButton.waitFor({
    state: "visible",
    timeout: 30000
  });


  await submitButton.click();


  try {
    await page.waitForURL(
      (url) =>
        !url
          .toString()
          .toLowerCase()
          .includes(
            "/login"
          ),
      {
        timeout: 60000
      }
    );
  } catch {
    throw new Error(
      `OctopusPro login did not leave the login page. Current URL: ${page.url()}`
    );
  }


  await page
    .waitForLoadState(
      "domcontentloaded"
    )
    .catch(() => {});


  await page.waitForTimeout(
    3000
  );


  console.log(
    "URL after credentials:",
    page.url()
  );


  if (
    page
      .url()
      .toLowerCase()
      .includes(
        "/checkuserinmulticompanies"
      )
  ) {
    await selectOrganization(
      page
    );
  }


  const finalUrl =
    page
      .url()
      .toLowerCase();


  if (
    finalUrl.includes(
      "/login"
    ) ||
    finalUrl.includes(
      "logout=1"
    ) ||
    finalUrl.includes(
      "/checkuserinmulticompanies"
    )
  ) {
    throw new Error(
      `OctopusPro login did not complete. Current URL: ${page.url()}`
    );
  }


  console.log(
    "OctopusPro login successful."
  );
}


async function ensureLoggedIn(
  page
) {
  await page.goto(
    NOTIFICATIONS_URL,
    {
      waitUntil:
        "domcontentloaded",

      timeout:
        60000
    }
  );


  await page.waitForTimeout(
    3000
  );


  let currentUrl =
    page
      .url()
      .toLowerCase();


  if (
    currentUrl.includes(
      "/login"
    ) ||
    currentUrl.includes(
      "logout=1"
    )
  ) {
    await loginToOctopus(
      page
    );


    await page.goto(
      NOTIFICATIONS_URL,
      {
        waitUntil:
          "domcontentloaded",

        timeout:
          60000
      }
    );


    await page.waitForTimeout(
      5000
    );
  }


  currentUrl =
    page
      .url()
      .toLowerCase();


  if (
    currentUrl.includes(
      "/checkuserinmulticompanies"
    )
  ) {
    await selectOrganization(
      page
    );


    await page.goto(
      NOTIFICATIONS_URL,
      {
        waitUntil:
          "domcontentloaded",

        timeout:
          60000
      }
    );


    await page.waitForTimeout(
      5000
    );
  }


  currentUrl =
    page
      .url()
      .toLowerCase();


  if (
    currentUrl.includes(
      "/login"
    ) ||
    currentUrl.includes(
      "logout=1"
    ) ||
    currentUrl.includes(
      "/checkuserinmulticompanies"
    )
  ) {
    throw new Error(
      `Still logged out after login attempt. Current URL: ${page.url()}`
    );
  }
}



// ============================================================
// LISA / DISPATCH: OCTOPUS UNASSIGNED BOOKING DISCOVERY
// ============================================================

const UNASSIGNED_SWEEP_INTERVAL_MS =
  Number(process.env.UNASSIGNED_SWEEP_INTERVAL_MS || 300000);

const UNASSIGNED_SWEEP_LOOKAHEAD_DAYS =
  Number(process.env.UNASSIGNED_SWEEP_LOOKAHEAD_DAYS || 14);

const UNASSIGNED_SWEEP_BATCH_SIZE =
  Number(process.env.UNASSIGNED_SWEEP_BATCH_SIZE || 20);


function isUnassignedDispatchProfile(value) {
  const text = String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

  return (
    text.includes("unassigned fieldworker") ||
    text.includes("unassigned fieldworkers") ||
    text.includes("unassigned tasks manager")
  );
}


async function markBookingNeedsCleanerFromOctopus({
  bookingNumber,
  octopusBookingId,
  octopusBookingUrl,
  profileName
}) {
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
        'NEEDS CLEANER',
        $2,
        'NOT_SENT',
        'OCTOPUS_UNASSIGNED',
        $3,
        NOW(),
        $4,
        $5,
        NOW()
      )

      ON CONFLICT (booking_number)

      DO UPDATE SET
        assignment_status = 'NEEDS CLEANER',

        current_cleaner =
          EXCLUDED.current_cleaner,

        job_request_status =
          CASE
            WHEN public.booking_dispatch_state.assignment_status
              IS DISTINCT FROM 'NEEDS CLEANER'
            THEN 'NOT_SENT'
            ELSE public.booking_dispatch_state.job_request_status
          END,

        last_event_type =
          'OCTOPUS_UNASSIGNED',

        last_notification_text =
          EXCLUDED.last_notification_text,

        last_assignment_change_at =
          CASE
            WHEN public.booking_dispatch_state.assignment_status
              IS DISTINCT FROM 'NEEDS CLEANER'
              OR COALESCE(
                public.booking_dispatch_state.current_cleaner,
                ''
              ) IS DISTINCT FROM COALESCE(
                EXCLUDED.current_cleaner,
                ''
              )
            THEN NOW()
            ELSE public.booking_dispatch_state.last_assignment_change_at
          END,

        octopus_booking_id =
          COALESCE(
            EXCLUDED.octopus_booking_id,
            public.booking_dispatch_state.octopus_booking_id
          ),

        octopus_booking_url =
          COALESCE(
            EXCLUDED.octopus_booking_url,
            public.booking_dispatch_state.octopus_booking_url
          ),

        updated_at = NOW();
    `,
    [
      bookingNumber,
      profileName || "Unassigned Fieldworkers",
      `Verified on Octopus booking page as ${
        profileName || "Unassigned Fieldworkers"
      }`,
      octopusBookingId,
      octopusBookingUrl
    ]
  );

  console.log(
    `OCTOPUS UNASSIGNED -> NEEDS CLEANER: ${bookingNumber} | ${
      profileName || "Unassigned Fieldworkers"
    }`
  );
}


async function inspectBookingAssignment(
  page,
  bookingUrl
) {
  await page.goto(
    bookingUrl,
    {
      waitUntil: "domcontentloaded",
      timeout: 60000
    }
  );

  await page.waitForTimeout(2500);

  const currentUrl =
    page.url().toLowerCase();

  if (
    currentUrl.includes("/login") ||
    currentUrl.includes("logout=1") ||
    currentUrl.includes("/checkuserinmulticompanies")
  ) {
    return {
      isUnassigned: false,
      profileName: null,
      reason: "not_authenticated"
    };
  }

  const result = await page.evaluate(() => {
    const clean = (value) =>
      String(value || "")
        .replace(/\s+/g, " ")
        .trim();

    const candidates = [
      "Unassigned Fieldworkers",
      "Unassigned Fieldworker",
      "Unassigned Tasks Manager"
    ];

    const visible = (element) => {
      if (!(element instanceof HTMLElement)) {
        return false;
      }

      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);

      return (
        rect.width > 0 &&
        rect.height > 0 &&
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        Number(style.opacity || "1") !== 0
      );
    };

    const all = Array.from(
      document.querySelectorAll("body *")
    );

    for (const candidate of candidates) {
      const candidateLower = candidate.toLowerCase();

      for (const element of all) {
        if (!visible(element)) {
          continue;
        }

        const ownText = clean(
          element.innerText || element.textContent
        );

        if (
          !ownText ||
          ownText.length > 160 ||
          !ownText.toLowerCase().includes(candidateLower)
        ) {
          continue;
        }

        let context = ownText;
        let node = element.parentElement;
        let levels = 0;

        while (node && levels < 4) {
          const parentText = clean(
            node.innerText || node.textContent
          );

          if (
            parentText &&
            parentText.length <= 900
          ) {
            context += ` ${parentText}`;
          }

          node = node.parentElement;
          levels += 1;
        }

        if (
          /(fieldworker|assigned|assignment|team|technician|worker)/i.test(
            context
          )
        ) {
          return {
            profileName: candidate,
            evidence: context.slice(0, 900)
          };
        }
      }
    }

    return {
      profileName: null,
      evidence: ""
    };
  }).catch(() => ({
    profileName: null,
    evidence: ""
  }));

  return {
    isUnassigned:
      isUnassignedDispatchProfile(
        result.profileName
      ),

    profileName:
      result.profileName || null,

    reason:
      result.profileName
        ? "verified_unassigned_profile"
        : "not_unassigned",

    evidence:
      result.evidence || ""
  };
}


async function inspectBookingAssignmentInNewPage(
  page,
  bookingUrl
) {
  const inspectPage =
    await page.context().newPage();

  try {
    inspectPage.setDefaultTimeout(
      30000
    );

    inspectPage.setDefaultNavigationTimeout(
      60000
    );

    return await inspectBookingAssignment(
      inspectPage,
      bookingUrl
    );
  } finally {
    await inspectPage
      .close()
      .catch(() => {});
  }
}


async function getUpcomingBookingsForUnassignedSweep() {
  const result =
    await pool.query(
      `
        WITH candidates AS (
          SELECT
            j.booking_number::text AS booking_number,
            j.octopus_booking_id::bigint AS octopus_booking_id,
            j.scheduled_start AS booking_date
          FROM public.jobs j
          WHERE
            j.booking_number IS NOT NULL
            AND j.octopus_booking_id IS NOT NULL
            AND j.scheduled_start IS NOT NULL
            AND j.scheduled_start >= NOW() - INTERVAL '2 hours'
            AND j.scheduled_start < NOW() + ($1 * INTERVAL '1 day')

          UNION

          SELECT
            t.booking_number::text AS booking_number,
            t.octopus_booking_id::bigint AS octopus_booking_id,
            t.booking_date AS booking_date
          FROM public.booking_tracking t
          WHERE
            t.booking_number IS NOT NULL
            AND t.octopus_booking_id IS NOT NULL
            AND t.booking_date IS NOT NULL
            AND t.booking_date >= NOW() - INTERVAL '2 hours'
            AND t.booking_date < NOW() + ($1 * INTERVAL '1 day')
            AND UPPER(COALESCE(t.status, '')) NOT IN (
              'CANCELLED',
              'CANCELED',
              'DELETED',
              'FINISHED',
              'COMPLETED'
            )
        )

        SELECT DISTINCT ON (c.booking_number)
          c.booking_number,
          c.octopus_booking_id,
          c.booking_date,
          d.assignment_status,
          d.current_cleaner,
          d.updated_at AS dispatch_updated_at
        FROM candidates c
        LEFT JOIN public.booking_dispatch_state d
          ON d.booking_number = c.booking_number
        WHERE
          c.booking_number ~ '^BOK-[0-9]+$'
        ORDER BY
          c.booking_number,
          c.booking_date ASC;
      `,
      [UNASSIGNED_SWEEP_LOOKAHEAD_DAYS]
    );

  return result.rows;
}


let unassignedSweepCursor = 0;


async function sweepOctopusUnassignedBookings(
  page
) {
  const candidates =
    await getUpcomingBookingsForUnassignedSweep();

  if (!candidates.length) {
    console.log(
      "Unassigned sweep: no upcoming booking candidates found."
    );

    return;
  }

  const safeBatchSize =
    Math.max(
      1,
      Math.min(
        UNASSIGNED_SWEEP_BATCH_SIZE,
        candidates.length
      )
    );

  const batch = [];

  for (
    let offset = 0;
    offset < safeBatchSize;
    offset += 1
  ) {
    const index =
      (unassignedSweepCursor + offset) %
      candidates.length;

    batch.push(candidates[index]);
  }

  unassignedSweepCursor =
    (unassignedSweepCursor + safeBatchSize) %
    candidates.length;

  console.log(
    `Unassigned sweep: checking ${batch.length} of ${candidates.length} upcoming bookings. Cursor now ${unassignedSweepCursor}.`
  );

  let verifiedUnassigned = 0;

  for (const booking of batch) {
    const bookingNumber =
      String(booking.booking_number || "")
        .trim()
        .toUpperCase();

    const octopusBookingId =
      Number(booking.octopus_booking_id);

    if (
      !/^BOK-\d+$/.test(bookingNumber) ||
      !Number.isInteger(octopusBookingId) ||
      octopusBookingId <= 0
    ) {
      continue;
    }

    const bookingUrl =
      `https://admin.octopuspro.com/booking/view/${octopusBookingId}`;

    try {
      const assignmentCheck =
        await inspectBookingAssignment(
          page,
          bookingUrl
        );

      if (
        assignmentCheck.reason === "not_authenticated"
      ) {
        console.log(
          `Unassigned sweep lost Octopus login while checking ${bookingNumber}; restoring session.`
        );

        await ensureLoggedIn(page);
        continue;
      }

      if (
        !assignmentCheck.isUnassigned
      ) {
        console.log(
          `Unassigned sweep: ${bookingNumber} is not verified as unassigned.`
        );
        continue;
      }

      await markBookingNeedsCleanerFromOctopus({
        bookingNumber,
        octopusBookingId,
        octopusBookingUrl: bookingUrl,
        profileName:
          assignmentCheck.profileName
      });

      verifiedUnassigned += 1;

    } catch (error) {
      console.error(
        `Unassigned sweep failed for ${bookingNumber}:`,
        error
      );
    }
  }

  await page.goto(
    NOTIFICATIONS_URL,
    {
      waitUntil: "domcontentloaded",
      timeout: 60000
    }
  ).catch(() => {});

  console.log(
    `Unassigned sweep complete: ${verifiedUnassigned} verified unassigned booking(s) marked NEEDS CLEANER.`
  );
}

async function readNotifications(
  page
) {
  await ensureLoggedIn(
    page
  );


  console.log(
    "Current Octopus URL:",
    page.url()
  );


  console.log(
    "Page title:",
    await page.title()
  );


  const bodyText =
    await page
      .locator("body")
      .innerText();


  console.log(
    "Page text preview:",
    bodyText.slice(
      0,
      1000
    )
  );


  const links =
    page.locator(
      'a[href^="/booking/view/"], a[href*="/booking/view/"]'
    );


  try {
    await links
      .first()
      .waitFor({
        state: "visible",
        timeout: 20000
      });
  } catch {
    console.log(
      "No booking notification links were found."
    );

    return;
  }


  const count =
    await links.count();


  let newNotifications =
    0;


  for (
    let index = 0;
    index <
      Math.min(
        count,
        100
      );
    index += 1
  ) {
    const link =
      links.nth(index);


    const text =
      (
        await link.innerText()
      ).trim();


    const href =
      await link.getAttribute(
        "href"
      );


    if (
      !text ||
      !href
    ) {
      continue;
    }


    const bookingNumber =
      extractBookingNumber(
        text
      );


    if (!bookingNumber) {
      continue;
    }


    const octopusBookingId =
      extractOctopusBookingId(
        href
      );


    const octopusBookingUrl =
      buildOctopusBookingUrl(
        href
      );


    console.log(
      "Booking ID:",
      octopusBookingId
    );


    console.log(
      "Booking URL:",
      octopusBookingUrl
    );


    const inserted =
      await saveNotification({
        bookingNumber,

        eventType:
          classifyNotification(
            text
          ),

        fieldworkerName:
          extractWorkerName(
            text
          ),

        octopusBookingId,

        octopusBookingUrl,

        text,

        notificationKey:
          `${href}|${text}`
      });


    if (inserted) {
      newNotifications += 1;

      try {
        const assignmentCheck =
          await inspectBookingAssignmentInNewPage(
            page,
            octopusBookingUrl
          );

        if (assignmentCheck.isUnassigned) {
          await markBookingNeedsCleanerFromOctopus({
            bookingNumber,
            octopusBookingId,
            octopusBookingUrl,
            profileName:
              assignmentCheck.profileName
          });
        }
      } catch (assignmentError) {
        console.error(
          `Unassigned-profile check failed for ${bookingNumber}:`,
          assignmentError
        );
      }
    }
  }


  console.log(
    `Checked ${count} OctopusPro notification links. New events saved: ${newNotifications}.`
  );
}



async function diagnoseJobRequestUi(
  page,
  bookingId
) {
  console.log(
    `===== JOB REQUEST UI DIAGNOSTICS START ${bookingId} =====`
  );

  console.log(
    "Diagnostic page URL:",
    page.url()
  );

  await page.waitForTimeout(
    3000
  );


  try {
    const snapshot =
      await page.evaluate(
        () => {
          const isVisible =
            (element) => {
              if (
                !element ||
                !(element instanceof HTMLElement)
              ) {
                return false;
              }

              const rect =
                element.getBoundingClientRect();

              const style =
                window.getComputedStyle(
                  element
                );

              return (
                rect.width > 0 &&
                rect.height > 0 &&
                style.display !== "none" &&
                style.visibility !== "hidden" &&
                Number(style.opacity || "1") !== 0
              );
            };


          const cleanText =
            (value) =>
              String(value || "")
                .replace(/\s+/g, " ")
                .trim();


          const describe =
            (element) => ({
              tag:
                element.tagName
                  ?.toLowerCase() || "",

              id:
                element.id || "",

              className:
                typeof element.className ===
                  "string"
                  ? element.className
                  : "",

              role:
                element.getAttribute(
                  "role"
                ) || "",

              text:
                cleanText(
                  element.innerText ||
                  element.textContent
                ).slice(0, 500),

              outerHTML:
                element.outerHTML
                  ?.slice(0, 1800) || ""
            });


          const visibleButtons =
            Array.from(
              document.querySelectorAll(
                "button, a, [role='button'], input[type='button'], input[type='submit']"
              )
            )
              .filter(isVisible)
              .map(describe)
              .filter(
                (item) =>
                  item.text ||
                  /submit|button/i.test(
                    item.outerHTML
                  )
              )
              .slice(0, 120);


          const keywordRegex =
            /(send\s+job\s+request|load\s+more|showing\s+\d+|distance|fieldworker|matches|available\s+fieldworkers)/i;


          const keywordElements =
            Array.from(
              document.querySelectorAll(
                "body *"
              )
            )
              .filter(isVisible)
              .filter(
                (element) => {
                  const text =
                    cleanText(
                      element.innerText ||
                      element.textContent
                    );

                  return (
                    text &&
                    text.length <= 1200 &&
                    keywordRegex.test(text)
                  );
                }
              )
              .map(describe)
              .slice(0, 120);


          const overlayCandidates =
            Array.from(
              document.querySelectorAll(
                "body *"
              )
            )
              .filter(isVisible)
              .filter(
                (element) => {
                  const className =
                    typeof element.className ===
                      "string"
                      ? element.className
                      : "";

                  const role =
                    element.getAttribute(
                      "role"
                    ) || "";

                  const style =
                    window.getComputedStyle(
                      element
                    );

                  return (
                    /modal|dialog|popup|overlay|drawer|offcanvas|portal/i.test(
                      className
                    ) ||
                    /dialog/i.test(role) ||
                    style.position === "fixed"
                  );
                }
              )
              .map(describe)
              .slice(0, 80);


          const activeElement =
            document.activeElement
              ? describe(
                  document.activeElement
                )
              : null;


          const iframeInfo =
            Array.from(
              document.querySelectorAll(
                "iframe"
              )
            ).map(
              (frame) => ({
                src:
                  frame.getAttribute(
                    "src"
                  ) || "",

                name:
                  frame.getAttribute(
                    "name"
                  ) || "",

                id:
                  frame.id || "",

                className:
                  typeof frame.className ===
                    "string"
                    ? frame.className
                    : "",

                visible:
                  isVisible(frame)
              })
            );


          return {
            activeElement,
            visibleButtons,
            keywordElements,
            overlayCandidates,
            iframeInfo
          };
        }
      );


    console.log(
      "JOB REQUEST ACTIVE ELEMENT:",
      JSON.stringify(
        snapshot.activeElement
      )
    );


    console.log(
      "JOB REQUEST VISIBLE BUTTONS/LINKS:",
      JSON.stringify(
        snapshot.visibleButtons
      )
    );


    console.log(
      "JOB REQUEST KEYWORD ELEMENTS:",
      JSON.stringify(
        snapshot.keywordElements
      )
    );


    console.log(
      "JOB REQUEST MODAL/OVERLAY CANDIDATES:",
      JSON.stringify(
        snapshot.overlayCandidates
      )
    );


    console.log(
      "JOB REQUEST IFRAMES:",
      JSON.stringify(
        snapshot.iframeInfo
      )
    );
  } catch (error) {
    console.error(
      "Failed main-page job-request diagnostics:",
      error
    );
  }


  const frames =
    page.frames();


  console.log(
    `JOB REQUEST FRAME COUNT: ${frames.length}`
  );


  for (
    let index = 0;
    index < frames.length;
    index += 1
  ) {
    const frame =
      frames[index];

    try {
      const frameUrl =
        frame.url();

      const frameName =
        frame.name();

      const frameBodyText =
        await frame
          .locator("body")
          .innerText()
          .catch(() => "");

      const keywordLines =
        frameBodyText
          .split("\n")
          .map(
            (line) =>
              line
                .replace(/\s+/g, " ")
                .trim()
          )
          .filter(Boolean)
          .filter(
            (line) =>
              /(send\s+job\s+request|load\s+more|showing\s+\d+|distance|fieldworker|matches|available\s+fieldworkers)/i.test(
                line
              )
          )
          .slice(0, 80);

      const frameControls =
        await frame
          .locator(
            "button, a, [role='button'], input[type='button'], input[type='submit']"
          )
          .evaluateAll(
            (elements) =>
              elements
                .filter(
                  (element) => {
                    if (
                      !(element instanceof HTMLElement)
                    ) {
                      return false;
                    }

                    const rect =
                      element.getBoundingClientRect();

                    const style =
                      window.getComputedStyle(
                        element
                      );

                    return (
                      rect.width > 0 &&
                      rect.height > 0 &&
                      style.display !== "none" &&
                      style.visibility !== "hidden"
                    );
                  }
                )
                .map(
                  (element) => ({
                    tag:
                      element.tagName
                        .toLowerCase(),

                    text:
                      String(
                        element.innerText ||
                        element.textContent ||
                        element.getAttribute(
                          "value"
                        ) ||
                        ""
                      )
                        .replace(/\s+/g, " ")
                        .trim()
                        .slice(0, 300),

                    id:
                      element.id || "",

                    className:
                      typeof element.className ===
                        "string"
                        ? element.className
                        : "",

                    role:
                      element.getAttribute(
                        "role"
                      ) || ""
                  })
                )
                .slice(0, 100)
          )
          .catch(() => []);


      console.log(
        `JOB REQUEST FRAME ${index} NAME=${frameName || "(none)"} URL=${frameUrl}`
      );


      console.log(
        `JOB REQUEST FRAME ${index} KEYWORD LINES:`,
        JSON.stringify(
          keywordLines
        )
      );


      console.log(
        `JOB REQUEST FRAME ${index} VISIBLE CONTROLS:`,
        JSON.stringify(
          frameControls
        )
      );
    } catch (error) {
      console.error(
        `Failed diagnostics for frame ${index}:`,
        error
      );
    }
  }


  console.log(
    `===== JOB REQUEST UI DIAGNOSTICS END ${bookingId} =====`
  );
}


async function revealPopulatedJobRequestPopup(
  page,
  bookingId
) {
  const startedAt = Date.now();
  let lastLogAt = 0;

  while (Date.now() - startedAt < 90000) {
    const state = await page.evaluate(() => {
      const popup = document.querySelector("#JOB_REQUEST_POPUP");

      if (!popup) {
        return {
          exists: false,
          populated: false,
          hidden: true,
          textLength: 0,
          controlCount: 0,
          hasTable: false,
          rowCount: 0
        };
      }

      const content = popup.querySelector(".modal-content") || popup;
      const textLength = String(content.innerText || content.textContent || "")
        .replace(/\s+/g, " ")
        .trim()
        .length;

      const controlCount = content.querySelectorAll(
        "button, a, input, select, [role='button']"
      ).length;

      const table = content.querySelector(
        "#AvailableFieldworkersTable, .AvailableFieldworkersTable, table.table-bordered, table"
      );

      const rowCount = table
        ? table.querySelectorAll("tbody tr").length
        : 0;

      const style = window.getComputedStyle(popup);
      const rect = popup.getBoundingClientRect();
      const hidden =
        popup.classList.contains("custom-d-none") ||
        style.display === "none" ||
        style.visibility === "hidden" ||
        Number(style.opacity || "1") === 0 ||
        rect.width === 0 ||
        rect.height === 0;

      return {
        exists: true,
        populated: textLength > 0 || controlCount > 0 || Boolean(table),
        hidden,
        textLength,
        controlCount,
        hasTable: Boolean(table),
        rowCount
      };
    });

    if (state.exists && state.populated) {
      if (state.hidden) {
        console.log(
          `Octopus populated Send Job Request for ${bookingId} but left it hidden. Revealing the real popup.`
        );

        await page.evaluate(() => {
          const popup = document.querySelector("#JOB_REQUEST_POPUP");
          if (!(popup instanceof HTMLElement)) return;

          try {
            const jq = window.jQuery || window.$;
            if (jq && typeof jq === "function") {
              const wrapped = jq(popup);
              if (wrapped && typeof wrapped.modal === "function") {
                wrapped.modal("show");
              }
            }
          } catch {
            // Fall through to DOM visibility repair.
          }

          popup.classList.remove("custom-d-none");
          popup.classList.add("show");
          popup.style.setProperty("display", "block", "important");
          popup.style.setProperty("visibility", "visible", "important");
          popup.style.setProperty("opacity", "1", "important");
          popup.setAttribute("aria-hidden", "false");
          popup.setAttribute("aria-modal", "true");
          popup.setAttribute("role", popup.getAttribute("role") || "dialog");

          if (document.body) {
            document.body.classList.add("modal-open");
          }
        });

        await page.waitForTimeout(750);
      }

      const visible = await page
        .locator("#JOB_REQUEST_POPUP")
        .isVisible()
        .catch(() => false);

      console.log(
        `Real Send Job Request popup state for ${bookingId}: visible=${visible}, textLength=${state.textLength}, controls=${state.controlCount}, hasTable=${state.hasTable}, rows=${state.rowCount}.`
      );

      return {
        ...state,
        repaired: state.hidden,
        visible
      };
    }

    if (Date.now() - lastLogAt >= 5000) {
      lastLogAt = Date.now();
      console.log(
        `Waiting for Octopus to create/populate #JOB_REQUEST_POPUP for ${bookingId}: exists=${state.exists}, populated=${state.populated}, textLength=${state.textLength}, controls=${state.controlCount}, hasTable=${state.hasTable}, rows=${state.rowCount}.`
      );
    }

    await page.waitForTimeout(1000);
  }

  return {
    exists: false,
    populated: false,
    hidden: true,
    timedOut: true
  };
}


async function waitForJobRequestRecipientUi(page, jobRequestDialog, bookingId) {
  /*
   * IMPORTANT: recipient readiness is based on Octopus having populated the
   * real popup, not on Playwright visibility of a specific header. In
   * headless Chromium Octopus sometimes leaves Vue/Bootstrap descendants
   * hidden even though the popup data and controls are already present.
   */
  const startedAt = Date.now();
  let lastStateLogAt = 0;

  while (Date.now() - startedAt < 90000) {
    await revealPopulatedJobRequestPopup(page, bookingId);

    const state = await page.evaluate(() => {
      const popup = document.querySelector("#JOB_REQUEST_POPUP");
      if (!popup) {
        return {
          exists: false,
          textLength: 0,
          controlCount: 0,
          tableCount: 0,
          rowCount: 0,
          hasRecipientWords: false,
          hasFinalSend: false
        };
      }

      const content = popup.querySelector(".modal-content") || popup;
      const text = String(content.innerText || content.textContent || "")
        .replace(/\s+/g, " ")
        .trim();

      const tables = Array.from(
        content.querySelectorAll(
          "#AvailableFieldworkersTable, .AvailableFieldworkersTable, table.table-bordered, table"
        )
      );

      const rowCount = tables.reduce(
        (total, table) => total + table.querySelectorAll("tbody tr").length,
        0
      );

      const controls = Array.from(
        content.querySelectorAll("button, a, input, [role='button']")
      );

      const hasFinalSend = controls.some((element) => {
        const value = String(
          element.innerText ||
          element.textContent ||
          element.getAttribute("value") ||
          element.getAttribute("aria-label") ||
          ""
        )
          .replace(/\s+/g, " ")
          .trim();

        return /^send$/i.test(value);
      });

      return {
        exists: true,
        textLength: text.length,
        controlCount: controls.length,
        tableCount: tables.length,
        rowCount,
        hasRecipientWords: /(fieldworker|distance|matches|load more|send job request)/i.test(text),
        hasFinalSend
      };
    });

    const ready =
      state.exists &&
      (
        state.rowCount > 0 ||
        state.tableCount > 0 ||
        state.hasRecipientWords ||
        state.hasFinalSend ||
        state.controlCount >= 2
      );

    if (ready) {
      console.log(
        `Job Request recipient UI is ready for ${bookingId} after ${Date.now() - startedAt} ms: tables=${state.tableCount}, rows=${state.rowCount}, controls=${state.controlCount}, recipientWords=${state.hasRecipientWords}, finalSend=${state.hasFinalSend}.`
      );

      const popup = page.locator("#JOB_REQUEST_POPUP");
      return (await popup.count().catch(() => 0)) > 0
        ? popup
        : (jobRequestDialog || page.locator("body"));
    }

    if (Date.now() - lastStateLogAt >= 5000) {
      lastStateLogAt = Date.now();
      console.log(
        `Waiting for Octopus recipient UI for ${bookingId}: exists=${state.exists}, tables=${state.tableCount}, rows=${state.rowCount}, controls=${state.controlCount}, recipientWords=${state.hasRecipientWords}, finalSend=${state.hasFinalSend}.`
      );
    }

    await page.waitForTimeout(1000);
  }

  const snapshot = await page.evaluate(() => {
    const popup = document.querySelector("#JOB_REQUEST_POPUP");
    const content = popup?.querySelector(".modal-content") || popup;
    return {
      popupExists: Boolean(popup),
      popupClass: popup?.className || "",
      popupStyle: popup?.getAttribute("style") || "",
      modalContentLength: String(content?.innerText || content?.textContent || "").trim().length,
      modalHtmlPreview: content?.outerHTML?.slice(0, 6000) || ""
    };
  }).catch(() => ({}));

  console.log(
    `JOB REQUEST NOT READY SNAPSHOT ${bookingId}:`,
    JSON.stringify(snapshot)
  );

  throw new Error(
    `Octopus created the Send Job Request flow for ${bookingId}, but no usable recipient content was detected within 90 seconds.`
  );
}


async function getJobRequestContainer(
  page
) {
  /*
   * Return Octopus's real popup as soon as it exists and contains real
   * content/controls. Visibility is repaired by revealPopulatedJobRequestPopup.
   */
  const startedAt = Date.now();

  while (Date.now() - startedAt < 90000) {
    const popup = page.locator("#JOB_REQUEST_POPUP");
    const count = await popup.count().catch(() => 0);

    if (count > 0) {
      const state = await popup.evaluate((root) => {
        const content = root.querySelector(".modal-content") || root;
        const textLength = String(content.innerText || content.textContent || "")
          .replace(/\s+/g, " ")
          .trim()
          .length;

        const controlCount = content.querySelectorAll(
          "button, a, input, select, [role='button']"
        ).length;

        const hasTable = Boolean(
          content.querySelector(
            "#AvailableFieldworkersTable, .AvailableFieldworkersTable, table.table-bordered, table"
          )
        );

        return {
          textLength,
          controlCount,
          hasTable
        };
      }).catch(() => ({ textLength: 0, controlCount: 0, hasTable: false }));

      if (
        state.textLength > 0 ||
        state.controlCount > 0 ||
        state.hasTable
      ) {
        console.log(
          `Real Send Job Request popup found using #JOB_REQUEST_POPUP (textLength=${state.textLength}, controls=${state.controlCount}, hasTable=${state.hasTable}).`
        );

        return popup;
      }
    }

    await page.waitForTimeout(750);
  }

  const bodyText = await page
    .locator("body")
    .innerText()
    .catch(() => "");

  throw new Error(
    `Octopus did not create/populate #JOB_REQUEST_POPUP after the real click. Page tail: ${bodyText.slice(-1800)}`
  );
}

async function setJobRequestRadius(
  page,
  radiusMiles,
  jobRequestDialog
) {
  console.log(
    `Loading the closest ${MAX_JOB_REQUEST_RECIPIENTS} Octopus fieldworkers within ${radiusMiles} miles...`
  );

  const bookingMatch =
    page.url().match(
      /\/booking\/view\/(\d+)/
    );

  if (!bookingMatch) {
    throw new Error(
      `Could not determine Octopus booking ID from ${page.url()}.`
    );
  }

  const bookingId =
    bookingMatch[1];

  const perPage = 20;
  let pageNumber = 1;
  let loadedCount = 0;
  let totalCount = null;
  let farthestDistance = null;
  let targetReached = false;
  let pagesLoaded = 0;

  const eligibleById =
    new Map();

  while (
    pageNumber <= 100
  ) {
    const apiResult =
      await page.evaluate(
        async ({
          bookingId,
          pageNumber,
          perPage
        }) => {
          const response =
            await fetch(
              `/get-available-fieldworkers?item_type=booking&item_id=${encodeURIComponent(bookingId)}&page=${pageNumber}&per_page=${perPage}&include_extra_data=1`,
              {
                method: "GET",
                credentials: "include",
                headers: {
                  Accept:
                    "application/json, text/plain, */*"
                }
              }
            );

          const responseText =
            await response.text();

          let payload;

          try {
            payload =
              JSON.parse(
                responseText
              );
          } catch {
            throw new Error(
              `Octopus fieldworker page ${pageNumber} did not return JSON. HTTP ${response.status}. Preview: ${responseText.slice(0, 500)}`
            );
          }

          if (!response.ok) {
            throw new Error(
              `Octopus fieldworker page ${pageNumber} failed with HTTP ${response.status}: ${responseText.slice(0, 500)}`
            );
          }

          return payload;
        },
        {
          bookingId,
          pageNumber,
          perPage
        }
      );

    const contractors =
      Array.isArray(
        apiResult?.contractors
      )
        ? apiResult.contractors
        : [];

    if (
      totalCount === null
    ) {
      const possibleTotals = [
        apiResult?.total,
        apiResult?.total_count,
        apiResult?.count,
        apiResult?.pagination?.total,
        apiResult?.meta?.total,
        apiResult?.data?.total
      ];

      for (
        const value of possibleTotals
      ) {
        const parsed =
          Number(value);

        if (
          Number.isFinite(parsed) &&
          parsed >= 0
        ) {
          totalCount = parsed;
          break;
        }
      }
    }

    if (
      contractors.length === 0
    ) {
      console.log(
        `Octopus API returned no fieldworkers on page ${pageNumber}. Stopping pagination.`
      );

      break;
    }

    pagesLoaded += 1;
    loadedCount +=
      contractors.length;

    const sanePageDistances = [];
    let withinRadiusOnPage = 0;

    for (
      const contractor of contractors
    ) {
      const rawDistance =
        contractor?.distance_local ??
        contractor?.distance ??
        contractor?.distance_value;

      const distance =
        Number(rawDistance);

      if (
        !Number.isFinite(distance)
      ) {
        continue;
      }

      if (
        farthestDistance === null ||
        distance > farthestDistance
      ) {
        farthestDistance = distance;
      }

      if (
        distance >= 0 &&
        distance <= 500
      ) {
        sanePageDistances.push(
          distance
        );
      }

      if (
        distance < 0 ||
        distance > radiusMiles
      ) {
        continue;
      }

      withinRadiusOnPage += 1;

      const id =
        contractor?.user_id ??
        contractor?.id ??
        contractor?.contractor_id;

      if (
        id === undefined ||
        id === null
      ) {
        continue;
      }

      const key =
        String(id);

      const existing =
        eligibleById.get(key);

      if (
        !existing ||
        distance < existing.distance
      ) {
        eligibleById.set(
          key,
          {
            id: key,
            distance
          }
        );
      }
    }

    const pageMinDistance =
      sanePageDistances.length > 0
        ? Math.min(
            ...sanePageDistances
          )
        : null;

    const pageMaxDistance =
      sanePageDistances.length > 0
        ? Math.max(
            ...sanePageDistances
          )
        : null;

    console.log(
      `Octopus API page ${pageNumber}: loaded ${contractors.length}; cumulative ${loadedCount}${totalCount !== null ? ` of ${totalCount}` : ""}; sane distance range ${pageMinDistance ?? "unknown"}-${pageMaxDistance ?? "unknown"} miles; ${withinRadiusOnPage} within ${radiusMiles} miles; ${eligibleById.size} eligible collected.`
    );

    /*
     * Octopus returns this endpoint in nearest-first order on the booking page.
     * Once 100 eligible workers have been collected, stop immediately instead
     * of scanning hundreds of additional workers.
     */
    if (
      eligibleById.size >=
      MAX_JOB_REQUEST_RECIPIENTS
    ) {
      console.log(
        `Closest-${MAX_JOB_REQUEST_RECIPIENTS} cap reached after API page ${pageNumber}; stopping pagination early.`
      );

      break;
    }

    if (
      sanePageDistances.length > 0 &&
      withinRadiusOnPage === 0 &&
      pageMinDistance > radiusMiles
    ) {
      targetReached = true;

      console.log(
        `Reached the ${radiusMiles}-mile boundary after API page ${pageNumber}.`
      );

      break;
    }

    if (
      totalCount !== null &&
      loadedCount >= totalCount
    ) {
      console.log(
        `Reached the end of Octopus's ${totalCount} available fieldworkers.`
      );

      break;
    }

    if (
      contractors.length < perPage
    ) {
      console.log(
        `Octopus returned a short final page (${contractors.length}/${perPage}); stopping pagination.`
      );

      break;
    }

    pageNumber += 1;
  }

  if (
    pagesLoaded >= 100
  ) {
    throw new Error(
      `Stopped after 100 Octopus fieldworker API pages while trying to reach ${radiusMiles} miles.`
    );
  }

  const selectedFieldworkers =
    Array.from(
      eligibleById.values()
    )
      .sort(
        (a, b) =>
          a.distance - b.distance
      )
      .slice(
        0,
        MAX_JOB_REQUEST_RECIPIENTS
      );

  const fieldworkerIdsWithinRadius =
    selectedFieldworkers.map(
      (worker) =>
        worker.id
    );

  console.log(
    `Closest-${MAX_JOB_REQUEST_RECIPIENTS} selection ready for ${radiusMiles} miles: ${fieldworkerIdsWithinRadius.length} selected; ${loadedCount} API candidates inspected.`
  );

  if (
    fieldworkerIdsWithinRadius.length === 0
  ) {
    throw new Error(
      `No eligible fieldworkers were found within ${radiusMiles} miles for booking ${bookingId}.`
    );
  }

  /*
   * Octopus's recipient list is displayed in the same nearest-first ordering.
   * Load only enough 20-worker UI pages to expose the selected pool, capped at
   * 100 recipients. This is the part that prevents the old 442-worker crawl.
   */
  const recipientPagesNeeded =
    Math.max(
      1,
      Math.ceil(
        fieldworkerIdsWithinRadius.length /
        perPage
      )
    );

  const uiLoadMoreClicksNeeded =
    Math.max(
      0,
      recipientPagesNeeded - 1
    );

  console.log(
    `Synchronizing real Octopus job-request UI for ${fieldworkerIdsWithinRadius.length} recipients: ${uiLoadMoreClicksNeeded} Load More click(s).`
  );

  for (
    let clickNumber = 1;
    clickNumber <= uiLoadMoreClicksNeeded;
    clickNumber += 1
  ) {
    let loadMore =
      jobRequestDialog
        .getByText(
          /load more/i,
          { exact: false }
        )
        .first();

    if (
      !(
        await loadMore
          .isVisible()
          .catch(() => false)
      )
    ) {
      const globalCandidates =
        page.getByText(
          /load more/i,
          { exact: false }
        );

      const count =
        await globalCandidates
          .count()
          .catch(() => 0);

      for (
        let index = 0;
        index < count;
        index += 1
      ) {
        const candidate =
          globalCandidates.nth(index);

        if (
          await candidate
            .isVisible()
            .catch(() => false)
        ) {
          loadMore = candidate;
          break;
        }
      }
    }

    if (
      !(
        await loadMore
          .isVisible()
          .catch(() => false)
      )
    ) {
      console.log(
        `No visible Load More control after ${clickNumber - 1} click(s); Octopus may already have the recipient list loaded server-side.`
      );

      break;
    }

    console.log(
      `Clicking real popup Load More ${clickNumber}/${uiLoadMoreClicksNeeded}.`
    );

    await loadMore
      .scrollIntoViewIfNeeded()
      .catch(() => {});

    await loadMore.click({
      timeout: 30000
    });

    await page.waitForTimeout(
      1200
    );
  }

  return {
    availableFieldworkerCount:
      fieldworkerIdsWithinRadius.length,

    totalFieldworkerCount:
      totalCount ?? loadedCount,

    inspectedFieldworkerCount:
      loadedCount,

    farthestVisibleDistance:
      farthestDistance,

    targetRadiusReached:
      targetReached,

    fieldworkerIdsWithinRadius
  };
}


function attachJobRequestTracing(
  page,
  bookingId
) {
  if (
    typeof page.__jobRequestTraceDetach === "function"
  ) {
    try {
      page.__jobRequestTraceDetach();
    } catch {
      // Ignore stale trace cleanup errors.
    }
  }


  const startedAt =
    Date.now();


  const logIfRelevant =
    (
      prefix,
      payload
    ) => {
      const serialized =
        typeof payload === "string"
          ? payload
          : JSON.stringify(payload);


      if (
        /job[_\s-]*request|fieldworker|available|booking\/view|ajax|api|modal|popup/i.test(
          serialized
        )
      ) {
        console.log(
          `[JOB REQUEST TRACE ${bookingId}] ${prefix}`,
          serialized
        );
      }
    };


  const onConsole =
    (message) => {
      const type =
        message.type();

      if (
        type === "error" ||
        type === "warning"
      ) {
        console.log(
          `[JOB REQUEST TRACE ${bookingId}] BROWSER ${type.toUpperCase()}:`,
          message.text()
        );
      }
    };


  const onPageError =
    (error) => {
      console.log(
        `[JOB REQUEST TRACE ${bookingId}] PAGE ERROR:`,
        error?.stack ||
        error?.message ||
        String(error)
      );
    };


  const onRequest =
    (request) => {
      const resourceType =
        request.resourceType();

      const url =
        request.url();

      if (
        resourceType === "xhr" ||
        resourceType === "fetch"
      ) {
        logIfRelevant(
          `REQUEST ${request.method()} ${resourceType}`,
          {
            url,
            postData:
              request.postData()
          }
        );
      }
    };


  const onResponse =
    async (response) => {
      const request =
        response.request();

      const resourceType =
        request.resourceType();

      if (
        resourceType !== "xhr" &&
        resourceType !== "fetch"
      ) {
        return;
      }


      const url =
        response.url();

      if (
        !/job[_\s-]*request|fieldworker|available|booking|ajax|api|modal|popup/i.test(
          url
        )
      ) {
        return;
      }


      let bodyPreview =
        "";

      try {
        bodyPreview =
          (
            await response.text()
          ).slice(
            0,
            3000
          );
      } catch {
        bodyPreview =
          "";
      }


      console.log(
        `[JOB REQUEST TRACE ${bookingId}] RESPONSE ${response.status()} ${request.method()} ${resourceType}:`,
        JSON.stringify({
          url,
          bodyPreview
        })
      );
    };


  const onRequestFailed =
    (request) => {
      console.log(
        `[JOB REQUEST TRACE ${bookingId}] REQUEST FAILED ${request.method()} ${request.resourceType()}:`,
        JSON.stringify({
          url:
            request.url(),

          failure:
            request.failure()
        })
      );
    };


  page.on(
    "console",
    onConsole
  );

  page.on(
    "pageerror",
    onPageError
  );

  page.on(
    "request",
    onRequest
  );

  page.on(
    "response",
    onResponse
  );

  page.on(
    "requestfailed",
    onRequestFailed
  );


  console.log(
    `[JOB REQUEST TRACE ${bookingId}] tracing attached at ${new Date().toISOString()}`
  );


  let detached = false;

  const detach = () => {
    if (detached) {
      return;
    }

    detached = true;

    page.off(
      "console",
      onConsole
    );

    page.off(
      "pageerror",
      onPageError
    );

    page.off(
      "request",
      onRequest
    );

    page.off(
      "response",
      onResponse
    );

    page.off(
      "requestfailed",
      onRequestFailed
    );

    if (page.__jobRequestTraceDetach === detach) {
      page.__jobRequestTraceDetach = null;
    }

    console.log(
      `[JOB REQUEST TRACE ${bookingId}] tracing detached after ${Date.now() - startedAt} ms`
    );
  };


  page.__jobRequestTraceDetach = detach;


  return detach;
}


async function openJobRequestModal(
  page,
  bookingId,
  radiusMiles
) {
  const bookingUrl =
    `https://admin.octopuspro.com/booking/view/${bookingId}`;


  console.log(
    `Opening Octopus booking ${bookingId}...`
  );


  await page.goto(
    bookingUrl,
    {
      waitUntil:
        "domcontentloaded",

      timeout:
        60000
    }
  );


  const availableFieldworkers =
    page.getByText(
      "Available Fieldworkers",
      {
        exact: true
      }
    );


  await availableFieldworkers.waitFor({
    state: "visible",
    timeout: 60000
  });


  await availableFieldworkers
    .scrollIntoViewIfNeeded();


  console.log(
    `Available Fieldworkers section found for ${bookingId}. Waiting for Octopus to load the fieldworker list before opening Send Job Request...`
  );


  let initialMatchCount =
    0;


  const fieldworkerLoadStartedAt =
    Date.now();


  while (
    Date.now() -
      fieldworkerLoadStartedAt <
    120000
  ) {
    const bodyText =
      await page
        .locator("body")
        .innerText();

    const showingMatch =
      bodyText.match(
        /Showing\s+(\d+)\s+matches/i
      );

    if (
      showingMatch &&
      Number(showingMatch[1]) > 0
    ) {
      initialMatchCount =
        Number(showingMatch[1]);

      break;
    }

    const sendButtonVisible =
      await page
        .getByRole(
          "button",
          {
            name:
              /send job request/i
          }
        )
        .first()
        .isVisible()
        .catch(() => false);

    const zeroMatchesVisible =
      /Showing\s+0\s+matches/i.test(
        bodyText
      );

    if (
      sendButtonVisible &&
      !zeroMatchesVisible
    ) {
      break;
    }

    await page.waitForTimeout(
      3000
    );
  }


  console.log(
    initialMatchCount > 0
      ? `Octopus loaded ${initialMatchCount} fieldworker matches for ${bookingId}.`
      : `Fieldworker loading wait completed for ${bookingId}. Opening Send Job Request.`
  );


  const sendJobRequestButton =
    page
      .getByRole(
        "button",
        {
          name:
            /send job request/i
        }
      )
      .first();


  await sendJobRequestButton.waitFor({
    state: "visible",
    timeout: 120000
  });


  await sendJobRequestButton
    .scrollIntoViewIfNeeded();


  console.log(
    `Send Job Request button is ready for ${bookingId}.`
  );


  const detachJobRequestTracing =
    attachJobRequestTracing(
      page,
      bookingId
    );


  /*
   * IMPORTANT: do not create #JOB_REQUEST_POPUP ourselves. The old workaround
   * produced an empty Bootstrap shell and prevented us from finding Octopus's
   * real recipient controls. Click the real button and let Octopus render its
   * own Vue/Bootstrap/portal UI.
   */
  await sendJobRequestButton.click({
    timeout: 30000
  });

  await page.waitForTimeout(
    1500
  );

  const clickedJobRequest =
    true;


  if (!clickedJobRequest) {
    throw new Error(
      `Could not click Send Job Request for ${bookingId}.`
    );
  }


  console.log(
    `Clicked Send Job Request for ${bookingId}.`
  );


  await diagnoseJobRequestUi(
    page,
    bookingId
  );


  await page.waitForTimeout(
    5000
  );


  const targetSnapshot =
    await page.evaluate(
      () => {
        const target =
          document.querySelector(
            "#JOB_REQUEST_POPUP"
          );

        const button =
          Array.from(
            document.querySelectorAll(
              "button[data-target='#JOB_REQUEST_POPUP']"
            )
          ).find(
            (element) => {
              const rect =
                element.getBoundingClientRect();

              const style =
                window.getComputedStyle(
                  element
                );

              return (
                rect.width > 0 &&
                rect.height > 0 &&
                style.display !== "none" &&
                style.visibility !== "hidden"
              );
            }
          );


        return {
          targetExists:
            Boolean(target),

          targetClass:
            target?.className || "",

          targetStyle:
            target?.getAttribute(
              "style"
            ) || "",

          targetHtmlPreview:
            target?.outerHTML
              ?.slice(
                0,
                3000
              ) || "",

          buttonOuterHtml:
            button?.outerHTML
              ?.slice(
                0,
                2000
              ) || ""
        };
      }
    );


  console.log(
    `[JOB REQUEST TRACE ${bookingId}] TARGET SNAPSHOT:`,
    JSON.stringify(
      targetSnapshot
    )
  );


  await revealPopulatedJobRequestPopup(
    page,
    bookingId
  );


  let jobRequestDialog =
    await getJobRequestContainer(
      page
    );


  // The Bootstrap shell can be visible before Octopus/Vue has rendered
  // the actual recipient table. Wait for the real recipient UI before
  // changing radius or paging cleaners.
  jobRequestDialog =
    await waitForJobRequestRecipientUi(
      page,
      jobRequestDialog,
      bookingId
    );


  console.log(
    `Send Job Request modal and recipient UI are ready for ${bookingId}.`
  );


  detachJobRequestTracing();


  const radiusResult =
    await setJobRequestRadius(
      page,
      radiusMiles,
      jobRequestDialog
    );


  // Octopus renders the final Send control at the bottom-right of the
  // Send Job Request dialog. Depending on the Octopus build it may be a
  // <button>, <a>, [role="button"], or submit input. Scroll the real dialog
  // to the bottom first, then search both inside the dialog and globally.
  await jobRequestDialog
    .evaluate((root) => {
      const nodes = [root, ...root.querySelectorAll("*")];

      for (const node of nodes) {
        if (!(node instanceof HTMLElement)) {
          continue;
        }

        if (node.scrollHeight > node.clientHeight) {
          node.scrollTop = node.scrollHeight;
        }
      }
    })
    .catch(() => {});

  await page.waitForTimeout(750);

  let finalSendButton = null;
  const finalSendWaitStartedAt = Date.now();
  let finalSendAttempt = 0;

  while (Date.now() - finalSendWaitStartedAt < 60000) {
    finalSendAttempt += 1;
    const attempt = finalSendAttempt;
    const candidateSets = [
      jobRequestDialog
        .locator("button, a, [role='button']")
        .filter({
          hasText: /^\s*Send\s*$/i
        }),

      page
        .locator("button, a, [role='button']")
        .filter({
          hasText: /^\s*Send\s*$/i
        }),

      jobRequestDialog
        .locator("input[type='submit'], input[type='button']")
        .filter({
          has: page.locator("xpath=.")
        }),

      page.locator(
        "input[type='submit'][value='Send'], input[type='button'][value='Send']"
      )
    ];

    for (const candidateSet of candidateSets) {
      const candidateCount =
        await candidateSet
          .count()
          .catch(() => 0);

      for (
        let index = candidateCount - 1;
        index >= 0;
        index -= 1
      ) {
        const candidate =
          candidateSet.nth(index);

        const text =
          await candidate
            .evaluate((element) =>
              String(
                element.innerText ||
                element.textContent ||
                element.getAttribute("value") ||
                element.getAttribute("aria-label") ||
                ""
              )
                .replace(/\s+/g, " ")
                .trim()
            )
            .catch(() => "");

        if (!/^Send$/i.test(text)) {
          continue;
        }

        const visible =
          await candidate
            .isVisible()
            .catch(() => false);

        const enabled =
          await candidate
            .isEnabled()
            .catch(() => false);

        if (visible && enabled) {
          finalSendButton = candidate;
          break;
        }
      }

      if (finalSendButton) {
        break;
      }
    }

    // Last-resort: find exact visible "Send" text and climb to its clickable ancestor.
    if (!finalSendButton) {
      const sendTexts =
        page.getByText(
          /^\s*Send\s*$/i,
          { exact: true }
        );

      const textCount =
        await sendTexts
          .count()
          .catch(() => 0);

      for (
        let index = textCount - 1;
        index >= 0;
        index -= 1
      ) {
        const textNode = sendTexts.nth(index);

        if (
          !(await textNode
            .isVisible()
            .catch(() => false))
        ) {
          continue;
        }

        const clickable =
          textNode.locator(
            "xpath=ancestor-or-self::*[self::button or self::a or @role='button'][1]"
          );

        if (
          (await clickable.count().catch(() => 0)) > 0 &&
          await clickable.isVisible().catch(() => false) &&
          await clickable.isEnabled().catch(() => false)
        ) {
          finalSendButton = clickable;
          break;
        }
      }
    }

    if (finalSendButton) {
      console.log(
        `Visible and enabled final Send control found for ${bookingId} after ${Date.now() - finalSendWaitStartedAt} ms (attempt ${attempt}).`
      );
      break;
    }

    console.log(
      `Still waiting for final Send control to become visible and enabled — ${Math.round((Date.now() - finalSendWaitStartedAt) / 1000)}s elapsed for ${bookingId}.`
    );

    // Octopus can rerender the popup after Load More. Re-scroll every attempt.
    await jobRequestDialog
      .evaluate((root) => {
        const nodes = [root, ...root.querySelectorAll("*")];

        for (const node of nodes) {
          if (
            node instanceof HTMLElement &&
            node.scrollHeight > node.clientHeight
          ) {
            node.scrollTop = node.scrollHeight;
          }
        }
      })
      .catch(() => {});

    await page.waitForTimeout(2500);
  }


  if (!finalSendButton) {
    const visibleClickableTexts =
      await page
        .locator(
          "button, a, [role='button'], input[type='button'], input[type='submit']"
        )
        .evaluateAll(
          (elements) =>
            elements
              .filter((element) => {
                if (!(element instanceof HTMLElement)) {
                  return false;
                }

                const rect =
                  element.getBoundingClientRect();

                const style =
                  window.getComputedStyle(element);

                return (
                  rect.width > 0 &&
                  rect.height > 0 &&
                  style.display !== "none" &&
                  style.visibility !== "hidden"
                );
              })
              .map((element) => ({
                tag: element.tagName.toLowerCase(),
                text: String(
                  element.innerText ||
                  element.textContent ||
                  element.getAttribute("value") ||
                  element.getAttribute("aria-label") ||
                  ""
                )
                  .replace(/\s+/g, " ")
                  .trim(),
                id: element.id || "",
                className:
                  typeof element.className === "string"
                    ? element.className
                    : ""
              }))
              .filter((item) => item.text)
        )
        .catch(() => []);

    console.log(
      "VISIBLE CLICKABLES WHEN FINAL SEND FAILED:",
      JSON.stringify(
        visibleClickableTexts
      )
    );

    throw new Error(
      `Final Send control did not become visible and enabled within 60 seconds for ${bookingId}.`
    );
  }


  await finalSendButton
    .scrollIntoViewIfNeeded()
    .catch(() => {});


  await finalSendButton.click({
    timeout: 30000
  });


  console.log(
    `Clicked FINAL Send control for ${bookingId} after loading through the ${radiusMiles}-mile marker.`
  );

  console.log(
    `Waiting for Octopus send-success confirmation for ${bookingId}...`
  );


  const successToast =
    page.getByText(
      /Notification sent successfully/i,
      { exact: false }
    ).first();


  // Octopus sometimes renders the success toast in the DOM without making it
  // Playwright-visible in headless Chromium. A successful send also closes or
  // hides the real #JOB_REQUEST_POPUP. Accept either signal, but do NOT mark a
  // send successful if the popup remains open and no confirmation exists.
  let sendConfirmationReason = null;
  const confirmationDeadline = Date.now() + 45000;

  while (Date.now() < confirmationDeadline) {
    const confirmationState = await page.evaluate(() => {
      const popup = document.querySelector('#JOB_REQUEST_POPUP');

      const toastText = Array.from(
        document.querySelectorAll('body *')
      )
        .map((el) => (el.innerText || el.textContent || '').trim())
        .find((text) => /Notification sent successfully/i.test(text));

      if (!popup) {
        return {
          toastPresent: Boolean(toastText),
          popupExists: false,
          popupVisible: false,
          popupClass: '',
          popupStyle: ''
        };
      }

      const style = window.getComputedStyle(popup);
      const rect = popup.getBoundingClientRect();
      const popupVisible = Boolean(
        rect.width > 0 &&
        rect.height > 0 &&
        style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        Number(style.opacity || '1') !== 0 &&
        !popup.classList.contains('custom-d-none')
      );

      return {
        toastPresent: Boolean(toastText),
        popupExists: true,
        popupVisible,
        popupClass: popup.className || '',
        popupStyle: popup.getAttribute('style') || ''
      };
    });

    if (confirmationState.toastPresent) {
      sendConfirmationReason = 'success text present in DOM';
      break;
    }

    if (!confirmationState.popupExists) {
      sendConfirmationReason = 'job request popup removed after final Send';
      break;
    }

    if (!confirmationState.popupVisible) {
      sendConfirmationReason = 'job request popup closed/hidden after final Send';
      break;
    }

    await page.waitForTimeout(500);
  }


  if (!sendConfirmationReason) {
    throw new Error(
      `Final Send was clicked for ${bookingId}, but Octopus showed neither a success confirmation nor a closed job-request popup within 45 seconds.`
    );
  }


  console.log(
    `Job request send confirmed for ${bookingId}: ${sendConfirmationReason}.`
  );


  await page.waitForTimeout(
    1500
  );


  await page.goto(
    NOTIFICATIONS_URL,
    {
      waitUntil:
        "domcontentloaded",

      timeout:
        60000
    }
  );


  await page.waitForTimeout(
    2000
  );


  return {
    availableFieldworkerCount:
      radiusResult.availableFieldworkerCount,

    totalFieldworkerCount:
      radiusResult.totalFieldworkerCount
  };
}

async function getNextDispatchBooking() {
  const result =
    await pool.query(
      `
      SELECT
        dispatch.booking_number,
        dispatch.octopus_booking_id,
        dispatch.assignment_status,
        dispatch.job_request_status,
        tracking.booking_date,
        tracking.arrival_window,

        CASE
          WHEN dispatch.job_request_30_sent_at IS NULL THEN 1
          WHEN dispatch.job_request_45_sent_at IS NULL THEN 2
          WHEN dispatch.job_request_60_sent_at IS NULL THEN 3
          WHEN dispatch.job_request_75_sent_at IS NULL THEN 4
          ELSE NULL
        END AS send_number,

        CASE
          WHEN dispatch.job_request_30_sent_at IS NULL THEN 30
          WHEN dispatch.job_request_45_sent_at IS NULL THEN 45
          WHEN dispatch.job_request_60_sent_at IS NULL THEN 60
          WHEN dispatch.job_request_75_sent_at IS NULL THEN 75
          ELSE NULL
        END AS radius_miles

      FROM public.booking_dispatch_state AS dispatch

      /*
       * booking_dispatch_state is the authoritative dispatch state.
       * Keep booking_tracking joined for date/window metadata, but do not
       * require a tracking row to exist because Sheet/Make can explicitly
       * reset a booking to NEEDS CLEANER before tracking is refreshed.
       */
      LEFT JOIN public.booking_tracking AS tracking
        ON tracking.booking_number = dispatch.booking_number

      WHERE
        dispatch.assignment_status = 'NEEDS CLEANER'
        AND dispatch.octopus_booking_id IS NOT NULL

        /*
         * Never dispatch bookings that tracking explicitly says were
         * cancelled/deleted. Operational tracking states can be stale after
         * a manual NEEDS CLEANER reset, so a freshly updated dispatch row is
         * allowed to override ASSIGNED/ON_THE_WAY/ARRIVED/STARTED/FINISHED.
         * A real new ASSIGNED event still stops dispatch because it updates
         * dispatch.assignment_status away from NEEDS CLEANER.
         */
        AND UPPER(COALESCE(tracking.status, '')) NOT IN (
          'CANCELLED',
          'CANCELED',
          'DELETED'
        )

        AND (
          UPPER(COALESCE(tracking.status, '')) NOT IN (
            'ASSIGNED',
            'ON_THE_WAY',
            'ARRIVED',
            'STARTED',
            'FINISHED'
          )
          OR dispatch.updated_at >= NOW() - INTERVAL '1 day'
        )

        /*
         * Preserve the existing future/today arrival-window protection.
         * Also allow a freshly reset dispatch row through when booking_tracking
         * still contains an old booking date/window (the exact failure seen
         * with re-used/rescheduled booking numbers such as BOK-26701).
         */
        AND (
          dispatch.updated_at >= NOW() - INTERVAL '1 day'

          OR tracking.booking_date IS NULL

          OR (tracking.booking_date AT TIME ZONE 'America/Detroit')::date
            > (NOW() AT TIME ZONE 'America/Detroit')::date

          OR (
            (tracking.booking_date AT TIME ZONE 'America/Detroit')::date
              = (NOW() AT TIME ZONE 'America/Detroit')::date

            AND tracking.arrival_window IS NOT NULL

            AND split_part(tracking.arrival_window, ' - ', 1)
              ~* '^\\d{1,2}:\\d{2}\\s*(am|pm)$'

            AND (
              (
                (tracking.booking_date AT TIME ZONE 'America/Detroit')::date::text
                || ' '
                || split_part(tracking.arrival_window, ' - ', 1)
              )::timestamp
              > (NOW() AT TIME ZONE 'America/Detroit')
            )
          )
        )

        AND (
          dispatch.job_request_30_sent_at IS NULL

          OR (
            dispatch.job_request_45_sent_at IS NULL
            AND dispatch.job_request_30_sent_at
              <= NOW() - ($1 * INTERVAL '1 minute')
          )

          OR (
            dispatch.job_request_60_sent_at IS NULL
            AND dispatch.job_request_45_sent_at
              <= NOW() - ($1 * INTERVAL '1 minute')
          )

          OR (
            dispatch.job_request_75_sent_at IS NULL
            AND dispatch.job_request_60_sent_at
              <= NOW() - ($1 * INTERVAL '1 minute')
          )
        )

        AND (
          dispatch.last_dispatch_attempt_at IS NULL
          OR dispatch.last_dispatch_attempt_at
            <= NOW() - INTERVAL '5 minutes'
        )

      ORDER BY dispatch.updated_at ASC
      LIMIT 1;
      `,
      [DISPATCH_ROUND_DELAY_MINUTES]
    );

  return result.rows[0] || null;
}


async function markDispatchSent(
  bookingNumber,
  sendNumber
) {
  const dispatchRound =
    DISPATCH_ROUNDS.find(
      (round) =>
        round.sendNumber === sendNumber
    );

  if (!dispatchRound) {
    throw new Error(
      `Unsupported dispatch send number: ${sendNumber}`
    );
  }

  const timestampColumn =
    dispatchRound.timestampColumn;

  await pool.query(
    `
    UPDATE public.booking_dispatch_state
    SET
      job_request_status = $2,
      ${timestampColumn} = NOW(),
      dispatch_attempts =
        COALESCE(dispatch_attempts, 0) + 1,
      last_dispatch_attempt_at = NOW(),
      updated_at = NOW()
    WHERE booking_number = $1;
    `,
    [
      bookingNumber,
      sendNumber === 4
        ? "ALL_ROUNDS_SENT"
        : `SEND_${sendNumber}_SENT`
    ]
  );
}


async function markDispatchFailed(
  bookingNumber,
  error
) {
  await pool.query(
    `
    UPDATE public.booking_dispatch_state
    SET
      job_request_status = 'FAILED',
      last_dispatch_attempt_at = NOW(),
      last_notification_text = $2,
      updated_at = NOW()
    WHERE booking_number = $1;
    `,
    [
      bookingNumber,
      String(
        error?.message || error
      ).slice(0, 1000)
    ]
  );
}


async function sendJobRequestSentToMake({
  bookingNumber,
  octopusBookingId,
  bookingDate,
  radiusMiles,
  sendNumber,
  availableFieldworkerCount,
  totalFieldworkerCount
}) {
  const sentAt =
    new Date().toISOString();

  const response =
    await fetch(
      JOB_REQUEST_SENT_WEBHOOK_URL,
      {
        method: "POST",

        headers: {
          "Content-Type":
            "application/json"
        },

        body: JSON.stringify({
          booking_number:
            bookingNumber,

          octopus_booking_id:
            octopusBookingId,

          job_request_status:
            "SENT",

          booking_date:
            bookingDate,

          radius_miles:
            radiusMiles,

          send_number:
            sendNumber,

          available_fieldworker_count:
            availableFieldworkerCount,

          total_fieldworker_count:
            totalFieldworkerCount,

          sent_at:
            sentAt
        })
      }
    );

  const responseText =
    await response.text();

  if (!response.ok) {
    throw new Error(
      `Job request sent webhook failed: ${response.status} ${responseText}`
    );
  }

  console.log(
    `Job request Send ${sendNumber} (${radiusMiles} miles) webhook delivered for ${bookingNumber} at ${sentAt}.`
  );
}


async function dispatchNextBooking(
  page
) {
  const booking =
    await getNextDispatchBooking();

  if (!booking) {
    console.log(
      "No bookings are waiting for dispatch."
    );

    return;
  }

  console.log(
    `Dispatching Send ${booking.send_number} for ${booking.booking_number} at ${booking.radius_miles} miles using Octopus ID ${booking.octopus_booking_id}...`
  );

  try {
    const sendResult =
      await openJobRequestModal(
      page,
      booking.octopus_booking_id,
      Number(booking.radius_miles)
      );

    await markDispatchSent(
      booking.booking_number,
      Number(booking.send_number)
    );

    await sendJobRequestSentToMake({
      bookingNumber:
        booking.booking_number,

      octopusBookingId:
        booking.octopus_booking_id,

      bookingDate:
        booking.booking_date,

      radiusMiles:
        Number(booking.radius_miles),

      sendNumber:
        Number(booking.send_number),

      availableFieldworkerCount:
        sendResult.availableFieldworkerCount,

      totalFieldworkerCount:
        sendResult.totalFieldworkerCount
    });

    console.log(
      `Dispatch Send ${booking.send_number} completed and recorded for ${booking.booking_number} at ${booking.radius_miles} miles.`
    );
  } catch (error) {
    if (
      typeof page.__jobRequestTraceDetach === "function"
    ) {
      try {
        page.__jobRequestTraceDetach();
      } catch {
        // Do not mask the real dispatch failure.
      }
    }

    await markDispatchFailed(
      booking.booking_number,
      error
    );

    throw error;
  }
}


async function upsertNeedsCleanerFromHttp({
  bookingNumber,
  octopusBookingId,
  octopusBookingUrl
}) {
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
        job_request_30_sent_at,
        job_request_45_sent_at,
        job_request_60_sent_at,
        job_request_75_sent_at,
        last_dispatch_attempt_at,
        updated_at
      )
      VALUES (
        $1,
        'NEEDS CLEANER',
        NULL,
        'NOT_SENT',
        'NEEDS CLEANER',
        'Triggered from Confirmations Column P',
        NOW(),
        $2,
        $3,
        NULL,
        NULL,
        NULL,
        NULL,
        NULL,
        NOW()
      )
      ON CONFLICT (booking_number)
      DO UPDATE SET
        assignment_status = 'NEEDS CLEANER',
        current_cleaner = NULL,
        job_request_status = 'NOT_SENT',
        last_event_type = 'NEEDS CLEANER',
        last_notification_text = 'Triggered from Confirmations Column P',
        last_assignment_change_at = NOW(),
        octopus_booking_id = EXCLUDED.octopus_booking_id,
        octopus_booking_url = EXCLUDED.octopus_booking_url,
        job_request_30_sent_at = NULL,
        job_request_45_sent_at = NULL,
        job_request_60_sent_at = NULL,
        job_request_75_sent_at = NULL,
        last_dispatch_attempt_at = NULL,
        updated_at = NOW();
    `,
    [
      bookingNumber,
      octopusBookingId,
      octopusBookingUrl
    ]
  );
}


// ============================================================
// LISA ASYNC BOOKING JOB STORE
// ============================================================

const lisaBookingJobs = new Map();

function createLisaBookingRequestId() {
  return `lisa-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function cleanupLisaBookingJobs() {
  const cutoff = Date.now() - 60 * 60 * 1000;

  for (const [requestId, job] of lisaBookingJobs.entries()) {
    if ((job.updatedAt || job.createdAt || 0) < cutoff) {
      lisaBookingJobs.delete(requestId);
    }
  }
}

setInterval(cleanupLisaBookingJobs, 10 * 60 * 1000).unref();

async function runLisaBookingInBackground(requestId, body) {
  const existing = lisaBookingJobs.get(requestId);
  if (!existing) return;

  lisaBookingJobs.set(requestId, {
    ...existing,
    status: "processing",
    updatedAt: Date.now()
  });

  console.log("Lisa async booking background job started:", requestId);

  let stdout = "";
  let stderr = "";

  try {
    const childResult = await execFileAsync(
      process.execPath,
      ["playwright/octopus-create-booking.js"],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          LISA_BOOKING_PAYLOAD: JSON.stringify({
            ...body,
            source: "LISA_VOICE"
          })
        },
        timeout: 300000,
        maxBuffer: 10 * 1024 * 1024
      }
    );

    stdout = String(childResult.stdout || "");
    stderr = String(childResult.stderr || "");
  } catch (error) {
    stdout = String(error?.stdout || "");
    stderr = String(error?.stderr || "");

    console.error(
      "Lisa async booking Playwright process failed:",
      requestId,
      error?.message || error
    );

    if (stdout) console.log("Lisa async booking stdout before failure:", stdout.slice(-12000));
    if (stderr) console.error("Lisa async booking stderr before failure:", stderr.slice(-12000));

    lisaBookingJobs.set(requestId, {
      requestId,
      status: "failed",
      success: false,
      verified_created_in_octopus: false,
      outcome: "playwright_booking_failed",
      error: error?.killed
        ? "Octopus booking timed out."
        : (error?.message || "Octopus booking failed."),
      createdAt: existing.createdAt,
      updatedAt: Date.now()
    });
    return;
  }

  if (stderr.trim()) {
    console.log("Lisa async booking stderr:", stderr.slice(-12000));
  }

  console.log("Lisa async booking stdout:", stdout.slice(-16000));

  const resultLine = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .reverse()
    .find((line) => line.startsWith("LISA_BOOKING_RESULT="));

  if (!resultLine) {
    lisaBookingJobs.set(requestId, {
      requestId,
      status: "failed",
      success: false,
      verified_created_in_octopus: false,
      outcome: "playwright_booking_failed",
      error: "Octopus booking automation finished without returning a verified BOK.",
      createdAt: existing.createdAt,
      updatedAt: Date.now()
    });
    return;
  }

  let result;
  try {
    result = JSON.parse(resultLine.slice("LISA_BOOKING_RESULT=".length));
  } catch {
    lisaBookingJobs.set(requestId, {
      requestId,
      status: "failed",
      success: false,
      verified_created_in_octopus: false,
      outcome: "invalid_booking_result",
      error: "Octopus booking returned an unreadable result.",
      createdAt: existing.createdAt,
      updatedAt: Date.now()
    });
    return;
  }

  const bookingNumber = String(
    result.bookingNumber || result.booking_number || ""
  ).trim();

  const bookingId =
    result.bookingId ||
    result.booking_id ||
    result.octopusBookingId ||
    result.octopus_booking_id ||
    null;

  const verified =
    result.success === true &&
    Boolean(bookingNumber) &&
    bookingNumber.toUpperCase().startsWith("BOK-");

  if (!verified) {
    lisaBookingJobs.set(requestId, {
      requestId,
      status: "failed",
      success: false,
      verified_created_in_octopus: false,
      outcome: result.outcome || "verification_failed",
      error: result.error || "Octopus did not return a verified booking number.",
      rawResult: result,
      createdAt: existing.createdAt,
      updatedAt: Date.now()
    });
    return;
  }

  lisaBookingJobs.set(requestId, {
    ...result,
    requestId,
    status: "created",
    success: true,
    verified_created_in_octopus: true,
    bookingNumber,
    bookingId,
    outcome: "created",
    createdAt: existing.createdAt,
    updatedAt: Date.now()
  });

  console.log("Lisa async booking completed:", requestId, bookingNumber);
}

function startHttpServer() {
  const port = Number(process.env.PORT || 3000);

  const server = http.createServer(async (req, res) => {
    const sendJson = (statusCode, payload) => {
      res.writeHead(statusCode, {
        "Content-Type": "application/json"
      });
      res.end(JSON.stringify(payload));
    };

    if (req.method === "GET" && (req.url === "/" || req.url === "/health")) {
      sendJson(200, {
        status: "ok",
        service: "octopus-watcher"
      });
      return;
    }

    // LISA ASYNC BOOKING STATUS
    if (req.method === "GET" && req.url.startsWith("/lisa/booking-status/")) {
      const configuredSecret = String(
        process.env.LISA_ACTION_SECRET || ""
      ).trim();

      const suppliedSecret = String(
        req.headers["x-lisa-secret"] || ""
      ).trim();

      if (!configuredSecret || suppliedSecret !== configuredSecret) {
        sendJson(401, {
          success: false,
          status: "unauthorized",
          outcome: "unauthorized",
          error: "Unauthorized."
        });
        return;
      }

      const requestId = decodeURIComponent(
        req.url.substring("/lisa/booking-status/".length)
      ).trim();

      const job = lisaBookingJobs.get(requestId);

      if (!job) {
        sendJson(404, {
          success: false,
          status: "unknown",
          outcome: "request_not_found",
          requestId
        });
        return;
      }

      sendJson(200, { ...job, requestId });
      return;
    }

    if (
  req.method !== "POST" ||
  (
    req.url !== "/needs-cleaner" &&
    req.url !== "/lisa/booking-action" &&
    req.url !== "/outbound-call"
  )
) {
  sendJson(404, {
    status: "error",
    message: "Not found"
  });
  return;
}

    try {
      let rawBody = "";

      for await (const chunk of req) {
        rawBody += chunk;

        if (rawBody.length > 1024 * 1024) {
          throw new Error("Request body too large");
        }
      }

      const body = rawBody
        ? JSON.parse(rawBody)
        : {};

      // ============================================================
      // OUTBOUND CONFIRMATION CALL LAUNCHER
      // Make.com POSTs here. This process creates the real Twilio call,
      // then hands the answered call to the existing Emma/Lisa realtime
      // outbound-answer route that already preserves the sheet row and
      // confirmation instructions.
      // ============================================================
      if (req.url === "/outbound-call") {
        const phone = String(
          body.phone || body.customer_phone || ""
        ).trim();

        const customerName = String(
          body.customer_name || body.customerName || body.name || ""
        ).trim();

        const instructions = String(
          body.instructions || body.customInstructions || ""
        ).trim();

        const sheetRowNumber = String(
          body.sheet_row_number || body.sheetRowNumber || ""
        ).trim();

        let callPurpose = String(
          body.call_purpose || body.callPurpose || ""
        ).trim().toUpperCase();

        // Backward-compatible inference so the existing Make scenarios do not
        // need another field just to distinguish same-day vs next-day calls.
        if (!callPurpose) {
          const instructionUpper = instructions.toUpperCase();
          if (instructionUpper.includes("SAME-DAY APPOINTMENT CONFIRMATION")) {
            callPurpose = "SAME_DAY_CONFIRMATION";
          } else if (
            instructionUpper.includes("NEXT-DAY APPOINTMENT CONFIRMATION") ||
            instructionUpper.includes("NEXT DAY APPOINTMENT CONFIRMATION")
          ) {
            callPurpose = "NEXT_DAY_CONFIRMATION";
          }
        }

        if (!phone) {
          sendJson(400, {
            success: false,
            error: "Phone number is required."
          });
          return;
        }

        if (!instructions) {
          sendJson(400, {
            success: false,
            error: "Instructions are required."
          });
          return;
        }

        const accountSid = String(
          process.env.TWILIO_ACCT_SID || process.env.TWILIO_ACCOUNT_SID || ""
        ).trim();
        const authToken = String(
          process.env.TWILIO_AUTH_TOKEN || ""
        ).trim();
        const fromNumber = String(
          process.env.TWILIO_PHONE_NUMBER || ""
        ).trim();

        if (!accountSid || !authToken || !fromNumber) {
          sendJson(500, {
            success: false,
            error: "Twilio credentials or TWILIO_PHONE_NUMBER are missing on octopus-watcher."
          });
          return;
        }

        try {
          const answerBase = String(
            process.env.OUTBOUND_ANSWER_URL ||
            "https://emma-development-production.up.railway.app/outbound-custom-answer"
          ).trim();

          const answerUrl = new URL(answerBase);
          answerUrl.searchParams.set("phone", phone);
          answerUrl.searchParams.set("customer_name", customerName);
          answerUrl.searchParams.set("instructions", instructions);
          answerUrl.searchParams.set("sheet_row_number", sheetRowNumber);
          answerUrl.searchParams.set("call_purpose", callPurpose);

          const client = twilio(accountSid, authToken);
          const call = await client.calls.create({
            to: phone,
            from: fromNumber,
            url: answerUrl.toString(),
            method: "POST",
            record: true,
            recordingChannels: "dual",
            machineDetection: "DetectMessageEnd",
            machineDetectionTimeout: 30,
            machineDetectionSpeechThreshold: 2400,
            machineDetectionSpeechEndThreshold: 1200,
            machineDetectionSilenceTimeout: 5000
          });

          console.log("Outbound confirmation call started:", {
            callSid: call.sid,
            phone,
            customerName,
            sheetRowNumber,
            callPurpose,
            answerHost: answerUrl.host
          });

          sendJson(200, {
            success: true,
            call_sid: call.sid,
            status: call.status,
            phone,
            customer_name: customerName,
            sheet_row_number: sheetRowNumber,
            call_purpose: callPurpose
          });
          return;
        } catch (error) {
          console.error("POST /outbound-call failed:", error);
          sendJson(500, {
            success: false,
            error: String(error?.message || error)
          });
          return;
        }
      }
if (req.url === "/lisa/booking-action") {
  const configuredSecret = String(
    process.env.LISA_ACTION_SECRET || ""
  ).trim();

  const suppliedSecret = String(
    req.headers["x-lisa-secret"] || ""
  ).trim();

  if (
    !configuredSecret ||
    suppliedSecret !== configuredSecret
  ) {
    sendJson(401, {
      success: false,
      outcome: "unauthorized",
      error: "Unauthorized."
    });
    return;
  }

  const action = String(
    body.action || ""
  ).trim().toLowerCase();

  console.log("Lisa booking action request:", {
    action,
    bookingNumber: body.bookingNumber || body.booking_number || null,
    phone: body.phone || body.customerPhone || null,
    customerName: body.customerName || null,
    email: body.email || body.customerEmail || null,
    customerId: body.customerId || null,
    requestedDate: body.requestedDate || body.date || null,
    requestedStartTime: body.requestedStartTime || null,
    scope: body.scope || null,
    limit: body.limit || null
  });

  if (action === "lookup") {
    let stdout = "";
    let stderr = "";
    const lookupBody = { ...body };

    // Exact BOK lookups should be fast and deterministic. If Postgres already knows
    // the numeric Octopus ID, pass it to the live reader so it can open the booking
    // page directly instead of crawling/searching Octopus.
    const exactBok = String(body.bookingNumber || body.booking_number || "").trim().toUpperCase();
    if (/^BOK-\d+$/.test(exactBok) && !lookupBody.bookingId && !lookupBody.octopusBookingId) {
      try {
        const cached = await pool.query(
          `SELECT booking_number, octopus_booking_id, octopus_booking_url
             FROM public.booking_tracking
            WHERE booking_number = $1
            LIMIT 1`,
          [exactBok]
        );
        if (cached.rows?.[0]?.octopus_booking_id) {
          lookupBody.bookingId = cached.rows[0].octopus_booking_id;
          lookupBody.octopusBookingId = cached.rows[0].octopus_booking_id;
          console.log(`Lisa exact BOK pre-resolved from Postgres: ${exactBok} -> ${cached.rows[0].octopus_booking_id}`);
        }
      } catch (error) {
        console.error("Lisa exact BOK Postgres pre-resolution failed:", error?.message || error);
      }
    }

    try {
      const childResult = await execFileAsync(
        process.execPath,
        ["playwright/octopus-live-lookup.js"],
        {
          cwd: process.cwd(),
          env: {
            ...process.env,
            LISA_LOOKUP_PAYLOAD: JSON.stringify(lookupBody)
          },
          timeout: 45000,
          maxBuffer: 10 * 1024 * 1024
        }
      );

      stdout = String(childResult.stdout || "");
      stderr = String(childResult.stderr || "");
    } catch (error) {
      stdout = String(error?.stdout || "");
      stderr = String(error?.stderr || "");

      console.error(
        "Lisa live Octopus lookup process failed:",
        error?.message || error
      );

      sendJson(200, {
        success: false,
        found: false,
        source: "octopus_live",
        outcome: error?.killed ? "lookup_timeout" : "lookup_process_failed",
        error: error?.killed
          ? "Live Octopus lookup timed out. Lisa should continue the call and may retry on demand."
          : "Live Octopus lookup failed temporarily."
      });
      return;
    }

    if (stderr.trim()) {
      console.log(
        "Lisa live Octopus lookup stderr:",
        stderr.slice(-4000)
      );
    }

    const marker = stdout
      .split(/\r?\n/)
      .find((line) => line.startsWith("LISA_LOOKUP_RESULT="));

    if (!marker) {
      console.error(
        "Lisa live Octopus lookup returned no result marker. stdout tail:",
        stdout.slice(-4000)
      );
      sendJson(200, {
        success: false,
        found: false,
        source: "octopus_live",
        outcome: "lookup_no_result",
        error: "Live Octopus lookup did not return a result."
      });
      return;
    }

    let lookupResult;
    try {
      lookupResult = JSON.parse(
        marker.substring("LISA_LOOKUP_RESULT=".length)
      );
    } catch (error) {
      console.error("Lisa lookup result JSON parse failed:", error?.message || error);
      sendJson(200, {
        success: false,
        found: false,
        source: "octopus_live",
        outcome: "lookup_invalid_result",
        error: "Live Octopus lookup returned an invalid result."
      });
      return;
    }

    console.log("Lisa live Octopus lookup result:", {
      success: lookupResult.success,
      found: lookupResult.found,
      source: lookupResult.source,
      bookingNumber:
        lookupResult.booking?.bookingNumber ||
        lookupResult.bookings?.[0]?.bookingNumber ||
        null,
      count: lookupResult.count || lookupResult.bookings?.length || 0,
      reason: lookupResult.reason || null,
      error: lookupResult.error || null
    });

    sendJson(200, lookupResult);
    return;
  }

  if (action === "cancel" || action === "reschedule") {
    if (body.customerConfirmed !== true) {
      sendJson(200, {
        success: false,
        outcome: "confirmation_required",
        error: action === "cancel"
          ? "The customer must explicitly confirm cancellation before Octopus is changed."
          : "The customer must explicitly confirm the new date and time before Octopus is changed."
      });
      return;
    }

    const scope = String(
      body.cancellationScope || body.rescheduleScope || body.scope || "single_visit"
    ).trim().toLowerCase();

    if (scope !== "single_visit") {
      sendJson(200, {
        success: false,
        outcome: "staff_review_required",
        error: "Only one specific visit can be changed automatically. Recurring-series changes require staff review."
      });
      return;
    }

    if (action === "reschedule") {
      const requestedDate = String(body.requestedDate || body.date || "").trim();
      const requestedStartTime = String(body.requestedStartTime || body.time || "").trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(requestedDate)) {
        sendJson(200, {
          success: false,
          outcome: "invalid_requested_date",
          error: "A verified new date in YYYY-MM-DD format is required."
        });
        return;
      }
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(requestedStartTime)) {
        sendJson(200, {
          success: false,
          outcome: "invalid_requested_time",
          error: "A verified new start time in 24-hour HH:MM format is required."
        });
        return;
      }
    }

    let internalBookingId = Number(
      String(body.bookingId || body.octopusBookingId || body.octopus_booking_id || "")
        .replace(/\D/g, "")
    );

    const suppliedBookingNumber = String(
      body.bookingNumber || body.booking_number || ""
    ).trim().toUpperCase();

    // If Lisa supplied a visible BOK rather than the numeric Octopus ID, resolve it
    // live from Octopus first. This works for bookings created seconds ago and does
    // not depend on Postgres sync being caught up.
    if (!Number.isInteger(internalBookingId) || internalBookingId < 100000) {
      if (!/^BOK-\d+$/i.test(suppliedBookingNumber)) {
        sendJson(200, {
          success: false,
          outcome: "invalid_booking_id",
          error: "A valid BOK number or Octopus booking ID is required."
        });
        return;
      }

      try {
        const lookupPayload = {
          action: "lookup",
          bookingNumber: suppliedBookingNumber,
          scope: "all",
          limit: 1
        };
        const lookupRun = await execFileAsync(
          process.execPath,
          ["playwright/octopus-live-lookup.js"],
          {
            cwd: process.cwd(),
            env: {
              ...process.env,
              LISA_LOOKUP_PAYLOAD: JSON.stringify(lookupPayload)
            },
            timeout: 25000,
            maxBuffer: 10 * 1024 * 1024
          }
        );

        const lookupMarker = String(lookupRun.stdout || "")
          .split(/\r?\n/)
          .find(line => line.startsWith("LISA_LOOKUP_RESULT="));

        if (lookupMarker) {
          const lookupResult = JSON.parse(
            lookupMarker.substring("LISA_LOOKUP_RESULT=".length)
          );
          const liveBooking = lookupResult.booking || (lookupResult.bookings || [])[0] || {};
          internalBookingId = Number(
            String(liveBooking.bookingId || liveBooking.booking_id || "")
              .replace(/\D/g, "")
          );
        }
      } catch (error) {
        console.error("Lisa change-action live BOK resolution failed:", error?.message || error);
      }
    }

    if (!Number.isInteger(internalBookingId) || internalBookingId < 100000) {
      sendJson(200, {
        success: false,
        outcome: "booking_not_found",
        error: "The booking could not be verified live in Octopus, so no change was made."
      });
      return;
    }

    const commandArgs = action === "cancel"
      ? [
          "playwright/octopus-booking-actions.js",
          "cancel",
          String(internalBookingId),
          String(body.cancellationReason || "Customer requested cancellation")
        ]
      : [
          "playwright/octopus-booking-actions.js",
          "reschedule",
          String(internalBookingId),
          String(body.requestedDate),
          String(body.requestedStartTime)
        ];

    let stdout = "";
    let stderr = "";
    try {
      const childResult = await execFileAsync(
        process.execPath,
        commandArgs,
        {
          cwd: process.cwd(),
          env: process.env,
          timeout: action === "cancel" ? 165000 : 195000,
          maxBuffer: 10 * 1024 * 1024
        }
      );
      stdout = String(childResult.stdout || "");
      stderr = String(childResult.stderr || "");
    } catch (error) {
      stdout = String(error?.stdout || "");
      stderr = String(error?.stderr || "");
      console.error(`Lisa ${action} action failed:`, error?.message || error);
    }

    if (stderr.trim()) {
      console.log(`Lisa ${action} stderr:`, stderr.slice(-8000));
    }

    const resultMatch = stdout.match(
      /===== BOOKING ACTION RESULT =====\s*([\s\S]*?)\s*===== END BOOKING ACTION RESULT =====/
    );

    if (!resultMatch) {
      sendJson(200, {
        success: false,
        outcome: "automation_error",
        error: `Octopus ${action} automation did not return a verified result. No success should be claimed.`
      });
      return;
    }

    let actionResult;
    try {
      actionResult = JSON.parse(resultMatch[1]);
    } catch (error) {
      sendJson(200, {
        success: false,
        outcome: "invalid_action_result",
        error: `Octopus ${action} returned an unreadable verification result.`
      });
      return;
    }

    const verified = action === "cancel"
      ? actionResult.ok === true && actionResult.verified_cancelled_in_octopus === true
      : actionResult.ok === true && actionResult.verified_rescheduled_in_octopus === true;

    sendJson(200, {
      ...actionResult,
      success: verified,
      action,
      bookingId: internalBookingId,
      bookingNumber: suppliedBookingNumber || null,
      customerConfirmed: true,
      verified_cancelled_in_octopus:
        action === "cancel" ? actionResult.verified_cancelled_in_octopus === true : undefined,
      verified_rescheduled_in_octopus:
        action === "reschedule" ? actionResult.verified_rescheduled_in_octopus === true : undefined,
      error: verified
        ? undefined
        : (actionResult.error || `Octopus did not verify the ${action}; no success should be claimed.`)
    });
    return;
  }

  if (action !== "create") {
    sendJson(400, {
      success: false,
      outcome: "unsupported_action",
      error: "Supported actions on this endpoint are lookup, create, cancel, and reschedule."
    });
    return;
  }

  if (body.customerConfirmed !== true) {
    sendJson(200, {
      success: false,
      outcome: "confirmation_required",
      error: "The customer must explicitly confirm the complete booking first."
    });
    return;
  }

  const requiredFields = [
    ["customerName", body.customerName],
    ["streetNumber", body.streetNumber],
    ["street", body.street || body.streetAddress],
    ["city", body.city || body.suburb],
    ["state", body.state],
    ["zip", body.zip || body.postcode],
    ["requestedDate", body.requestedDate],
    ["requestedStartTime", body.requestedStartTime]
  ];

  const missingFields = requiredFields
    .filter(([, value]) => !String(value || "").trim())
    .map(([name]) => name);

  if (missingFields.length > 0) {
    sendJson(200, {
      success: false,
      outcome: "missing_booking_fields",
      error: `Missing required booking fields: ${missingFields.join(", ")}`
    });
    return;
  }
// ============================================================
// ASYNC LISA BOOKING MODE
// ============================================================

if (body.asyncMode === true) {
  const requestId =
    createLisaBookingRequestId();

  lisaBookingJobs.set(requestId, {
    requestId,
    status: "queued",
    success: false,
    verified_created_in_octopus: false,
    outcome: "processing",
    customerName:
      body.customerName || null,
    requestedDate:
      body.requestedDate || null,
    requestedStartTime:
      body.requestedStartTime || null,
    createdAt: Date.now(),
    updatedAt: Date.now()
  });

  console.log(
    "Lisa async booking accepted:",
    requestId,
    body.customerName
  );

  // Intentionally do NOT await this.
  // The HTTP request returns immediately while Playwright continues.
  runLisaBookingInBackground(
    requestId,
    { ...body }
  ).catch(error => {
    console.error(
      "Unhandled Lisa async booking background error:",
      requestId,
      error
    );

    const previous =
      lisaBookingJobs.get(requestId) || {};

    lisaBookingJobs.set(requestId, {
      ...previous,
      requestId,
      status: "failed",
      success: false,
      verified_created_in_octopus: false,
      outcome: "automation_error",
      error:
        error?.message ||
        "Unexpected booking automation error.",
      updatedAt: Date.now()
    });
  });

  sendJson(202, {
    accepted: true,
    success: false,
    verified_created_in_octopus: false,
    status: "processing",
    outcome: "processing",
    requestId
  });

  return;
}
  console.log(
    "Lisa direct booking: launching Playwright creator for",
    body.customerName
  );

  let stdout = "";
  let stderr = "";

  try {
    const childResult = await execFileAsync(
      process.execPath,
      ["playwright/octopus-create-booking.js"],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          LISA_BOOKING_PAYLOAD: JSON.stringify({
            ...body,
            source: "LISA_VOICE"
          })
        },
        timeout: 180000,
        maxBuffer: 10 * 1024 * 1024
      }
    );

    stdout = String(childResult.stdout || "");
    stderr = String(childResult.stderr || "");
  } catch (error) {
    stdout = String(error?.stdout || "");
    stderr = String(error?.stderr || "");

    console.error(
      "Lisa direct booking Playwright process failed:",
      error?.message || error
    );

    if (stdout) {
      console.log("Lisa direct booking stdout before failure:", stdout.slice(-12000));
    }
    if (stderr) {
      console.error("Lisa direct booking stderr before failure:", stderr.slice(-12000));
    }

    sendJson(200, {
      success: false,
      verified_created_in_octopus: false,
      outcome: "playwright_booking_failed",
      error: error?.killed
        ? "Direct Octopus booking timed out."
        : (error?.message || "Direct Octopus booking failed.")
    });
    return;
  }

  if (stderr.trim()) {
    console.log(
      "Lisa direct booking stderr:",
      stderr.slice(-12000)
    );
  }

  console.log(
    "Lisa direct booking stdout:",
    stdout.slice(-16000)
  );

  const resultLine = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .reverse()
    .find((line) => line.startsWith("LISA_BOOKING_RESULT="));

  if (!resultLine) {
    sendJson(200, {
      success: false,
      verified_created_in_octopus: false,
      outcome: "playwright_booking_failed",
      error: "Octopus booking automation finished without returning a verified BOK."
    });
    return;
  }

  let result;
  try {
    result = JSON.parse(
      resultLine.slice("LISA_BOOKING_RESULT=".length)
    );
  } catch (error) {
    sendJson(200, {
      success: false,
      verified_created_in_octopus: false,
      outcome: "invalid_booking_result",
      error: "Direct Octopus booking returned an unreadable result."
    });
    return;
  }

  const bookingId =
    result.bookingId ||
    result.booking_id ||
    result.octopusBookingId ||
    result.octopus_booking_id ||
    null;

  const bookingNumber =
    result.bookingNumber ||
    result.booking_number ||
    result.bokNumber ||
    null;

  const verified =
    result.success === true &&
    Boolean(bookingId) &&
    /^BOK-\d+$/i.test(String(bookingNumber || ""));

  if (!verified) {
    sendJson(200, {
      ...result,
      success: false,
      verified_created_in_octopus: false,
      bookingId,
      bookingNumber,
      outcome: result.outcome || "verification_failed",
      error: result.error || "OctopusPro did not return both a verified booking ID and BOK number."
    });
    return;
  }

  // WRITE-THROUGH: do not wait for notification/dispatch discovery. The moment
  // Octopus verifies creation, seed booking_tracking so Customer 360 and the
  // booking-sync service can see/enrich the new booking immediately.
  try {
    await writeThroughLisaCreatedBooking(body, { ...result, bookingId, bookingNumber });
  } catch (error) {
    // Octopus creation is still real even if the cache write fails. Log loudly so
    // it can be repaired; never misreport the Octopus booking as uncreated.
    console.error(`LISA_POSTGRES_WRITE_THROUGH_FAILED ${bookingNumber}:`, error?.message || error);
  }

  const successWebhookUrl = String(
    process.env.LISA_BOOKING_SUCCESS_WEBHOOK_URL || ""
  ).trim();

  if (successWebhookUrl) {
    const successPayload = {
      event: "LISA_BOOKING_CREATED",
      bookingNumber,
      bookingId,
      customerName: body.customerName || "",
      customerFirstName: body.customerFirstName || "",
      customerLastName: body.customerLastName || "",
      customerPhone: body.customerPhone || body.phone || "",
      customerEmail: body.customerEmail || body.email || "",
      serviceAddress: body.serviceAddress || body.address || "",
      streetNumber: body.streetNumber || "",
      street: body.street || body.streetAddress || "",
      city: body.city || body.suburb || "",
      state: body.state || "",
      zip: body.zip || body.postcode || "",
      serviceName: body.serviceName || "Standard Cleaning",
      serviceType: body.serviceType || "",
      recurringFrequency: body.recurringFrequency || body.frequency || "",
      requestedDate: body.requestedDate || "",
      requestedStartTime: body.requestedStartTime || "",
      arrivalWindow: body.arrivalWindow || "",
      durationMinutes: body.durationMinutes || "",
      quotedPrice: body.quotedPrice ?? body.price ?? "",
      source: "LISA_VOICE",
      createdAt: new Date().toISOString()
    };

    try {
      const notifyResponse = await fetch(successWebhookUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify(successPayload),
        signal: AbortSignal.timeout(15000)
      });

      const notifyText = await notifyResponse.text();

      if (!notifyResponse.ok) {
        console.error(
          `Lisa booking success webhook failed (${notifyResponse.status}): ${notifyText}`
        );
      } else {
        console.log(
          `Lisa booking success webhook delivered for ${bookingNumber}.`
        );
      }
    } catch (error) {
      console.error(
        "Lisa booking success webhook error:",
        error?.message || error
      );
    }
  } else {
    console.log(
      "LISA_BOOKING_SUCCESS_WEBHOOK_URL is not configured; booking was created but success notification was skipped."
    );
  }

  sendJson(200, {
    ...result,
    success: true,
    verified_created_in_octopus: true,
    bookingId,
    bookingNumber,
    outcome: "created"
  });
  return;
}

      const bookingNumber = String(
        body.booking_number || ""
      ).trim().toUpperCase();

      const octopusBookingId = Number(
        body.octopus_booking_id
      );

      const octopusBookingUrl = String(
        body.octopus_booking_url || ""
      ).trim();

      if (!/^BOK-\d+$/.test(bookingNumber)) {
        sendJson(400, {
          status: "error",
          message: "booking_number must look like BOK-12345"
        });
        return;
      }

      if (!Number.isInteger(octopusBookingId) || octopusBookingId <= 0) {
        sendJson(400, {
          status: "error",
          message: "octopus_booking_id must be a positive integer"
        });
        return;
      }

      const expectedBookingUrl =
        `https://admin.octopuspro.com/booking/view/${octopusBookingId}`;

      const finalBookingUrl =
        octopusBookingUrl || expectedBookingUrl;

      await upsertNeedsCleanerFromHttp({
        bookingNumber,
        octopusBookingId,
        octopusBookingUrl: finalBookingUrl
      });

      console.log(
        `NEEDS CLEANER received by HTTP endpoint: ${bookingNumber} -> Octopus ${octopusBookingId}`
      );

      sendJson(200, {
        status: "ok",
        booking_number: bookingNumber,
        assignment_status: "NEEDS CLEANER",
        octopus_booking_id: octopusBookingId,
        octopus_booking_url: finalBookingUrl
      });
    } catch (error) {
      console.error(
        "POST /needs-cleaner failed:",
        error
      );

      sendJson(500, {
        status: "error",
        message: String(error?.message || error)
      });
    }
  });

  server.listen(port, "0.0.0.0", () => {
    console.log(
      `HTTP endpoint listening on port ${port}. POST /needs-cleaner, POST /outbound-call, and Lisa booking endpoints are ready.`
    );
  });

  return server;
}


async function main() {
  await pool.query(
    "SELECT 1"
  );

  console.log(
    "PostgreSQL connected successfully."
  );

  startHttpServer();

  const browser =
    await chromium.launch({
      headless: true,

      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage"
      ]
    });

  const context =
    await browser.newContext({
      viewport: {
        width: 1440,
        height: 1000
      }
    });

  /*
   * Critical architecture: notification tracking and automatic dispatch use
   * separate Playwright pages and separate locks. A slow Octopus recipient
   * search can no longer block En Route / Arrived / Finished / assignment
   * Make.com webhooks.
   */
  const notificationPage =
    await context.newPage();

  const dispatchPage =
    await context.newPage();

  const unassignedSweepPage =
    await context.newPage();

  for (
    const page of [
      notificationPage,
      dispatchPage,
      unassignedSweepPage
    ]
  ) {
    page.setDefaultTimeout(
      30000
    );

    page.setDefaultNavigationTimeout(
      60000
    );
  }

  await readNotifications(
    notificationPage
  );

  console.log(
    "Notification watcher active on dedicated page."
  );

  let notificationCheckRunning =
    false;

  setInterval(
    async () => {
      if (
        notificationCheckRunning
      ) {
        console.log(
          "Previous notification check is still running. Skipping notification cycle."
        );

        return;
      }

      notificationCheckRunning =
        true;

      try {
        await readNotifications(
          notificationPage
        );
      } catch (error) {
        console.error(
          "Notification check failed:",
          error
        );
      } finally {
        notificationCheckRunning =
          false;
      }
    },
    60000
  );

  let dispatchCheckRunning =
    false;

  const runDispatchCheck =
    async () => {
      if (
        dispatchCheckRunning
      ) {
        console.log(
          "Previous dispatch check is still running. Skipping dispatch cycle."
        );

        return;
      }

      dispatchCheckRunning =
        true;

      try {
        await dispatchNextBooking(
          dispatchPage
        );
      } catch (error) {
        console.error(
          "Automatic dispatch check failed:",
          error
        );
      } finally {
        dispatchCheckRunning =
          false;
      }
    };

  console.log(
    `Automatic dispatch enabled on dedicated page with a closest-${MAX_JOB_REQUEST_RECIPIENTS} recipient cap.`
  );

  /* Give the notification page first priority during startup. */
  setTimeout(
    runDispatchCheck,
    10000
  );

  setInterval(
    runDispatchCheck,
    60000
  );


  let unassignedSweepRunning =
    false;

  const runUnassignedSweep =
    async () => {
      if (
        unassignedSweepRunning
      ) {
        console.log(
          "Previous unassigned sweep is still running. Skipping sweep cycle."
        );

        return;
      }

      unassignedSweepRunning =
        true;

      try {
        await ensureLoggedIn(
          unassignedSweepPage
        );

        await sweepOctopusUnassignedBookings(
          unassignedSweepPage
        );
      } catch (error) {
        console.error(
          "Octopus unassigned booking sweep failed:",
          error
        );
      } finally {
        unassignedSweepRunning =
          false;
      }
    };


  console.log(
    `Octopus unassigned sweep enabled: every ${Math.round(UNASSIGNED_SWEEP_INTERVAL_MS / 60000)} minute(s), next ${UNASSIGNED_SWEEP_LOOKAHEAD_DAYS} day(s), ${UNASSIGNED_SWEEP_BATCH_SIZE} booking(s) per cycle.`
  );


  setTimeout(
    runUnassignedSweep,
    20000
  );


  setInterval(
    runUnassignedSweep,
    Math.max(
      60000,
      UNASSIGNED_SWEEP_INTERVAL_MS
    )
  );


  const shutdown =
    async (signal) => {
      console.log(
        `Received ${signal}. Shutting down watcher.`
      );

      await browser
        .close()
        .catch(() => {});

      await pool
        .end()
        .catch(() => {});

      process.exit(0);
    };

  process.on(
    "SIGTERM",
    () =>
      shutdown("SIGTERM")
  );

  process.on(
    "SIGINT",
    () =>
      shutdown("SIGINT")
  );
}


main().catch(
  async (error) => {
    console.error(
      "Watcher startup failed:",
      error
    );

    await pool
      .end()
      .catch(() => {});

    process.exit(1);
  }
);
