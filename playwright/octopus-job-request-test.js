import { chromium } from "playwright";

const BOOKING_URL =
  "https://admin.octopuspro.com/booking/view/563418";

const MAKE_WEBHOOK =
  "https://hook.us2.make.com/evvl72a9k1malbj3fscv3xasu3i5oadf";

const RADII = [30, 45, 60, 70];

async function clickLoadMoreUntilDone(page) {
  let pageCount = 1;

  while (true) {
    const loadMoreButton = page
      .getByRole("button", {
        name: /load more|show more/i
      })
      .first();

    const visible = await loadMoreButton
      .isVisible()
      .catch(() => false);

    if (!visible) {
      console.log(
        `No more fieldworker pages. Loaded ${pageCount} page(s).`
      );
      break;
    }

    console.log(
      `Loading additional fieldworkers - page ${pageCount + 1}...`
    );

    await loadMoreButton.click();

    await page.waitForTimeout(2000);

    pageCount++;
  }
}

async function setRadius(page, radius) {
  console.log(`Setting radius to ${radius} miles...`);

  const radiusSelect = page
    .locator("select")
    .filter({
      has: page.locator(`option[value="${radius}"]`)
    })
    .first();

  if (await radiusSelect.isVisible().catch(() => false)) {
    await radiusSelect.selectOption(String(radius));
    await page.waitForTimeout(2500);

    console.log(`Radius changed to ${radius} miles.`);
    return;
  }

  const radiusButton = page
    .getByRole("button", {
      name: new RegExp(`${radius}.*mile`, "i")
    })
    .first();

  if (await radiusButton.isVisible().catch(() => false)) {
    await radiusButton.click();
    await page.waitForTimeout(2500);

    console.log(`Radius changed to ${radius} miles.`);
    return;
  }

  throw new Error(
    `Could not find the Octopus radius control for ${radius} miles.`
  );
}

async function sendJobRequests(page, radius) {
  console.log(
    `Opening Send Job Request window for ${radius} miles...`
  );

  const sendJobRequestButton = page.getByRole("button", {
    name: /send job request/i
  });

  await sendJobRequestButton.waitFor({
    state: "visible",
    timeout: 30000
  });

  await sendJobRequestButton.click();

  await page
    .getByRole("heading", {
      name: /send job request/i
    })
    .waitFor({
      state: "visible",
      timeout: 30000
    });

  console.log("Send Job Request window opened.");

  const sendButton = page.locator("button.save-btn");

  await sendButton.waitFor({
    state: "visible",
    timeout: 30000
  });

  console.log(`Sending ${radius}-mile requests...`);

  await sendButton.click();

  const sentAt = new Date().toISOString();

  console.log(
    `${radius}-mile job request sent at ${sentAt}`
  );

  await fetch(MAKE_WEBHOOK, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      booking: BOOKING_URL,
      status: "SENT",
      radius,
      sentAt
    })
  });

  console.log(
    `${radius}-mile timestamp sent to Make.`
  );

  await page.waitForTimeout(3000);
}

async function run() {
  const browser = await chromium.launch({
    headless: false
  });

  const page = await browser.newPage();

  console.log("Opening Octopus booking...");

  await page.goto(BOOKING_URL, {
    waitUntil: "domcontentloaded",
    timeout: 60000
  });

  console.log("Waiting for Available Fieldworkers...");

  const availableFieldworkers = page.getByText(
    "Available Fieldworkers",
    {
      exact: true
    }
  );

  await availableFieldworkers.waitFor({
    state: "visible",
    timeout: 60000
  });

  await availableFieldworkers.scrollIntoViewIfNeeded();

  await page
    .getByText(/\d+\s+of\s+\d+\s+available/i)
    .waitFor({
      state: "visible",
      timeout: 60000
    });

  for (const radius of RADII) {
    console.log("");
    console.log(
      `========== ${radius} MILE ROUND ==========`
    );

    await setRadius(page, radius);

    await page
      .getByText(/\d+\s+of\s+\d+\s+available/i)
      .waitFor({
        state: "visible",
        timeout: 60000
      });

    await clickLoadMoreUntilDone(page);

    await sendJobRequests(page, radius);

    console.log(
      `Finished ${radius}-mile dispatch round.`
    );
  }

  console.log("");
  console.log(
    "All 30 / 45 / 60 / 70 mile rounds completed."
  );

  await browser.close();
}

run().catch((error) => {
  console.error(
    "Job request automation failed:",
    error
  );

  process.exit(1);
});
