import { chromium } from "playwright";

const BOOKING_URL =
  "https://admin.octopuspro.com/booking/view/563418";

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
    { exact: true }
  );

  await availableFieldworkers.waitFor({
    state: "visible",
    timeout: 60000
  });

  await availableFieldworkers.scrollIntoViewIfNeeded();

  console.log("Waiting for availability results...");

  await page
    .getByText(/\d+\s+of\s+\d+\s+available/i)
    .waitFor({
      state: "visible",
      timeout: 60000
    });

  console.log("Opening Send Job Request window...");

  await page
    .getByRole("button", {
      name: /send job request/i
    })
    .click();

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
  timeout: 30000,
});

console.log("Clicking Send...");

await sendButton.click();

console.log("Job request sent successfully.");

await page.waitForTimeout(3000);

await browser.close();
}
  
run().catch((error) => {
  console.error("Dry run failed:", error);
  process.exit(1);
});
