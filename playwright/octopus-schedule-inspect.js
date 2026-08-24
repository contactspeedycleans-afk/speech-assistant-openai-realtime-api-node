import { chromium } from "playwright";

const OCTOPUS_EMAIL = process.env.OCTOPUS_EMAIL;
const OCTOPUS_PASSWORD = process.env.OCTOPUS_PASSWORD;
const ORGANIZATION_NAME =
  process.env.OCTOPUS_ORGANIZATION_NAME || "SpeedyCleans";

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

async function openService(page) {
  const servicesDropdown = page.locator("#servicesdropdown").first();

  await servicesDropdown.waitFor({
    state: "visible",
    timeout: 15000
  });

  await servicesDropdown.scrollIntoViewIfNeeded();

  await servicesDropdown.evaluate(element => {
    element.dispatchEvent(
      new MouseEvent("mousedown", {
        bubbles: true,
        cancelable: true,
        view: window
      })
    );

    element.dispatchEvent(
      new MouseEvent("click", {
        bubbles: true,
        cancelable: true,
        view: window
      })
    );
  });

  await page.waitForTimeout(2000);

  const cleanAsDirected = page.locator("#servicesdropdown_6");

  await cleanAsDirected.waitFor({
    state: "visible",
    timeout: 10000
  });

  console.log(
    "Selecting:",
    (await cleanAsDirected.innerText()).replace(/\s+/g, " ").trim()
  );

  await cleanAsDirected.click({
    force: true,
    timeout: 5000
  });

  await page.waitForTimeout(3000);
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
        height: 1200
      }
    });

    const page = await context.newPage();

    await login(page);

    console.log("Opening New Booking...");

    await page.goto("https://admin.octopuspro.com/booking/add", {
      waitUntil: "domcontentloaded",
      timeout: 60000
    });

    await page.waitForTimeout(5000);

    await openService(page);

    console.log("Inspecting appointment/date/time controls...");

    const data = await page.evaluate(() => {
      const visible = element => {
        const rect = element.getBoundingClientRect();
        const style = window.getComputedStyle(element);

        return (
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          rect.width > 0 &&
          rect.height > 0
        );
      };

      const elements = Array.from(
        document.querySelectorAll(
          'input, select, textarea, button, div, span, label'
        )
      );

      const controls = elements
        .map((element, index) => ({
          index,
          tag: element.tagName,
          type: element.getAttribute("type") || "",
          name: element.getAttribute("name") || "",
          id: element.id || "",
          value:
            "value" in element
              ? String(element.value || "")
              : "",
          placeholder:
            element.getAttribute("placeholder") || "",
          ariaLabel:
            element.getAttribute("aria-label") || "",
          text: String(
            element.innerText ||
            element.textContent ||
            ""
          )
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, 400),
          className: String(
            element.className || ""
          ).slice(0, 300),
          visible: visible(element)
        }))
        .filter(item =>
          /appointment|schedule|scheduled|date|time|from|to|start|end|fieldworker|contractor|duration/i.test(
            [
              item.name,
              item.id,
              item.placeholder,
              item.ariaLabel,
              item.text,
              item.className
            ].join(" ")
          )
        )
        .slice(0, 500);

      return {
        url: location.href,
        controls
      };
    });

    console.log("");
    console.log("===== SCHEDULE INSPECTION =====");
    console.log(JSON.stringify(data, null, 2));
    console.log("===== END SCHEDULE INSPECTION =====");
    console.log("");

  } finally {
    await browser.close();
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});