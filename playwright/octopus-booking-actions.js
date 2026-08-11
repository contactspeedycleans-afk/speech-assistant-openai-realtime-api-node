import { chromium } from "playwright";

const OCTOPUS_EMAIL = process.env.OCTOPUS_EMAIL;
const OCTOPUS_PASSWORD = process.env.OCTOPUS_PASSWORD;
const ORGANIZATION_NAME =
  process.env.OCTOPUS_ORGANIZATION_NAME || "SpeedyCleans";

const bookingId =
  process.argv[2] ||
  process.env.OCTOPUS_BOOKING_TEST_ID ||
  "562455";

if (!OCTOPUS_EMAIL) {
  throw new Error("Missing OCTOPUS_EMAIL");
}

if (!OCTOPUS_PASSWORD) {
  throw new Error("Missing OCTOPUS_PASSWORD");
}

async function selectOrganization(page) {
  console.log(`Looking for organization: ${ORGANIZATION_NAME}`);

  await page.waitForTimeout(2000);

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
      await select.selectOption({ label: match.trim() });

      const submitButton = page
        .locator('button[type="submit"], input[type="submit"]')
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
    .getByText(ORGANIZATION_NAME, { exact: false })
    .first();

  if (await organizationText.isVisible().catch(() => false)) {
    await organizationText.click();

    const submitButton = page
      .locator('button[type="submit"], input[type="submit"]')
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
    `Could not select organization: ${ORGANIZATION_NAME}`
  );
}

async function loginToOctopus(page) {
  console.log("Opening OctopusPro login...");

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

  await emailInput.fill(OCTOPUS_EMAIL);
  await passwordInput.fill(OCTOPUS_PASSWORD);

  await page
    .locator('button[type="submit"], input[type="submit"]')
    .first()
    .click();

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

async function openBooking(page) {
  const bookingUrl =
    `https://admin.octopuspro.com/booking/view/${bookingId}`;

  console.log(`Opening booking ${bookingId}...`);

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

  console.log(`Current page: ${page.url()}`);
}

async function inspectBookingPage(page) {
  console.log("\n===== DRY-RUN BOOKING INSPECTION =====");
  console.log("No buttons will be clicked.");
  console.log("No booking changes will be saved.\n");

  const pageTitle = await page.title();
  console.log(`Page title: ${pageTitle}`);

  const bodyText = await page.locator("body").innerText();

  const statusNames = [
    "CANCELLED",
    "TO DO",
    "COMPLETED",
    "FAILED",
    "ON HOLD",
    "TENTATIVE"
  ];

  const statusesFound = statusNames.filter((status) =>
    bodyText.toUpperCase().includes(status)
  );

  console.log(
    `Possible statuses found: ${
      statusesFound.join(", ") || "None"
    }`
  );

  const controls = await page
    .locator(
      'button, a, select, [role="button"], input[type="submit"]'
    )
    .evaluateAll((elements) =>
      elements
        .filter((element) => {
          const style = window.getComputedStyle(element);
          const rect = element.getBoundingClientRect();

          return (
            style.display !== "none" &&
            style.visibility !== "hidden" &&
            rect.width > 0 &&
            rect.height > 0
          );
        })
        .map((element, index) => ({
          index,
          tag: element.tagName,
          text: String(
            element.innerText ||
            element.value ||
            element.getAttribute("aria-label") ||
            element.getAttribute("title") ||
            ""
          )
            .replace(/\s+/g, " ")
            .trim(),
          href: element.getAttribute("href") || "",
          id: element.id || "",
          name: element.getAttribute("name") || "",
          className:
            typeof element.className === "string"
              ? element.className
              : ""
        }))
        .filter((control) => {
          const searchable = [
            control.text,
            control.href,
            control.id,
            control.name,
            control.className
          ]
            .join(" ")
            .toLowerCase();

          return /edit|status|cancel|resched|schedule|save|booking|action/.test(
            searchable
          );
        })
        .slice(0, 100)
    );

  console.log("\nRelevant visible controls:");

  if (controls.length === 0) {
    console.log("No matching controls were found.");
  } else {
    controls.forEach((control) => {
      console.log(JSON.stringify(control));
    });
  }

  const selects = await page.locator("select").evaluateAll((elements) =>
    elements.map((element, index) => ({
      index,
      id: element.id || "",
      name: element.getAttribute("name") || "",
      value: element.value || "",
      options: Array.from(element.options).map((option) => ({
        text: option.text.trim(),
        value: option.value
      }))
    }))
  );

  console.log("\nSelect menus found:");
  console.log(JSON.stringify(selects, null, 2));

  await page.screenshot({
    path: "/tmp/octopus-booking-inspection.png",
    fullPage: true
  });

  console.log(
    "\nInspection screenshot saved to /tmp/octopus-booking-inspection.png"
  );

  console.log("\n===== INSPECTION COMPLETE =====");
}

async function main() {
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"]
  });

  try {
    const context = await browser.newContext({
      viewport: {
        width: 1600,
        height: 1000
      }
    });

    const page = await context.newPage();

    await openBooking(page);
    await inspectBookingPage(page);
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error("Octopus booking inspection failed:");
  console.error(error);
  process.exit(1);
});
