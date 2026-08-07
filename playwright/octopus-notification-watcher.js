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
const JOB_REQUEST_SENT_WEBHOOK_URL =
  process.env.JOB_REQUEST_SENT_WEBHOOK_URL;

const ORGANIZATION_NAME =
  process.env.OCTOPUS_ORGANIZATION_NAME || "SpeedyCleans";

if (!NOTIFICATIONS_URL) {
  throw new Error("Missing OCTOPUS_NOTIFICATIONS_URL");
}
if (!JOB_REQUEST_SENT_WEBHOOK_URL) {
  throw new Error("Missing JOB_REQUEST_SENT_WEBHOOK_URL");
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

  if (
    value.includes("accepted appointment for booking") ||
    value.includes("accepted booking request") ||
    value.includes("has accepted booking request")
  ) {
    return "ASSIGNED";
  }

  if (value.includes("is no longer attending")) {
    return "NEEDS CLEANER";
  }

  if (value.includes("on the way")) return "ON_THE_WAY";
  if (value.includes("automatically checked in")) return "ARRIVED";
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
    /^(.*?)\s+(?:accepted appointment for booking|has accepted booking request|accepted booking request|is no longer attending|has finished|has started|has arrived|is on the way|has been automatically checked in)/i
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
  "STARTED",
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
 const eventType = notification.eventType;

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
  eventType !== "NEEDS CLEANER"
) {
  return;
}

const assignmentStatus = eventType;

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
async function getNextDispatchBooking() {
  const result = await pool.query(`
    SELECT
      booking_number,
      octopus_booking_id,
      assignment_status,
      job_request_status
    FROM public.booking_dispatch_state
    WHERE assignment_status = 'NEEDS CLEANER'
      AND octopus_booking_id IS NOT NULL
      AND COALESCE(job_request_status, 'NOT_SENT') = 'NOT_SENT'
    ORDER BY updated_at ASC
    LIMIT 1;
  `);

  return result.rows[0] || null;
}
}
async function markDispatchSent(bookingNumber) {
  await pool.query(
    `
    UPDATE public.booking_dispatch_state
    SET
      job_request_status = 'SENT',
      dispatch_attempts = COALESCE(dispatch_attempts, 0) + 1,
      last_dispatch_attempt_at = NOW(),
      updated_at = NOW()
    WHERE booking_number = $1;
    `,
    [bookingNumber]
  );
}

async function markDispatchFailed(bookingNumber, error) {
  await pool.query(
    `
    UPDATE public.booking_dispatch_state
    SET
      job_request_status = 'FAILED',
      last_notification_text = $2,
      updated_at = NOW()
    WHERE booking_number = $1;
    `,
    [
      bookingNumber,
      String(error?.message || error).slice(0, 1000)
    ]
  );
}
async function sendJobRequestSentToMake({
  bookingNumber,
  octopusBookingId
}) {
  const sentAt = new Date().toISOString();

  const response = await fetch(
    JOB_REQUEST_SENT_WEBHOOK_URL,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        booking_number: bookingNumber,
        octopus_booking_id: octopusBookingId,
        job_request_status: "SENT",
        sent_at: sentAt
      })
    }
  );

  const responseText = await response.text();

  if (!response.ok) {
    throw new Error(
      `Job request sent webhook failed: ${response.status} ${responseText}`
    );
  }

  console.log(
    `Job request sent webhook delivered for ${bookingNumber} at ${sentAt}.`
  );
}
async function dispatchNextBooking(page) {
  const booking = await getNextDispatchBooking();

  if (!booking) {
    console.log("No bookings are waiting for dispatch.");
    return;
  }

  console.log(
    `Dispatching ${booking.booking_number} using Octopus ID ${booking.octopus_booking_id}...`
  );

  try {
    await openJobRequestModal(
      page,
      booking.octopus_booking_id
    );

    await markDispatchSent(booking.booking_number);
    await sendJobRequestSentToMake({
  bookingNumber: booking.booking_number,
  octopusBookingId: booking.octopus_booking_id
});

    console.log(
      `Dispatch completed and recorded for ${booking.booking_number}.`
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

try {
  await dispatchNextBooking(page);
} catch (error) {
  console.error("Controlled dispatch test failed:", error);
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

    await dispatchNextBooking(page);

} catch (error) {
    console.error(
        "Notification or dispatch check failed:",
        error
    );
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
