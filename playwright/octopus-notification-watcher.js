import { chromium } from "playwright";
import pg from "pg";

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


async function getJobRequestContainer(
  page
) {
  // Octopus keeps many hidden copies of the Send Job Request modal in the DOM.
  // Do NOT use .last() or assume Load More is a <button>. Find the copy that
  // is actually visible, then walk up to its active modal/container.
  const startedAt = Date.now();
  let anchor = null;


  while (
    Date.now() - startedAt < 120000
  ) {
    const titleCandidates =
      page.getByText(
        "Send Job Request",
        { exact: true }
      );

    const titleCount =
      await titleCandidates
        .count()
        .catch(() => 0);

    for (
      let index = 0;
      index < titleCount;
      index += 1
    ) {
      const candidate =
        titleCandidates.nth(index);

      if (
        await candidate
          .isVisible()
          .catch(() => false)
      ) {
        anchor = candidate;
        break;
      }
    }


    if (!anchor) {
      const showingCandidates =
        page.getByText(
          /Showing\s+\d+(?:\s+of\s+\d+)?\s+matches/i
        );

      const showingCount =
        await showingCandidates
          .count()
          .catch(() => 0);

      for (
        let index = 0;
        index < showingCount;
        index += 1
      ) {
        const candidate =
          showingCandidates.nth(index);

        if (
          await candidate
            .isVisible()
            .catch(() => false)
        ) {
          anchor = candidate;
          break;
        }
      }
    }


    if (!anchor) {
      const loadMoreCandidates =
        page.getByText(
          "Load More",
          { exact: true }
        );

      const loadMoreCount =
        await loadMoreCandidates
          .count()
          .catch(() => 0);

      for (
        let index = 0;
        index < loadMoreCount;
        index += 1
      ) {
        const candidate =
          loadMoreCandidates.nth(index);

        if (
          await candidate
            .isVisible()
            .catch(() => false)
        ) {
          anchor = candidate;
          break;
        }
      }
    }


    if (anchor) {
      break;
    }


    await page.waitForTimeout(
      2000
    );
  }


  if (!anchor) {
    const bodyText =
      await page
        .locator("body")
        .innerText()
        .catch(() => "");

    console.log(
      "JOB REQUEST PAGE TEXT WHEN POPUP DETECTION FAILED:",
      bodyText.slice(-6000)
    );

    throw new Error(
      "Send Job Request popup opened after click, but no visible popup title, match count, or Load More control could be detected."
    );
  }


  let container = anchor.locator(
    "xpath=ancestor::*[contains(concat(' ', normalize-space(@class), ' '), ' modal-content ')][1]"
  );


  if (
    (await container.count().catch(() => 0)) === 0
  ) {
    container = anchor.locator(
      "xpath=ancestor::*[contains(concat(' ', normalize-space(@class), ' '), ' modal ')][1]"
    );
  }


  if (
    (await container.count().catch(() => 0)) === 0
  ) {
    // Fallback for Octopus/Vue wrappers that are not marked up as Bootstrap modals.
    container = anchor.locator(
      "xpath=ancestor::*[.//*[normalize-space()='Send'] and .//*[normalize-space()='Close']][1]"
    );
  }


  if (
    (await container.count().catch(() => 0)) === 0
  ) {
    throw new Error(
      "A visible Send Job Request popup anchor was found, but its container could not be located."
    );
  }


  await container.waitFor({
    state: "visible",
    timeout: 30000
  });


  const containerText =
    await container
      .innerText()
      .catch(() => "");


  console.log(
    "Open Send Job Request container found from a visible popup element."
  );


  console.log(
    "Job Request container preview:",
    containerText.slice(0, 1200)
  );


  return container;
}


async function setJobRequestRadius(
  page,
  radiusMiles
) {
  console.log(
    `Loading fieldworkers until the list reaches ${radiusMiles} miles...`
  );


  const dialog =
    await getJobRequestContainer(
      page
    );


  const getVisibleDistanceInfo =
    async () => {
      const rows = dialog.locator("tr");

      const rowCount =
        await rows
          .count()
          .catch(() => 0);

      const distances = [];


      for (
        let index = 0;
        index < rowCount;
        index += 1
      ) {
        const row = rows.nth(index);

        const cells =
          row.locator("td");

        const cellCount =
          await cells
            .count()
            .catch(() => 0);

        if (cellCount < 2) {
          continue;
        }

        const distanceText =
          (
            await cells
              .nth(1)
              .innerText()
              .catch(() => "")
          ).trim();

        const distanceMatch =
          distanceText.match(
            /\d+(?:\.\d+)?/
          );

        if (!distanceMatch) {
          continue;
        }

        const distance =
          Number(distanceMatch[0]);

        if (Number.isFinite(distance)) {
          distances.push(distance);
        }
      }


      const dialogText =
        await dialog
          .innerText()
          .catch(() => "");

      const showingMatch =
        dialogText.match(
          /Showing\s+(\d+)\s+of\s+(\d+)\s+matches/i
        );

      const showingSimpleMatch =
        dialogText.match(
          /Showing\s+(\d+)\s+matches/i
        );


      return {
        distances,

        maxDistance:
          distances.length > 0
            ? Math.max(...distances)
            : null,

        loadedCount:
          showingMatch
            ? Number(showingMatch[1])
            : showingSimpleMatch
              ? Number(showingSimpleMatch[1])
              : distances.length,

        totalCount:
          showingMatch
            ? Number(showingMatch[2])
            : showingSimpleMatch
              ? Number(showingSimpleMatch[1])
              : distances.length,

        dialogText
      };
    };


  const waitForLoadMoreReady =
    async () => {
      const startedAt = Date.now();

      while (
        Date.now() - startedAt < 120000
      ) {
        // In Octopus this control may be a button, link, div, or Vue component.
        // Find the visible exact text instead of requiring role=button.
        const loadMoreCandidates =
          dialog.getByText(
            "Load More",
            { exact: true }
          );

        const loadMoreCount =
          await loadMoreCandidates
            .count()
            .catch(() => 0);

        for (
          let index = 0;
          index < loadMoreCount;
          index += 1
        ) {
          const candidate =
            loadMoreCandidates.nth(index);

          if (
            await candidate
              .isVisible()
              .catch(() => false)
          ) {
            return candidate;
          }
        }


        const loadingCandidates =
          dialog.getByText(
            /Loading/i
          );

        const loadingCount =
          await loadingCandidates
            .count()
            .catch(() => 0);

        let loadingVisible = false;

        for (
          let index = 0;
          index < loadingCount;
          index += 1
        ) {
          if (
            await loadingCandidates
              .nth(index)
              .isVisible()
              .catch(() => false)
          ) {
            loadingVisible = true;
            break;
          }
        }


        if (loadingVisible) {
          await page.waitForTimeout(2000);
          continue;
        }


        // If the match count already says every result is loaded, there may be
        // no Load More control at all. The caller will continue with the list.
        const currentText =
          await dialog
            .innerText()
            .catch(() => "");

        const countMatch =
          currentText.match(
            /Showing\s+(\d+)\s+of\s+(\d+)\s+matches/i
          );

        if (
          countMatch &&
          Number(countMatch[1]) >= Number(countMatch[2])
        ) {
          return null;
        }


        await page.waitForTimeout(
          2000
        );
      }

      return null;
    };


  let info =
    await getVisibleDistanceInfo();


  console.log(
    `Job Request modal currently shows ${info.loadedCount} of ${info.totalCount} matches; farthest visible distance: ${info.maxDistance ?? "unknown"} miles.`
  );


  let loadMoreClicks = 0;


  while (
    info.maxDistance === null ||
    info.maxDistance < radiusMiles
  ) {
    if (
      info.totalCount > 0 &&
      info.loadedCount >= info.totalCount
    ) {
      console.log(
        `All ${info.totalCount} fieldworkers are loaded. Farthest available distance is ${info.maxDistance ?? "unknown"} miles, which is below the requested ${radiusMiles}-mile round.`
      );

      break;
    }


    const loadMoreButton =
      await waitForLoadMoreReady();


    if (!loadMoreButton) {
      console.log(
        `No Load More button is available. Continuing with the fieldworkers currently loaded for the ${radiusMiles}-mile round.`
      );

      break;
    }


    const previousLoadedCount =
      info.loadedCount;


    await loadMoreButton
      .scrollIntoViewIfNeeded()
      .catch(() => {});


    await loadMoreButton.click({
      timeout: 30000,
      force: true
    });


    loadMoreClicks += 1;


    console.log(
      `Clicked Load More (${loadMoreClicks}) while building the ${radiusMiles}-mile job request.`
    );


    const loadStartedAt = Date.now();


    while (
      Date.now() - loadStartedAt < 120000
    ) {
      await page.waitForTimeout(2000);

      const nextInfo =
        await getVisibleDistanceInfo();

      if (
        nextInfo.loadedCount >
          previousLoadedCount ||
        nextInfo.maxDistance !==
          info.maxDistance
      ) {
        info = nextInfo;
        break;
      }

      const loadingVisible =
        await dialog
          .getByRole("button", {
            name: /Loading/i
          })
          .last()
          .isVisible()
          .catch(() => false);

      if (!loadingVisible) {
        info = nextInfo;
        break;
      }
    }


    console.log(
      `After Load More: ${info.loadedCount} of ${info.totalCount} matches loaded; farthest visible distance: ${info.maxDistance ?? "unknown"} miles.`
    );


    if (loadMoreClicks >= 50) {
      throw new Error(
        `Stopped after 50 Load More clicks while trying to reach ${radiusMiles} miles.`
      );
    }
  }


  console.log(
    `Fieldworker list is ready for the ${radiusMiles}-mile dispatch round. Loaded ${info.loadedCount} of ${info.totalCount} matches; farthest visible distance: ${info.maxDistance ?? "unknown"} miles.`
  );


  return {
    availableFieldworkerCount:
      info.loadedCount,

    totalFieldworkerCount:
      info.totalCount,

    farthestVisibleDistance:
      info.maxDistance
  };
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


  const clickedJobRequest =
    await page.evaluate(
      () => {
        const buttons =
          Array.from(
            document.querySelectorAll(
              "button"
            )
          );


        const button =
          buttons.find(
            (element) => {
              const text =
                (
                  element.textContent ||
                  ""
                )
                  .trim()
                  .toLowerCase();


              const rectangle =
                element
                  .getBoundingClientRect();


              const styles =
                window.getComputedStyle(
                  element
                );


              return (
                text ===
                  "send job request" &&

                rectangle.width >
                  0 &&

                rectangle.height >
                  0 &&

                styles.display !==
                  "none" &&

                styles.visibility !==
                  "hidden" &&

                !element.disabled
              );
            }
          );


        if (!button) {
          return false;
        }


        button.scrollIntoView({
          behavior:
            "instant",

          block:
            "center"
        });


        // OctopusPro's button uses Vue/Bootstrap modal wiring. A raw DOM
        // element.click() can log as a click without Playwright performing the
        // full trusted pointer interaction Octopus expects.
        return true;
      }
    );


  if (!clickedJobRequest) {
    throw new Error(
      `Could not locate Send Job Request for ${bookingId}.`
    );
  }


  // Use Playwright's real click instead of HTMLElement.click(). This is
  // important for OctopusPro because the control is wired to open
  // #JOB_REQUEST_POPUP through the application's UI event handlers.
  await sendJobRequestButton.click({
    timeout: 30000
  });


  console.log(
    `Clicked Send Job Request for ${bookingId} with Playwright pointer click.`
  );


  // Give Vue/Bootstrap a moment to mount/show the popup before diagnostics.
  await page.waitForTimeout(1500);


  await diagnoseJobRequestUi(
    page,
    bookingId
  );


  const jobRequestDialog =
    await getJobRequestContainer(
      page
    );


  console.log(
    `Send Job Request modal opened for ${bookingId}.`
  );


  const radiusResult =
    await setJobRequestRadius(
      page,
      radiusMiles
    );


  let finalSendButton =
    jobRequestDialog
      .getByRole(
        "button",
        {
          name:
            /^\s*Send\s*$/i
        }
      )
      .last();


  if (
    !(
      await finalSendButton
        .isVisible()
        .catch(() => false)
    )
  ) {
    console.log(
      `Final Send button is not ready yet for ${bookingId}. Waiting...`
    );


    let foundSendButton =
      false;


    for (
      let attempt = 1;
      attempt <= 12;
      attempt += 1
    ) {
      await page.waitForTimeout(
        5000
      );

      finalSendButton =
        jobRequestDialog
          .getByRole(
            "button",
            {
              name:
                /^\s*Send\s*$/i
            }
          )
          .last();

      if (
        await finalSendButton
          .isVisible()
          .catch(() => false)
      ) {
        foundSendButton = true;
        break;
      }

      console.log(
        `Still waiting for final Send button — attempt ${attempt}/12 for ${bookingId}.`
      );
    }


    if (!foundSendButton) {
      const dialogText =
        await jobRequestDialog
          .innerText()
          .catch(() => "");

      console.log(
        "JOB REQUEST DIALOG TEXT WHEN SEND FAILED:",
        dialogText.slice(
          -6000
        )
      );

      throw new Error(
        `Final Send button never appeared for ${bookingId}.`
      );
    }
  }


  await finalSendButton
    .scrollIntoViewIfNeeded()
    .catch(() => {});


  await finalSendButton.click({
    timeout: 30000,
    force: true
  });


  console.log(
    `Clicked FINAL Send button for ${bookingId} after loading through the ${radiusMiles}-mile marker.`
  );


  console.log(
    `Waiting 45 seconds for Octopus to finish sending ${bookingId}...`
  );


  await page.waitForTimeout(
    45000
  );


  console.log(
    `Job request send process completed for ${bookingId}.`
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
    await markDispatchFailed(
      booking.booking_number,
      error
    );

    throw error;
  }
}


async function main() {
  await pool.query(
    "SELECT 1"
  );

  console.log(
    "PostgreSQL connected successfully."
  );

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

  const page =
    await context.newPage();

  page.setDefaultTimeout(
    30000
  );

  page.setDefaultNavigationTimeout(
    60000
  );

  await readNotifications(
    page
  );

  try {
    await dispatchNextBooking(
      page
    );
  } catch (error) {
    console.error(
      "Controlled dispatch test failed:",
      error
    );
  }

  let checkRunning =
    false;

  setInterval(
    async () => {
      if (checkRunning) {
        console.log(
          "Previous notification check is still running. Skipping this cycle."
        );

        return;
      }

      checkRunning = true;

      try {
        await readNotifications(
          page
        );

        await dispatchNextBooking(
          page
        );
      } catch (error) {
        console.error(
          "Notification or dispatch check failed:",
          error
        );
      } finally {
        checkRunning = false;
      }
    },
    60000
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
