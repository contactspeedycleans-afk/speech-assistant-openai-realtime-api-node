import http from "node:http";
import pg from "pg";

const { Pool } = pg;

const PORT = Number(process.env.PORT || 8080);
const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  throw new Error("Missing DATABASE_URL");

}
const DISPATCH_TEST_SECRET =
  process.env.DISPATCH_TEST_SECRET;
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

function sendJson(response, statusCode, data) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*"
  });

  response.end(JSON.stringify(data));
}

function sendHtml(response, statusCode, html) {
  response.writeHead(statusCode, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer"
  });

  response.end(html);
}

function getTrackingToken(pathname, prefix) {
  if (!pathname.startsWith(prefix)) {
    return null;
  }

  const encodedToken = pathname.slice(prefix.length);

  if (!encodedToken) {
    return null;
  }

  try {
    const token = decodeURIComponent(encodedToken).trim();

    if (
      token.length < 10 ||
      token.length > 250 ||
      !/^[A-Za-z0-9_-]+$/.test(token)
    ) {
      return null;
    }

    return token;
  } catch {
    return null;
  }
}
async function recordTrackingOpen(request, trackingToken) {
  const forwardedFor = request.headers["x-forwarded-for"];

  const visitorIp =
    typeof forwardedFor === "string" && forwardedFor.trim()
      ? forwardedFor.split(",")[0].trim()
      : request.socket.remoteAddress || "";

  const userAgent =
    typeof request.headers["user-agent"] === "string"
      ? request.headers["user-agent"].slice(0, 1000)
      : "";

  await pool.query(
    `
    UPDATE public.booking_tracking
    SET
      tracking_open_count =
        COALESCE(tracking_open_count, 0) + 1,

      tracking_first_opened_at =
        COALESCE(tracking_first_opened_at, NOW()),

      tracking_last_opened_at = NOW(),
      tracking_last_ip = NULLIF($2, ''),
      tracking_last_user_agent = NULLIF($3, '')

    WHERE tracking_token = $1;
    `,
    [
      trackingToken,
      visitorIp,
      userAgent
    ]
  );
}
function buildTrackingPage() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta
    name="viewport"
    content="width=device-width, initial-scale=1.0"
  />
  <meta name="robots" content="noindex, nofollow" />

  <title>Speedy Solutions Service Tracker</title>

  <style>
    :root {
      font-family:
        Inter,
        ui-sans-serif,
        system-ui,
        -apple-system,
        BlinkMacSystemFont,
        "Segoe UI",
        sans-serif;

      color: #172033;
      background: #f4f7fb;
    }

    * {
      box-sizing: border-box;
    }

    body {
      margin: 0;
      min-height: 100vh;
      background:
        radial-gradient(
          circle at top,
          #ffffff 0%,
          #f4f7fb 45%,
          #e9eef7 100%
        );
    }

    .page {
      width: min(720px, calc(100% - 28px));
      margin: 0 auto;
      padding: 28px 0 48px;
    }

    .brand {
      margin-bottom: 18px;
      text-align: center;
    }

    .brand-name {
      margin: 0;
      font-size: clamp(26px, 6vw, 38px);
      font-weight: 800;
      letter-spacing: -0.04em;
      color: #172033;
    }

    .brand-subtitle {
      margin: 6px 0 0;
      color: #657086;
      font-size: 15px;
    }

    .card {
      overflow: hidden;
      border: 1px solid #dfe5ef;
      border-radius: 22px;
      background: rgba(255, 255, 255, 0.97);
      box-shadow:
        0 24px 65px rgba(29, 43, 75, 0.12),
        0 2px 8px rgba(29, 43, 75, 0.05);
    }

    .status-header {
      padding: 28px;
      color: white;
      background: #334155;
      transition: background 250ms ease;
    }

    .status-header.on-the-way {
      background: #2563eb;
    }

    .status-header.arrived {
      background: #7c3aed;
    }

    .status-header.started {
      background: #059669;
    }

    .status-header.finished {
      background: #166534;
    }

    .status-header.unknown {
      background: #475569;
    }

    .eyebrow {
      margin: 0 0 7px;
      font-size: 12px;
      font-weight: 800;
      letter-spacing: 0.12em;
      text-transform: uppercase;
      opacity: 0.85;
    }

    .status-title {
      margin: 0;
      font-size: clamp(29px, 7vw, 45px);
      line-height: 1.06;
      letter-spacing: -0.04em;
    }

    .status-description {
      margin: 10px 0 0;
      font-size: 16px;
      line-height: 1.5;
      opacity: 0.93;
    }

    .content {
      padding: 25px 28px 29px;
    }

    .details {
      display: grid;
      gap: 14px;
      margin: 0;
    }

    .detail {
      display: grid;
      grid-template-columns: minmax(120px, 0.75fr) minmax(0, 1.25fr);
      gap: 15px;
      align-items: center;
      padding-bottom: 14px;
      border-bottom: 1px solid #edf0f5;
    }

    .detail:last-child {
      padding-bottom: 0;
      border-bottom: 0;
    }

    .detail dt {
      color: #6b7280;
      font-size: 14px;
      font-weight: 650;
    }

    .detail dd {
      margin: 0;
      color: #172033;
      font-size: 15px;
      font-weight: 750;
      text-align: right;
      overflow-wrap: anywhere;
    }

    .timeline {
      margin-top: 27px;
      padding-top: 25px;
      border-top: 1px solid #e8edf4;
    }

    .timeline-title {
      margin: 0 0 17px;
      font-size: 18px;
      color: #172033;
    }

    .timeline-items {
      display: grid;
      gap: 13px;
    }

    .timeline-item {
      display: grid;
      grid-template-columns: 17px minmax(0, 1fr) auto;
      gap: 11px;
      align-items: center;
      color: #8a94a6;
    }

    .timeline-item.complete {
      color: #172033;
    }

    .timeline-dot {
      width: 13px;
      height: 13px;
      border: 3px solid #d1d8e3;
      border-radius: 50%;
      background: white;
    }

    .timeline-item.complete .timeline-dot {
      border-color: #16a34a;
      background: #16a34a;
    }

    .timeline-label {
      font-size: 14px;
      font-weight: 750;
    }

    .timeline-time {
      font-size: 13px;
      font-weight: 650;
      text-align: right;
    }

    .updated {
      margin: 25px 0 0;
      color: #7b8495;
      font-size: 12px;
      line-height: 1.5;
      text-align: center;
    }

    .loading,
    .error {
      padding: 46px 28px;
      text-align: center;
    }

    .loading h2,
    .error h2 {
      margin: 0 0 8px;
      color: #172033;
    }

    .loading p,
    .error p {
      margin: 0;
      color: #697386;
      line-height: 1.5;
    }

    .spinner {
      width: 36px;
      height: 36px;
      margin: 0 auto 18px;
      border: 4px solid #dce3ee;
      border-top-color: #2563eb;
      border-radius: 50%;
      animation: spin 0.9s linear infinite;
    }

    .hidden {
      display: none;
    }

    .footer {
      margin-top: 17px;
      color: #697386;
      font-size: 12px;
      line-height: 1.5;
      text-align: center;
    }

    @keyframes spin {
      to {
        transform: rotate(360deg);
      }
    }

    @media (max-width: 540px) {
      .page {
        width: min(100% - 18px, 720px);
        padding-top: 18px;
      }

      .status-header,
      .content {
        padding-left: 21px;
        padding-right: 21px;
      }

      .detail {
        grid-template-columns: 1fr;
        gap: 4px;
      }

      .detail dd {
        text-align: left;
      }

      .timeline-item {
        grid-template-columns: 17px minmax(0, 1fr);
      }

      .timeline-time {
        grid-column: 2;
        text-align: left;
      }
    }
  </style>
</head>

<body>
  <main class="page">
    <header class="brand">
      <h1 class="brand-name">Speedy Solutions</h1>
      <p class="brand-subtitle">Live service tracking</p>
    </header>

    <section class="card">
      <div id="loading" class="loading">
        <div class="spinner"></div>
        <h2>Loading your service update</h2>
        <p>Please wait while we retrieve the latest information.</p>
      </div>

      <div id="error" class="error hidden">
        <h2>Tracking information unavailable</h2>
        <p id="error-message">
          This tracking link may be invalid or expired.
        </p>
      </div>

      <div id="tracker" class="hidden">
        <header id="status-header" class="status-header unknown">
          <p class="eyebrow">Current service status</p>
          <h2 id="status-title" class="status-title">Updating</h2>
          <p
            id="status-description"
            class="status-description"
          ></p>
        </header>

        <div class="content">
          <dl class="details">
            <div class="detail">
              <dt>Booking</dt>
              <dd id="booking-number">—</dd>
            </div>

            <div class="detail">
              <dt>Service professional</dt>
              <dd id="worker-name">Being assigned</dd>
            </div>

            <div class="detail">
              <dt>Time on site</dt>
              <dd id="elapsed-time">Not started</dd>
            </div>
       <div id="hourly-rate-row" class="detail hidden">
  <dt>Hourly rate</dt>
  <dd id="hourly-rate">—</dd>
</div>

<div id="discount-row" class="detail hidden">
  <dt>Discount</dt>
  <dd id="discount-percent">—</dd>
</div>

<div id="service-total-row" class="detail hidden">
  <dt id="service-total-label">Current service total</dt>
  <dd id="service-total">—</dd>
</div>

<div id="minimum-note-row" class="detail hidden">
  <dt>Billing minimum</dt>
  <dd>Two-hour minimum applies</dd>
</div>
          </dl>

          <section class="timeline">
            <h3 class="timeline-title">Service timeline</h3>

            <div class="timeline-items">
              <div id="step-on-way" class="timeline-item">
                <span class="timeline-dot"></span>
                <span class="timeline-label">On the way</span>
                <span
                  id="time-on-way"
                  class="timeline-time"
                >Waiting</span>
              </div>

              <div id="step-arrived" class="timeline-item">
                <span class="timeline-dot"></span>
                <span class="timeline-label">Arrived</span>
                <span
                  id="time-arrived"
                  class="timeline-time"
                >Waiting</span>
              </div>

              <div id="step-started" class="timeline-item">
                <span class="timeline-dot"></span>
                <span class="timeline-label">Service started</span>
                <span
                  id="time-started"
                  class="timeline-time"
                >Waiting</span>
              </div>

              <div id="step-finished" class="timeline-item">
                <span class="timeline-dot"></span>
                <span class="timeline-label">Service completed</span>
                <span
                  id="time-finished"
                  class="timeline-time"
                >Waiting</span>
              </div>
            </div>
          </section>

          <p id="updated-time" class="updated">
            Updates automatically every 20 seconds.
          </p>
        </div>
      </div>
    </section>

    <p class="footer">
      This private tracking page displays service-status information
      provided by Speedy Solutions.
    </p>
  </main>

  <script>
    const pathParts = window.location.pathname.split("/");
    const token = pathParts[pathParts.length - 1];

    const statusInformation = {
      ON_THE_WAY: {
        className: "on-the-way",
        title: "Your cleaner is on the way",
        description:
          "Your service professional is traveling to your location."
      },

      ARRIVED: {
        className: "arrived",
        title: "Your cleaner has arrived",
        description:
          "Your service professional has reached the service location."
      },

      STARTED: {
        className: "started",
        title: "Your cleaning is underway",
        description:
          "Your service professional is currently completing your service."
      },

      FINISHED: {
        className: "finished",
        title: "Your service is complete",
        description:
          "Thank you for choosing Speedy Solutions."
      }
    };

    function setText(id, value) {
      const element = document.getElementById(id);

      if (element) {
        element.textContent = value;
      }
    }
function formatCurrency(value) {
  const number = Number(value);

  if (!Number.isFinite(number)) {
    return "Not available";
  }

  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD"
  }).format(number);
}

function showElement(id, shouldShow) {
  const element = document.getElementById(id);

  if (!element) {
    return;
  }

  element.classList.toggle("hidden", !shouldShow);
}
    function formatTime(value) {
      if (!value) {
        return "Waiting";
      }

      const date = new Date(value);

      if (Number.isNaN(date.getTime())) {
        return "Updated";
      }

      return new Intl.DateTimeFormat([], {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit"
      }).format(date);
    }

    function calculateElapsed(startedAt, finishedAt) {
      if (!startedAt) {
        return "Not started";
      }

      const start = new Date(startedAt);
      const end = finishedAt
        ? new Date(finishedAt)
        : new Date();

      if (
        Number.isNaN(start.getTime()) ||
        Number.isNaN(end.getTime())
      ) {
        return "Unavailable";
      }

      const totalMinutes = Math.max(
        0,
        Math.floor((end.getTime() - start.getTime()) / 60000)
      );

      const hours = Math.floor(totalMinutes / 60);
      const minutes = totalMinutes % 60;

      if (hours === 0) {
        return totalMinutes + " minute" +
          (totalMinutes === 1 ? "" : "s");
      }

      return (
        hours +
        " hour" +
        (hours === 1 ? "" : "s") +
        " " +
        minutes +
        " minute" +
        (minutes === 1 ? "" : "s")
      );
    }

    function setTimelineStep(stepId, timeId, value) {
      const step = document.getElementById(stepId);

      if (value) {
        step.classList.add("complete");
        setText(timeId, formatTime(value));
      } else {
        step.classList.remove("complete");
        setText(timeId, "Waiting");
      }
    }

    function showError(message) {
      document.getElementById("loading").classList.add("hidden");
      document.getElementById("tracker").classList.add("hidden");
      document.getElementById("error").classList.remove("hidden");

      setText(
        "error-message",
        message || "This tracking link may be invalid or expired."
      );
    }

    function renderTracking(data) {
      const status =
        statusInformation[data.status] ||
        {
          className: "unknown",
          title: "Service update available",
          description:
            "Please check back shortly for the latest service status."
        };

      const statusHeader =
        document.getElementById("status-header");

      statusHeader.className =
        "status-header " + status.className;

      setText("status-title", status.title);
      setText("status-description", status.description);
      setText("booking-number", data.booking_number || "—");
      setText(
        "worker-name",
        data.worker_name || "Being assigned"
      );

      setText(
        "elapsed-time",
        calculateElapsed(
          data.started_at,
          data.finished_at
        )
      );
const hourlyRate = Number(data.hourly_rate);
const discountPercent = Number(data.discount_percent);
const subtotal = Number(data.subtotal);
const finalTotal = Number(data.final_total);

const hasHourlyRate = Number.isFinite(hourlyRate);
const hasDiscount =
  Number.isFinite(discountPercent) &&
  discountPercent > 0;

const minimumTotal =
  Number.isFinite(hourlyRate)
    ? hourlyRate * 2
    : null;

const rawDisplayedTotal =
  data.status === "FINISHED" &&
  Number.isFinite(finalTotal)
    ? finalTotal
    : subtotal;

const displayedTotal =
  Number.isFinite(rawDisplayedTotal) &&
  Number.isFinite(minimumTotal)
    ? Math.max(rawDisplayedTotal, minimumTotal)
    : rawDisplayedTotal;

showElement("hourly-rate-row", hasHourlyRate);
showElement("discount-row", hasDiscount);
showElement(
  "service-total-row",
  Number.isFinite(displayedTotal)
);
showElement("minimum-note-row", hasHourlyRate);

if (hasHourlyRate) {
  setText(
    "hourly-rate",
    formatCurrency(hourlyRate) + " per labor hour"
  );
}

if (hasDiscount) {
  setText(
    "discount-percent",
    discountPercent + "%"
  );
}

if (Number.isFinite(displayedTotal)) {
  setText(
    "service-total-label",
    data.status === "FINISHED"
      ? "Final service total"
      : "Current service total"
  );

  setText(
    "service-total",
    formatCurrency(displayedTotal)
  );
}
      setTimelineStep(
        "step-on-way",
        "time-on-way",
        data.on_the_way_at
      );

      setTimelineStep(
        "step-arrived",
        "time-arrived",
        data.arrived_at
      );

      setTimelineStep(
        "step-started",
        "time-started",
        data.started_at
      );

      setTimelineStep(
        "step-finished",
        "time-finished",
        data.finished_at
      );

      if (data.updated_at) {
        setText(
          "updated-time",
          "Last updated " +
            formatTime(data.updated_at) +
            ". This page refreshes automatically."
        );
      }

      document.getElementById("loading").classList.add("hidden");
      document.getElementById("error").classList.add("hidden");
      document.getElementById("tracker").classList.remove("hidden");
    }

    async function loadTracking() {
      if (!token) {
        showError("The tracking link is incomplete.");
        return;
      }

      try {
        const response = await fetch(
          "/api/track/" + encodeURIComponent(token),
          {
            cache: "no-store"
          }
        );

        const data = await response.json();

        if (!response.ok || !data.success) {
          showError(
            data.error ||
              "This tracking link may be invalid or expired."
          );

          return;
        }

        renderTracking(data.tracking);
      } catch (error) {
        console.error("Tracking refresh failed:", error);

        showError(
          "We could not retrieve the latest update. Please try again shortly."
        );
      }
    }

    loadTracking();
    window.setInterval(loadTracking, 20000);
  </script>
</body>
</html>`;
}

const server = http.createServer(async (request, response) => {
  try {
    const requestUrl = new URL(
      request.url || "/",
      "http://localhost"
    );

    const pathname = requestUrl.pathname;

    if (request.method === "GET" && pathname === "/health") {
      await pool.query("SELECT 1");

      return sendJson(response, 200, {
        success: true,
        service: "speedy-customer-tracker"
      });
    }

    if (request.method === "GET" && pathname === "/") {
      return sendHtml(
        response,
        200,
        `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta
    name="viewport"
    content="width=device-width, initial-scale=1.0"
  />
  <title>Speedy Solutions Tracker</title>
</head>
<body style="
  margin:0;
  min-height:100vh;
  display:grid;
  place-items:center;
  padding:24px;
  box-sizing:border-box;
  font-family:Arial,sans-serif;
  color:#172033;
  background:#f4f7fb;
">
  <main style="
    max-width:600px;
    padding:38px;
    text-align:center;
    border:1px solid #dfe5ef;
    border-radius:20px;
    background:white;
    box-shadow:0 20px 55px rgba(29,43,75,.12);
  ">
    <h1 style="margin-top:0;">Speedy Solutions</h1>
    <p>
      Please use the private tracking link provided with your
      appointment.
    </p>
  </main>
</body>
</html>`
      );
    }

    const apiToken = getTrackingToken(
      pathname,
      "/api/track/"
    );

    if (request.method === "GET" && apiToken) {
      const result = await pool.query(
        `
      
        SELECT
  booking_number,
  status,
  worker_name,
  on_the_way_at,
  arrived_at,
  started_at,
  finished_at,
  hourly_rate,
  discount_percent,
  subtotal,
  final_total,
  duration_minutes,
  updated_at
        FROM public.booking_tracking
        WHERE tracking_token = $1
        LIMIT 1;
        `,
        [apiToken]
      );

      if (result.rowCount === 0) {
        return sendJson(response, 404, {
          success: false,
          error:
            "This tracking link was not found or is no longer available."
        });
      }

      return sendJson(response, 200, {
        success: true,
        tracking: result.rows[0]
      });
    }

    const pageToken = getTrackingToken(
  pathname,
  "/track/"
);

if (request.method === "GET" && pageToken) {
  const result = await pool.query(
    `
    SELECT booking_number
    FROM public.booking_tracking
    WHERE tracking_token = $1
    LIMIT 1;
    `,
    [pageToken]
  );

  if (result.rowCount === 0) {
    return sendHtml(
      response,
      404,
      `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta
    name="viewport"
    content="width=device-width, initial-scale=1.0"
  />
  <meta name="robots" content="noindex, nofollow" />
  <title>Tracking Link Unavailable</title>
</head>

<body style="
  margin:0;
  min-height:100vh;
  display:grid;
  place-items:center;
  padding:24px;
  box-sizing:border-box;
  font-family:Arial,sans-serif;
  color:#172033;
  background:#f4f7fb;
">
  <main style="
    max-width:600px;
    padding:38px;
    text-align:center;
    border:1px solid #dfe5ef;
    border-radius:20px;
    background:white;
    box-shadow:0 20px 55px rgba(29,43,75,.12);
  ">
    <h1 style="margin-top:0;">
      Tracking information unavailable
    </h1>

    <p>
      This tracking link was not found or is no longer available.
    </p>
  </main>
</body>
</html>`
    );
  }

  await recordTrackingOpen(
    request,
    pageToken
  );

  console.log(
    `Tracking page opened: ${result.rows[0].booking_number}`
  );

  return sendHtml(
    response,
    200,
    buildTrackingPage()
  );
}
    

    return sendJson(response, 404, {
      success: false,
      error: "Page not found."
    });
  } catch (error) {
    console.error("Customer tracker request failed:", error);

    return sendJson(response, 500, {
      success: false,
      error:
        "The tracking service is temporarily unavailable."
    });
  }
});

async function startServer() {
  await pool.query("SELECT 1");

  console.log("PostgreSQL connected successfully.");

  server.listen(PORT, "0.0.0.0", () => {
    console.log(
      `Customer tracker is listening on port ${PORT}`
    );
  });
}

function shutdown(signal) {
  console.log(`Received ${signal}. Shutting down tracker.`);

  server.close(async () => {
    await pool.end().catch(() => {});
    process.exit(0);
  });
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

startServer().catch(async (error) => {
  console.error("Customer tracker startup failed:", error);

  await pool.end().catch(() => {});
  process.exit(1);
});
