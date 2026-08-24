import { chromium } from "playwright";

const OCTOPUS_EMAIL = process.env.OCTOPUS_EMAIL;
const OCTOPUS_PASSWORD = process.env.OCTOPUS_PASSWORD;
const ORGANIZATION_NAME = process.env.OCTOPUS_ORGANIZATION_NAME || "SpeedyCleans";

if (!OCTOPUS_EMAIL) throw new Error("Missing OCTOPUS_EMAIL");
if (!OCTOPUS_PASSWORD) throw new Error("Missing OCTOPUS_PASSWORD");

async function selectOrganization(page) {
  await page.waitForTimeout(2000);
  const selects = page.locator("select");
  for (let i = 0; i < await selects.count(); i++) {
    const s = selects.nth(i);
    const options = await s.locator("option").allTextContents();
    const match = options.find(x => x.toLowerCase().includes(ORGANIZATION_NAME.toLowerCase()));
    if (match) {
      await s.selectOption({ label: match.trim() });
      const submit = page.locator('button[type="submit"], input[type="submit"]').first();
      if (await submit.isVisible().catch(() => false)) await submit.click();
      else await page.keyboard.press("Enter");
      await page.waitForTimeout(4000);
      return;
    }
  }

  const org = page.getByText(ORGANIZATION_NAME, { exact: false }).first();

  if (await org.isVisible().catch(() => false)) {
    await org.click();

    const submit = page.locator('button[type="submit"], input[type="submit"]').first();

    if (await submit.isVisible().catch(() => false)) await submit.click();
    else await page.keyboard.press("Enter");

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

  const email = page.locator(
    'input[type="email"], input[name="email"], input[name="username"], #email'
  ).first();

  const password = page.locator(
    'input[type="password"], input[name="password"], #password'
  ).first();

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

async function openNewBooking(page) {
  await page.goto("https://admin.octopuspro.com/bookings", {
    waitUntil: "domcontentloaded",
    timeout: 60000
  });

  await page.waitForTimeout(5000);

  if (page.url().toLowerCase().includes("/login")) {
    await login(page);

    await page.goto("https://admin.octopuspro.com/bookings", {
      waitUntil: "domcontentloaded",
      timeout: 60000
    });

    await page.waitForTimeout(5000);
  }

  const candidates = [
    page.getByText("New Booking", { exact: true }).first(),
    page.getByText("Create New", { exact: true }).first(),
    page.getByRole("button", { name: /new booking|create new/i }).first(),
    page.getByRole("link", { name: /new booking|create new/i }).first()
  ];

  let clicked = false;

  for (const c of candidates) {
    if (await c.isVisible().catch(() => false)) {
      console.log("Clicking New Booking control...");
      await c.click();
      clicked = true;
      break;
    }
  }

  if (!clicked) {
    console.log("Opening New Booking directly...");
    await page.goto("https://admin.octopuspro.com/booking/add", {
      waitUntil: "domcontentloaded",
      timeout: 60000
    });
  }

  await page.waitForTimeout(5000);
}

async function inspect(page) {
  const data = await page.evaluate(() => {
    const visible = el => {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);

      return (
        s.display !== "none" &&
        s.visibility !== "hidden" &&
        r.width > 0 &&
        r.height > 0
      );
    };

    const fields = Array.from(
      document.querySelectorAll("input, select, textarea")
    )
      .map(el => ({
        tag: el.tagName,
        type: el.getAttribute("type") || "",
        name: el.getAttribute("name") || "",
        id: el.id || "",
        value: el.value || "",
        placeholder: el.getAttribute("placeholder") || "",
        aria: el.getAttribute("aria-label") || "",
        visible: visible(el)
      }))
      .filter(
        x =>
          x.visible ||
          /customer|address|street|suburb|city|state|post|zip|service|date|time|source|fieldworker|contractor|booking/i.test(
            `${x.name} ${x.id} ${x.placeholder} ${x.aria}`
          )
      );

    const buttons = Array.from(
      document.querySelectorAll(
        "button, a, input[type=submit], input[type=button]"
      )
    )
      .map(el => ({
        tag: el.tagName,
        id: el.id || "",
        text: String(
          el.innerText || el.textContent || el.value || ""
        )
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 200),
        href: el.href || "",
        visible: visible(el)
      }))
      .filter(
        x =>
          x.visible &&
          /save|customer|service|address|schedule|booking|fieldworker|source|add/i.test(
            x.text
          )
      );

    const text = (document.body?.innerText || "")
      .split("\n")
      .map(x => x.trim())
      .filter(Boolean);

    const relevantText = text
      .filter(x =>
        /customer|address|location|service|appointment|schedule|fieldworker|source|save booking|new booking/i.test(
          x
        )
      )
      .slice(0, 200);

    return {
      url: location.href,
      title: document.title,
      fields,
      buttons,
      relevantText
    };
  });

  console.log("");
  console.log("===== NEW BOOKING PAGE INSPECTION =====");
  console.log(JSON.stringify(data, null, 2));
  console.log("===== END NEW BOOKING PAGE INSPECTION =====");
  console.log("");
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

    await login(page);
    await openNewBooking(page);
    await inspect(page);
  } finally {
    await browser.close();
  }
}

main().catch(err => {
  console.error(err);
  process.exitCode = 1;
});

