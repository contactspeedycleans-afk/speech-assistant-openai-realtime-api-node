import { chromium } from "playwright";

const BOOKING_URL =
  "https://admin.octopuspro.com/booking/view/563418";

const MAKE_WEBHOOK =
  "https://hook.us2.make.com/evvl72a9k1malbj3fscv3xasu3i5oadf";

// FIRST TEST:
const RADII = [30];

// AFTER 30 MILES WORKS, CHANGE BACK TO:
// const RADII = [30, 45, 60, 70];

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

async function openSendJobRequest(page, radius) {
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

  const modalHeading = page.getByRole("heading", {
    name: /send job request/i
  });

  await modalHeading.waitFor({
    state: "visible",
    timeout: 30000
  });

  console.log("Send Job Request window opened.");

  await page.waitForTimeout(1000);
}

async function getLoadedCounts(page) {
  const countText = page
    .getByText(/showing\s+\d+\s+of\s+\d+\s+matches/i)
    .first();

  if (!(await countText.isVisible().catch(() => false))) {
    return null;
  }

  const text = await countText.innerText();

  const match = text.match(
    /showing\s+(\d+)\s+of\s+(\d+)\s+matches/i
  );

  if (!match) {
    return null;
  }

  return {
    loaded: Number(match[1]),
    total: Number(match[2])
  };
}

async function clickLoadMoreUntilDone(page) {
  console.log("Loading all available fieldworkers...");

  while (true) {
    const counts = await getLoadedCounts(page);

    if (counts) {
      console.log(
        `Currently showing ${counts.loaded} of ${counts.total} matches.`
      );

      if (counts.loaded >= counts.total) {
        console.log("All matching fieldworkers are loaded.");

        break;
      }
    }

    const loadMoreButton = page
      .getByRole("button", {
        name: /load more/i
      })
      .first();

    const visible = await loadMoreButton
      .isVisible()
      .catch(() => false);

    if (!visible) {
      console.log(
        "Load More button is no longer visible."
      );

      break;
    }

    const beforeCounts = await getLoadedCounts(page);

    const previousLoaded =
      beforeCounts?.loaded ?? 0;

    console.log(
      `Clicking Load More. Currently loaded: ${previousLoaded}`
    );

    await loadMoreButton.click();

    const loadingButton = page
      .getByRole("button", {
        name: /loading/i
      })
      .first();

    if (
      await loadingButton
        .isVisible()
        .catch(() => false)
    ) {
      console.log("Waiting for Octopus to finish loading...");

      await loadingButton
        .waitFor({
          state: "hidden",
          timeout: 60000
        })
        .catch(() => {});
    }

    await page.waitForFunction(
      (previous) => {
        const bodyText =
          document.body.innerText;

        const match = bodyText.match(
          /Showing\s+(\d+)\s+of\s+(\d+)\s+matches/i
        );

        if (!match) {
          return true;
        }

        return Number(match[1]) > previous;
      },
      previousLoaded,
      {
        timeout: 60000
      }
    ).catch(() => {});

    await page.waitForTimeout(750);

    const afterCounts = await getLoadedCounts(page);

    if (
      afterCounts &&
      afterCounts.loaded <= previousLoaded &&
      afterCounts.loaded < afterCounts.total
    ) {
      throw new Error(
        `Load More stopped progressing at ${afterCounts.loaded} of ${afterCounts.total}.`
      );
    }
  }
}

async function sendCurrentRequest(page, radius) {
  const sendButton =
    page.locator("button.save-btn");

  await sendButton.waitFor({
    state: "visible",
    timeout: 30000
  });

  const counts = await getLoadedCounts(page);

  if (counts) {
    console.log(
      `Ready to send: ${counts.loaded} of ${counts.total} fieldworkers loaded.`
    );
  }

  console.log(
    `Clicking Send for ${radius}-mile round...`
  );

  await sendButton.click();

  const sentAt =
    new Date().toISOString();

  console.log(
    `${radius}-mile request sent at ${sentAt}`
  );

  await fetch(MAKE_WEBHOOK, {
    method: "POST",
    headers: {
      "Content-Type":
        "application/json"
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

  const modalHeading =
    page.getByRole("heading", {
      name: /send job request/i
    });

  await modalHeading
    .waitFor({
      state: "hidden",
      timeout: 10000
    })
    .catch(async () => {
      const closeButton =
        page.getByRole("button", {
          name: /^close$/i
        });

      if (
        await closeButton
          .isVisible()
          .catch(() => false)
      ) {
        await closeButton.click();

        await page.waitForTimeout(1000);
      }
    });
}

async function run() {
  const browser =
    await chromium.launch({
      headless: false
    });

  const page =
    await browser.newPage();

  console.log(
    "Opening Octopus booking..."
  );

  await page.goto(BOOKING_URL, {
    waitUntil: "domcontentloaded",
    timeout: 60000
  });

  console.log(
    "Waiting for Available Fieldworkers..."
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

  await page
    .getByText(
      /\d+\s+of\s+\d+\s+available/i
    )
    .waitFor({
      state: "visible",
      timeout: 60000
    });

  for (const radius of RADII) {
    console.log("");
    console.log(
      `========== ${radius} MILE ROUND ==========`
    );

    // 1. Change radius
    await setRadius(
      page,
      radius
    );

    // 2. Wait for Octopus availability to refresh
    await page
      .getByText(
        /\d+\s+of\s+\d+\s+available/i
      )
      .waitFor({
        state: "visible",
        timeout: 60000
      });

    // 3. OPEN popup first
    await openSendJobRequest(
      page,
      radius
    );

    // 4. Load ALL pages inside popup
    await clickLoadMoreUntilDone(
      page
    );

    // 5. Send only after everything is loaded
    await sendCurrentRequest(
      page,
      radius
    );

    console.log(
      `Finished ${radius}-mile round.`
    );

    await page.waitForTimeout(2000);
  }

  console.log("");
  console.log(
    "All requested radius rounds completed."
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
