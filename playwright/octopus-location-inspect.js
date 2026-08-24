import { chromium } from "playwright";

const OCTOPUS_EMAIL = process.env.OCTOPUS_EMAIL;
const OCTOPUS_PASSWORD = process.env.OCTOPUS_PASSWORD;
const ORGANIZATION_NAME =
  process.env.OCTOPUS_ORGANIZATION_NAME || "SpeedyCleans";

const TEST_ADDRESS = "123 Grand River Avenue, Howell, MI 48843";

if (!OCTOPUS_EMAIL) throw new Error("Missing OCTOPUS_EMAIL");
if (!OCTOPUS_PASSWORD) throw new Error("Missing OCTOPUS_PASSWORD");

async function selectOrganization(page) {
  await page.waitForTimeout(2000);

  const selects = page.locator("select");

  for (let i = 0; i < await selects.count(); i++) {
    const select = selects.nth(i);
    const options = await select.locator("option").allTextContents();

    const match = options.find(option =>
      option.toLowerCase().includes(ORGANIZATION_NAME.toLowerCase())
    );

    if (match) {
      await select.selectOption({ label: match.trim() });

      const submit = page
        .locator('button[type="submit"], input[type="submit"]')
        .first();

      if (await submit.isVisible().catch(() => false)) {
        await submit.click();
      } else {
        await page.keyboard.press("Enter");
      }

      await page.waitForTimeout(4000);
      return;
    }
  }

  const organization = page
    .getByText(ORGANIZATION_NAME, { exact: false })
    .first();

  if (await organization.isVisible().catch(() => false)) {
    await organization.click();

    const submit = page
      .locator('button[type="submit"], input[type="submit"]')
      .first();

    if (await submit.isVisible().catch(() => false)) {
      await submit.click();
    } else {
      await page.keyboard.press("Enter");
    }

    await page.waitForTimeout(4000);
    return;
  }

  throw new Error(`Could not select organization ${ORGANIZATION_NAME}`);
}

async function login(page) {
  console.log("Logging into OctopusPro...");

  await page.goto("https://admin.octopuspro.com/login", {
    waitUntil: "domcontentloaded",
    timeout: 60000
  });

  const email = page
    .locator(
      'input[type="email"], input[name="email"], input[name="username"], #email'
    )
    .first();

  const password = page
    .locator('input[type="password"], input[name="password"], #password')
    .first();

  await email.waitFor({ state: "visible", timeout: 30000 });

  await email.fill(OCTOPUS_EMAIL);
  await password.fill(OCTOPUS_PASSWORD);

  await page
    .locator('button[type="submit"], input[type="submit"]')
    .first()
    .click();

  await page.waitForTimeout(5000);

  if (page.url().toLowerCase().includes("/checkuserinmulticompanies")) {
    await selectOrganization(page);
  }

  if (page.url().toLowerCase().includes("/login")) {
    throw new Error("OctopusPro login did not complete");
  }
}

async function inspectLocation(page, label) {
  const data = await page.evaluate(() => {
    const visible = el => {
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return (
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        rect.width > 0 &&
        rect.height > 0
      );
    };

    const selectors = [
      "input",
      "select",
      "option",
      "li",
      '[role="option"]',
      '[role="listbox"]',
      ".pac-container",
      ".pac-item",
      ".vs__dropdown-menu",
      ".vs__dropdown-option",
      "#autocomplete_mobile_input",
      "#IndicatorInTheLocationComponent"
    ];

    const candidates = Array.from(
      document.querySelectorAll(selectors.join(","))
    )
      .map((el, index) => ({
        index,
        tag: el.tagName,
        type: el.getAttribute("type") || "",
        name: el.getAttribute("name") || "",
        id: el.id || "",
        role: el.getAttribute("role") || "",
        value: "value" in el ? String(el.value || "") : "",
        placeholder: el.getAttribute("placeholder") || "",
        ariaLabel: el.getAttribute("aria-label") || "",
        text: String(el.innerText || el.textContent || "")
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 400),
        className: String(el.className || "").slice(0, 250),
        visible: visible(el)
      }))
      .filter(x =>
        x.visible ||
        /location|address|grand river|howell|street|suburb|postcode|state|zip/i.test(
          [
            x.name,
            x.id,
            x.value,
            x.placeholder,
            x.ariaLabel,
            x.text,
            x.className
          ].join(" ")
        )
      )
      .slice(0, 400);

    const hiddenValues = Array.from(
      document.querySelectorAll('input[type="hidden"]')
    )
      .map(el => ({
        name: el.name || "",
        id: el.id || "",
        value: el.value || ""
      }))
      .filter(x =>
        /address|street|suburb|state|post|zip|lat|lng|long|location|business|time_zone/i.test(
          `${x.name} ${x.id}`
        )
      );

    return {
      url: location.href,
      candidates,
      hiddenValues
    };
  });

  console.log("");
  console.log(`===== LOCATION INSPECTION ${label} =====`);
  console.log(JSON.stringify(data, null, 2));
  console.log(`===== END LOCATION INSPECTION ${label} =====`);
  console.log("");
}

async function main() {
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"]
  });

  try {
    const context = await browser.newContext({
      viewport: { width: 1600, height: 1000 }
    });

    const page = await context.newPage();

    await login(page);

    console.log("Opening New Booking...");
    await page.goto("https://admin.octopuspro.com/booking/add", {
      waitUntil: "domcontentloaded",
      timeout: 60000
    });

    await page.waitForTimeout(5000);

    const addressInput = page
      .locator('input[placeholder="Booking address"]')
      .first();

    await addressInput.waitFor({
      state: "visible",
      timeout: 15000
    });

    console.log("Typing test address...");
    await addressInput.click();
    await addressInput.fill(TEST_ADDRESS);

    await page.waitForTimeout(3500);

    await inspectLocation(page, "AFTER TYPING");

    console.log("Clicking exact Octopus address result...");

    const exactAddressResult = page
      .getByText(
        "123 Grand River Avenue, Howell, MI 48843, United States",
        { exact: true }
      )
      .last();

    await exactAddressResult.waitFor({
      state: "visible",
      timeout: 10000
    });

    console.log(
      "Found address result:",
      (await exactAddressResult.innerText()).replace(/\s+/g, " ").trim()
    );

    await exactAddressResult.click({
      force: true,
      timeout: 5000
    });

    await page.waitForTimeout(3000);

    await inspectLocation(page, "AFTER EXACT CLICK");

    console.log("NO BOOKING WAS SAVED.");
  } finally {
    await browser.close();
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});