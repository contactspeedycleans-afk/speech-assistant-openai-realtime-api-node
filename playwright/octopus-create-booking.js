import { chromium } from "playwright";

const OCTOPUS_EMAIL = process.env.OCTOPUS_EMAIL;
const OCTOPUS_PASSWORD = process.env.OCTOPUS_PASSWORD;
const ORGANIZATION_NAME =
  process.env.OCTOPUS_ORGANIZATION_NAME || "SpeedyCleans";

const livePayload = process.env.LISA_BOOKING_PAYLOAD
  ? JSON.parse(process.env.LISA_BOOKING_PAYLOAD)
  : null;

const TEST = livePayload
  ? {
      customerName:
        livePayload.customerName ||
        `${livePayload.customerFirstName || ""} ${livePayload.customerLastName || ""}`.trim(),
      customerFirstName: String(
        livePayload.customerFirstName ||
        livePayload.firstName ||
        String(livePayload.customerName || "").trim().split(/\s+/)[0] ||
        ""
      ),
      customerLastName: String(
        livePayload.customerLastName ||
        livePayload.lastName ||
        String(livePayload.customerName || "").trim().split(/\s+/).slice(1).join(" ") ||
        ""
      ),
      customerPhone: String(
        livePayload.customerPhone ||
        livePayload.phone ||
        ""
      ),
      customerEmail: String(
        livePayload.customerEmail ||
        livePayload.email ||
        ""
      ),
      customerId: String(livePayload.customerId || ""),
      streetNumber: String(livePayload.streetNumber || ""),
      streetAddress: String(livePayload.street || livePayload.streetAddress || ""),
      suburb: String(livePayload.city || livePayload.suburb || ""),
      state: String(livePayload.state || ""),
      postcode: String(livePayload.zip || livePayload.postcode || ""),
      serviceName: livePayload.serviceName || "Standard Cleaning",
      bookingDate: livePayload.requestedDate || livePayload.bookingDate,
      startTime: livePayload.requestedStartTime || livePayload.startTime,
      durationHours: Number(
        livePayload.durationHours ||
        (Number(livePayload.durationMinutes || 120) / 60)
      ),
      price: String(livePayload.quotedPrice || livePayload.price || "150"),
      fieldworkerName: livePayload.fieldworkerName || "Unassigned Tasks Manager",
      specialNotes: livePayload.specialNotes || ".",
      accessInstructions: livePayload.accessInstructions || "."
    }
  : {
      customerName: "Gina Manciolini",
      customerFirstName: "Gina",
      customerLastName: "Manciolini",
      customerPhone: "",
      customerEmail: "",
      customerId: "1570670",
      streetNumber: "123",
      streetAddress: "Grand River Avenue",
      suburb: "Howell",
      state: "MI",
      postcode: "48843",
      serviceName: "Standard Cleaning",
      bookingDate: "2026-08-25",
      startTime: "10:00",
      durationHours: 2,
      price: "82.50",
      fieldworkerName: "Unassigned Tasks Manager",
      specialNotes: ".",
      accessInstructions: "."
    };

let FINAL_BOOKING_RESULT = null;

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

async function setValue(page, selector, value) {
  const locator = page.locator(selector).first();

  if ((await locator.count()) === 0) {
    console.log(`Missing field: ${selector}`);
    return false;
  }

  await locator.evaluate(
    (element, nextValue) => {
      const setter =
        Object.getOwnPropertyDescriptor(
          Object.getPrototypeOf(element),
          "value"
        )?.set;

      if (setter) {
        setter.call(element, nextValue);
      } else {
        element.value = nextValue;
      }

      element.dispatchEvent(new Event("input", { bubbles: true }));
      element.dispatchEvent(new Event("change", { bubbles: true }));
    },
    value
  );

  return true;
}


async function fillFirstVisible(page, selectors, value) {
  const clean = String(value || "").trim();
  if (!clean) return false;

  for (const selector of selectors) {
    const loc = page.locator(selector).filter({ visible: true }).first();
    if ((await loc.count().catch(() => 0)) < 1) continue;
    if (!(await loc.isVisible().catch(() => false))) continue;

    try {
      await loc.scrollIntoViewIfNeeded().catch(() => {});
      await loc.click({ force: true }).catch(() => {});
      await loc.fill(clean);
      await loc.dispatchEvent("input").catch(() => {});
      await loc.dispatchEvent("change").catch(() => {});
      await loc.dispatchEvent("blur").catch(() => {});
      return true;
    } catch {}
  }

  return false;
}

async function createNewCustomerInOctopus(page) {
  console.log("Existing customer not found. Starting NEW CUSTOMER creation...");

  const firstName = String(TEST.customerFirstName || "").trim();
  const lastName = String(TEST.customerLastName || "").trim();
  const fullName = String(TEST.customerName || `${firstName} ${lastName}`).trim();
  const phone = String(TEST.customerPhone || "").trim();
  const email = String(TEST.customerEmail || "").trim();

  if (!firstName) {
    throw new Error("NEW_CUSTOMER_FIRST_NAME_MISSING");
  }
  if (!phone) {
    throw new Error("NEW_CUSTOMER_PHONE_MISSING");
  }

  // First try the customer selector's own "create/add customer" action.
  const createPatterns = [
    /create new customer/i,
    /add new customer/i,
    /new customer/i,
    /add customer/i,
    /create customer/i
  ];

  let createClicked = false;

  for (const pattern of createPatterns) {
    const candidates = page
      .getByText(pattern)
      .filter({ visible: true });

    const count = await candidates.count().catch(() => 0);
    if (count > 0) {
      const candidate = candidates.last();
      console.log(
        "Clicking new-customer UI:",
        (await candidate.innerText().catch(() => String(pattern)))
          .replace(/\s+/g, " ")
          .trim()
      );
      await candidate.click({ force: true, timeout: 10000 });
      createClicked = true;
      break;
    }
  }

  // Some Octopus builds expose the add action only after typing a value.
  if (!createClicked) {
    const customerSearch = page.locator(
      'input[placeholder="Find customer"]'
    ).first();

    await customerSearch.click({ force: true }).catch(() => {});
    await customerSearch.fill("").catch(() => {});
    await customerSearch.type(fullName || firstName, { delay: 35 }).catch(() => {});
    await page.waitForTimeout(1200);

    for (const pattern of createPatterns) {
      const candidates = page
        .getByText(pattern)
        .filter({ visible: true });

      if ((await candidates.count().catch(() => 0)) > 0) {
        const candidate = candidates.last();
        console.log(
          "Clicking new-customer UI after search:",
          (await candidate.innerText().catch(() => String(pattern)))
            .replace(/\s+/g, " ")
            .trim()
        );
        await candidate.click({ force: true, timeout: 10000 });
        createClicked = true;
        break;
      }
    }
  }

  if (!createClicked) {
    // Last-resort generic visible button/link scan.
    const generic = page.locator('button:visible, a:visible, [role="button"]:visible');
    const count = await generic.count().catch(() => 0);

    for (let i = 0; i < count; i++) {
      const el = generic.nth(i);
      const text = (await el.innerText().catch(() => ""))
        .replace(/\s+/g, " ")
        .trim();

      if (/^(create|add|new).{0,25}customer$/i.test(text)) {
        console.log("Clicking generic new-customer control:", text);
        await el.click({ force: true, timeout: 10000 });
        createClicked = true;
        break;
      }
    }
  }

  if (!createClicked) {
    throw new Error("NEW_CUSTOMER_CREATE_CONTROL_NOT_FOUND");
  }

  await page.waitForTimeout(1500);

  // Fill the visible customer form using broad selectors so this survives
  // Octopus UI naming differences.
  const firstOk = await fillFirstVisible(page, [
    'input[name="first_name"]',
    'input[name="firstname"]',
    'input[name="firstName"]',
    'input[id*="first_name" i]',
    'input[id*="firstname" i]',
    'input[placeholder*="First name" i]',
    'input[placeholder*="First Name" i]'
  ], firstName);

  const lastOk = await fillFirstVisible(page, [
    'input[name="last_name"]',
    'input[name="lastname"]',
    'input[name="lastName"]',
    'input[id*="last_name" i]',
    'input[id*="lastname" i]',
    'input[placeholder*="Last name" i]',
    'input[placeholder*="Last Name" i]'
  ], lastName);

  const phoneOk = await fillFirstVisible(page, [
    'input[name="phone"]',
    'input[name="mobile"]',
    'input[name="mobile_phone"]',
    'input[name="phone_number"]',
    'input[type="tel"]',
    'input[id*="phone" i]',
    'input[id*="mobile" i]',
    'input[placeholder*="Phone" i]',
    'input[placeholder*="Mobile" i]'
  ], phone);

  const emailOk = email
    ? await fillFirstVisible(page, [
        'input[name="email"]',
        'input[type="email"]',
        'input[id*="email" i]',
        'input[placeholder*="Email" i]'
      ], email)
    : true;

  console.log(
    "New customer form fields:",
    JSON.stringify({
      firstName: firstOk,
      lastName: lastOk,
      phone: phoneOk,
      email: emailOk
    })
  );

  if (!firstOk || !phoneOk) {
    const visibleInputs = await page.locator('input:visible').evaluateAll(inputs =>
      inputs.map(input => ({
        name: input.getAttribute("name") || "",
        id: input.id || "",
        type: input.getAttribute("type") || "",
        placeholder: input.getAttribute("placeholder") || "",
        value: input.value || ""
      }))
    ).catch(() => []);

    throw new Error(
      `NEW_CUSTOMER_REQUIRED_FIELDS_NOT_FOUND: ${JSON.stringify(visibleInputs)}`
    );
  }

  // Find the save/create/confirm action inside whichever visible dialog/form opened.
  const visibleDialogs = page.locator(
    '[role="dialog"]:visible, .modal:visible, .modal-dialog:visible'
  );

  let scope = page;
  if ((await visibleDialogs.count().catch(() => 0)) > 0) {
    scope = visibleDialogs.last();
  }

  const saveNames = [
    /^save$/i,
    /^create$/i,
    /^add$/i,
    /^confirm$/i,
    /save customer/i,
    /create customer/i,
    /add customer/i
  ];

  let saveClicked = false;

  for (const name of saveNames) {
    const button = scope
      .getByRole("button", { name })
      .filter({ visible: true })
      .last();

    if ((await button.count().catch(() => 0)) > 0 &&
        await button.isVisible().catch(() => false)) {
      console.log(
        "Saving new customer with:",
        (await button.innerText().catch(() => String(name)))
          .replace(/\s+/g, " ")
          .trim()
      );
      await button.click({ force: true, timeout: 10000 });
      saveClicked = true;
      break;
    }
  }

  if (!saveClicked) {
    const fallbackSave = scope
      .locator(
        'button[type="submit"]:visible, input[type="submit"]:visible, .save-btn:visible'
      )
      .last();

    if ((await fallbackSave.count().catch(() => 0)) > 0) {
      console.log("Saving new customer with generic submit/save control...");
      await fallbackSave.click({ force: true, timeout: 10000 });
      saveClicked = true;
    }
  }

  if (!saveClicked) {
    throw new Error("NEW_CUSTOMER_SAVE_CONTROL_NOT_FOUND");
  }

  // Wait for Octopus to close the customer form and commit the selected customer.
  await page.waitForTimeout(2200);

  for (let attempt = 1; attempt <= 10; attempt++) {
    const state = await page.evaluate((customerName) => {
      const customerId =
        document.querySelector('input[name="customer_id"]')?.value || "";
      const customers =
        document.querySelector('input[name="customers"]')?.value || "";
      const bodyText = document.body?.innerText || "";

      return {
        customer_id: customerId,
        customers,
        bodyHasCustomer: customerName
          ? bodyText.toLowerCase().includes(customerName.toLowerCase())
          : false
      };
    }, fullName);

    if (state.customer_id && state.customers) {
      console.log(
        "NEW CUSTOMER CREATED AND COMMITTED:",
        JSON.stringify({
          customer_id: state.customer_id,
          customersLength: state.customers.length,
          bodyHasCustomer: state.bodyHasCustomer
        })
      );
      return state;
    }

    await page.waitForTimeout(700);
  }

  const finalState = await page.evaluate(() => ({
    customer_id:
      document.querySelector('input[name="customer_id"]')?.value || "",
    customers:
      document.querySelector('input[name="customers"]')?.value || "",
    url: location.href,
    text: (document.body?.innerText || "").slice(0, 4000)
  }));

  throw new Error(
    `NEW_CUSTOMER_NOT_COMMITTED_AFTER_SAVE: ${JSON.stringify(finalState)}`
  );
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

    console.log("Opening real New Booking form...");

    await page.goto("https://admin.octopuspro.com/booking/add", {
      waitUntil: "domcontentloaded",
      timeout: 60000
    });

    await page.waitForTimeout(5000);

    console.log("Filling customer through the visible Octopus selector...");

    const customerSearch = page.locator(
      'input[placeholder="Find customer"]'
    ).first();

    await customerSearch.waitFor({
      state: "visible",
      timeout: 20000
    });

    let customerSelected = false;

    // Lisa live bookings may refer to an existing Octopus customer whose displayed
    // name is not an exact text match. Search several identifiers and select a
    // visible result that contains the customer's name/phone/email.
    const customerLookupTerms = [
      livePayload?.customerPhone,
      livePayload?.phone,
      livePayload?.customerEmail,
      livePayload?.email,
      TEST.customerName
    ]
      .map(value => String(value || "").trim())
      .filter((value, index, arr) => value && arr.indexOf(value) === index);

    for (const lookupTerm of customerLookupTerms) {
      if (customerSelected) break;

      console.log(`Customer lookup using: ${lookupTerm}`);

      for (let attempt = 1; attempt <= 3; attempt++) {
        await customerSearch.click({ force: true }).catch(() => {});
        await customerSearch.fill("").catch(() => {});
        await customerSearch.type(lookupTerm, { delay: 35 }).catch(() => {});
        await page.waitForTimeout(1400 + attempt * 500);

        const candidates = page.locator(
          '[role="option"]:visible, .vs__dropdown-option:visible, li:visible'
        );

        const candidateCount = await candidates.count().catch(() => 0);

        for (let i = 0; i < candidateCount; i++) {
          const candidate = candidates.nth(i);
          const text = (await candidate.innerText().catch(() => ""))
            .replace(/\s+/g, " ")
            .trim();

          if (!text) continue;

          const normalized = text.toLowerCase();
          const name = String(TEST.customerName || "").toLowerCase();
          const phone = String(
            livePayload?.customerPhone || livePayload?.phone || ""
          ).replace(/\D/g, "");
          const email = String(
            livePayload?.customerEmail || livePayload?.email || ""
          ).toLowerCase();
          const candidateDigits = text.replace(/\D/g, "");

          const matchesName = name && normalized.includes(name);
          const matchesEmail = email && normalized.includes(email);
          const matchesPhone =
            phone &&
            candidateDigits &&
            (candidateDigits.includes(phone) || phone.includes(candidateDigits));

          if (matchesName || matchesEmail || matchesPhone) {
            console.log("Selecting customer option:", text);
            await candidate.click({ force: true, timeout: 10000 });
            customerSelected = true;
            break;
          }
        }

        if (customerSelected) break;

        // Some Octopus customer selectors return one filtered result whose text
        // formatting differs from our payload. If exactly one plausible dropdown
        // option remains, select it.
        const visiblePlausible = [];
        for (let i = 0; i < candidateCount; i++) {
          const candidate = candidates.nth(i);
          const text = (await candidate.innerText().catch(() => ""))
            .replace(/\s+/g, " ")
            .trim();
          if (
            text &&
            !/no results|no options|create new|add customer/i.test(text) &&
            text.length < 500
          ) {
            visiblePlausible.push({ candidate, text });
          }
        }

        if (visiblePlausible.length === 1) {
          console.log(
            "Selecting sole filtered customer option:",
            visiblePlausible[0].text
          );
          await visiblePlausible[0].candidate.click({
            force: true,
            timeout: 10000
          });
          customerSelected = true;
          break;
        }

        await customerSearch.fill("").catch(() => {});
        await page.locator("body").click({
          position: { x: 30, y: 30 },
          force: true
        }).catch(() => {});
        await page.waitForTimeout(600);
      }
    }

    if (!customerSelected) {
      console.log(
        `No existing Octopus customer matched phone/email/name for ${TEST.customerName}.`
      );
      console.log("Treating caller as a NEW CUSTOMER instead of rejecting booking.");

      await createNewCustomerInOctopus(page);
      customerSelected = true;
    }

    await page.waitForTimeout(1600);

    const customerState = await page.evaluate((customerName) => {
      const visible = el => {
        if (!el) return false;
        const r = el.getBoundingClientRect();
        const s = getComputedStyle(el);
        return (
          s.display !== "none" &&
          s.visibility !== "hidden" &&
          r.width > 0 &&
          r.height > 0
        );
      };

      const findInput = Array.from(
        document.querySelectorAll('input[placeholder="Find customer"]')
      ).find(visible);

      return {
        customer_id:
          document.querySelector('input[name="customer_id"]')?.value || "",
        customers:
          document.querySelector('input[name="customers"]')?.value || "",
        visibleFindCustomerValue: findInput?.value || "",
        bodyHasCustomer: document.body.innerText.includes(customerName)
      };
    }, TEST.customerName);

    console.log(
      "Customer committed state:",
      JSON.stringify(customerState)
    );

    if (
      !customerState.customer_id ||
      !customerState.customers
    ) {
      throw new Error(
        `CUSTOMER_NOT_COMMITTED: ${JSON.stringify(customerState)}`
      );
    }

    // IMPORTANT: do not overwrite customer_id/customers.
    // Octopus fills these with its full native customer object after the real UI selection.

    console.log("Selecting booking location...");

    const bookingAddress = `${TEST.streetNumber} ${TEST.streetAddress}, ${TEST.suburb}, ${TEST.state} ${TEST.postcode}`;

    const visibleBookingAddress = page
      .locator('input[placeholder="Booking address"]')
      .first();

    await visibleBookingAddress.waitFor({
      state: "visible",
      timeout: 15000
    });

    await visibleBookingAddress.click();
    await visibleBookingAddress.fill(bookingAddress);

    await page.waitForTimeout(3500);

    // Google/Octopus address suggestions frequently expand abbreviations
    // (Ct -> Court, Rd -> Road, St -> Street) or change punctuation. Do NOT
    // require one exact rendered string. Select the best visible suggestion
    // using street number + ZIP + city, with state/street tokens as tie-breakers.
    console.log("Looking for tolerant address autocomplete match...");

    const normalizeAddressText = value =>
      String(value || "")
        .toLowerCase()
        .replace(/\bcourt\b/g, "ct")
        .replace(/\bstreet\b/g, "st")
        .replace(/\broad\b/g, "rd")
        .replace(/\bavenue\b/g, "ave")
        .replace(/\bdrive\b/g, "dr")
        .replace(/\blane\b/g, "ln")
        .replace(/\bboulevard\b/g, "blvd")
        .replace(/\bplace\b/g, "pl")
        .replace(/\bterrace\b/g, "ter")
        .replace(/\bhighway\b/g, "hwy")
        .replace(/[^a-z0-9]+/g, " ")
        .replace(/\s+/g, " ")
        .trim();

    const targetStreet = normalizeAddressText(
      `${TEST.streetNumber} ${TEST.streetAddress}`
    );
    const targetCity = normalizeAddressText(TEST.suburb);
    const targetState = normalizeAddressText(TEST.state);
    const targetZip = String(TEST.postcode || "").replace(/\D/g, "");
    const targetNumber = String(TEST.streetNumber || "").replace(/\D/g, "");

    // Wait briefly for autocomplete options to appear.
    await page.waitForTimeout(1200);

    const addressCandidates = page.locator(
      '[role="option"]:visible, .pac-item:visible, .vs__dropdown-option:visible, li:visible'
    );

    let bestAddressCandidate = null;
    let bestAddressText = "";
    let bestScore = -1;

    const addressCandidateCount = await addressCandidates.count().catch(() => 0);

    for (let i = 0; i < addressCandidateCount; i++) {
      const candidate = addressCandidates.nth(i);
      const rawText = (await candidate.innerText().catch(() => ""))
        .replace(/\s+/g, " ")
        .trim();

      if (!rawText) continue;

      const norm = normalizeAddressText(rawText);
      const digits = rawText.replace(/\D/g, "");

      let score = 0;

      if (targetNumber && digits.includes(targetNumber)) score += 4;
      if (targetZip && digits.includes(targetZip)) score += 5;
      if (targetCity && norm.includes(targetCity)) score += 4;
      if (targetState && norm.includes(targetState)) score += 2;

      const streetTokens = targetStreet
        .split(" ")
        .filter(token => token.length >= 2);

      const matchedStreetTokens = streetTokens.filter(token =>
        norm.includes(token)
      ).length;

      score += matchedStreetTokens;

      if (
        score > bestScore &&
        targetNumber &&
        digits.includes(targetNumber) &&
        targetCity &&
        norm.includes(targetCity)
      ) {
        bestScore = score;
        bestAddressCandidate = candidate;
        bestAddressText = rawText;
      }
    }

    if (!bestAddressCandidate) {
      const visibleAddressTexts = [];
      for (let i = 0; i < Math.min(addressCandidateCount, 50); i++) {
        const txt = (await addressCandidates.nth(i).innerText().catch(() => ""))
          .replace(/\s+/g, " ")
          .trim();
        if (txt && /\d/.test(txt)) visibleAddressTexts.push(txt);
      }

      throw new Error(
        `ADDRESS_AUTOCOMPLETE_NO_MATCH: target=${bookingAddress} options=${JSON.stringify(visibleAddressTexts)}`
      );
    }

    console.log(
      "Found tolerant address result:",
      bestAddressText,
      "score=" + bestScore
    );

    await bestAddressCandidate.click({
      force: true,
      timeout: 10000
    });

    await page.waitForTimeout(3000);

    const selectedLocation = await page.evaluate(() => {
      const bookingAddressInput =
        document.querySelector('input[placeholder="Booking address"]');

      const visible = element => {
        if (!element) return false;
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return (
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          rect.width > 0 &&
          rect.height > 0
        );
      };

      const findVisibleValue = placeholder => {
        const elements = Array.from(
          document.querySelectorAll(`input[placeholder="${placeholder}"]`)
        );
        const match = elements.find(visible);
        return match?.value || null;
      };

      return {
        bookingAddress: bookingAddressInput?.value || null,
        addressLine1: findVisibleValue("Address Line 1"),
        addressLine2: findVisibleValue("Address Line 2"),
        suburb: findVisibleValue("Suburb / Locality"),
        postcode: findVisibleValue("Postal / Zip code"),
        state: findVisibleValue("State"),
        latitude:
          document.querySelector("#lat-test-input")?.value || null,
        longitude:
          document.querySelector("#lng-test-input")?.value || null
      };
    });

    console.log(
      "Selected location:",
      JSON.stringify(selectedLocation)
    );

    if (
      !selectedLocation.bookingAddress ||
      !selectedLocation.addressLine1 ||
      !selectedLocation.suburb ||
      !selectedLocation.postcode ||
      !selectedLocation.state ||
      !selectedLocation.latitude ||
      !selectedLocation.longitude
    ) {
      throw new Error(
        "LOCATION_NOT_SELECTED: Octopus did not fully populate the selected address."
      );
    }

    console.log("Confirming location modal...");

    const locationModal = page.locator("#GLOBAL_ADD_LOCATION_MODAL_ID");

    await locationModal.waitFor({
      state: "visible",
      timeout: 15000
    });

    const confirmLocationButton = locationModal
      .getByRole("button", { name: "Confirm", exact: true });

    await confirmLocationButton.waitFor({
      state: "visible",
      timeout: 10000
    });

    await confirmLocationButton.click({
      timeout: 10000
    });

    await locationModal.waitFor({
      state: "hidden",
      timeout: 15000
    });

    console.log("Location confirmed.");

    console.log("Selecting One Time Standard Cleaning...");

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

const cleanAsDirected = page
  .locator('li[role="option"][aria-label="Standard Cleaning"]')
  .filter({ hasText: "$82.5" })
  .first();

await cleanAsDirected.waitFor({
  state: "visible",
  timeout: 10000
});

console.log(
  "Found service:",
  (await cleanAsDirected.innerText()).replace(/\s+/g, " ").trim()
);

await cleanAsDirected.evaluate(element => {
  element.dispatchEvent(
    new MouseEvent("mousedown", {
      bubbles: true,
      cancelable: true,
      view: window
    })
  );

  element.dispatchEvent(
    new MouseEvent("mouseup", {
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

await page.waitForTimeout(3000);

const serviceState = await page.evaluate(() => {
  const dropdown =
    document.querySelector("#servicesdropdown");

  const bodyText = document.body?.innerText || "";

  const selectedOptions = Array.from(
    document.querySelectorAll(
      'li[role="option"][aria-selected="true"]'
    )
  ).map(el =>
    String(el.innerText || el.textContent || "")
      .replace(/\s+/g, " ")
      .trim()
  );

  const serviceDetailsPresent =
    /Service Details/i.test(bodyText) &&
    /Standard Cleaning/i.test(bodyText);

  return {
    dropdownText: String(
      dropdown?.innerText ||
      dropdown?.textContent ||
      ""
    )
      .replace(/\s+/g, " ")
      .trim(),
    selectedOptions,
    serviceDetailsPresent
  };
});

console.log(
  "Service state:",
  JSON.stringify(serviceState)
);

if (
  !serviceState.selectedOptions.some(x =>
    /Standard Cleaning/i.test(x)
  ) &&
  !serviceState.serviceDetailsPresent
) {
  throw new Error(
    `SERVICE_NOT_SELECTED: ${JSON.stringify(serviceState)}`
  );
}

console.log("Service selected: true");

function parseLocalDateTime(dateIso, time24) {
  const [y, m, d] = dateIso.split("-").map(Number);
  const [hh, mm] = time24.split(":").map(Number);
  return new Date(y, m - 1, d, hh, mm, 0, 0);
}

function addHours(date, hours) {
  return new Date(date.getTime() + Math.round(hours * 60 * 60 * 1000));
}

function formatOctopusDate(date) {
  const weekday = new Intl.DateTimeFormat("en-US", {
    weekday: "long"
  }).format(date);

  const day = String(date.getDate()).padStart(2, "0");

  const month = new Intl.DateTimeFormat("en-US", {
    month: "long"
  }).format(date);

  const year = date.getFullYear();

  return `${weekday}, ${day} ${month} ${year}`;
}

function formatOctopusTime(date) {
  return new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true
  }).format(date);
}

const requestedStart = parseLocalDateTime(TEST.bookingDate, TEST.startTime);
const requestedEnd = addHours(requestedStart, TEST.durationHours || 2);

const expectedAppointment = {
  startDate: formatOctopusDate(requestedStart),
  startTime: formatOctopusTime(requestedStart),
  endDate: formatOctopusDate(requestedEnd),
  endTime: formatOctopusTime(requestedEnd)
};

console.log("Calculated appointment:", JSON.stringify(expectedAppointment));

console.log("Setting appointment date and time...");

async function forceInputValue(selector, value) {
  const field = page.locator(selector).first();

  await field.waitFor({
    state: "attached",
    timeout: 10000
  });

  await field.evaluate(
    (element, nextValue) => {
      element.value = nextValue;
      element.dispatchEvent(new Event("input", { bubbles: true }));
      element.dispatchEvent(new Event("change", { bubbles: true }));
      element.dispatchEvent(new Event("blur", { bubbles: true }));
    },
    value
  );
}

await forceInputValue(
  'input[name^="multi_new_stpartdate_"][name$="_0[0]"]',
  expectedAppointment.startDate
);

await forceInputValue(
  'input[name^="multi_new_stparttime_"][name$="_0[0]"]',
  expectedAppointment.startTime
);

await forceInputValue(
  'input[name^="multi_new_etpartdate_"][name$="_0[0]"]',
  expectedAppointment.endDate
);

await forceInputValue(
  'input[name^="multi_new_etparttime_"][name$="_0[0]"]',
  expectedAppointment.endTime
);

await page.waitForTimeout(2000);

console.log("Appointment date/time set.");


    await setValue(
      page,
      '#sub_total',
      TEST.price
    );

    await setValue(
      page,
      '#total_qoute',
      TEST.price
    );

    console.log("Completing required booking fields with exact DOM inspection...");

    // ONE-TIME ONLY MODE.
    // IMPORTANT: set the hidden checkbox ONCE and do NOT dispatch a click event.
    // A synthetic click on a checkbox toggles it back off.
    console.log("SETTING ONE TIME CLEANING = TRUE...");

    const oneTimeInput = page.locator(
      'input[name="attribute_8087013985[]"][value="37558"]'
    ).first();

    await oneTimeInput.waitFor({
      state: "attached",
      timeout: 10000
    });

    await oneTimeInput.evaluate(el => {
      const proto = Object.getPrototypeOf(el);
      const checkedSetter =
        Object.getOwnPropertyDescriptor(proto, "checked")?.set;

      if (checkedSetter) {
        checkedSetter.call(el, true);
      } else {
        el.checked = true;
      }

      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    });

    await page.waitForTimeout(800);

    const oneTimeState = await oneTimeInput.evaluate(el => ({
      id: el.id || "",
      name: el.getAttribute("name") || "",
      value: el.value || "",
      checked: !!el.checked
    }));

    console.log("ONE TIME FINAL STATE:", JSON.stringify(oneTimeState));

    if (!oneTimeState.checked) {
      throw new Error("ONE_TIME_NOT_CHECKED");
    }

    const specialNotesField = page.locator("#attribute_8087017483").first();
    const accessInstructionsField = page.locator("#attribute_8087013969").first();

    await specialNotesField.waitFor({ state: "visible", timeout: 10000 });
    await accessInstructionsField.waitFor({ state: "visible", timeout: 10000 });

    await specialNotesField.fill(TEST.specialNotes);
    await specialNotesField.dispatchEvent("input");
    await specialNotesField.dispatchEvent("change");
    await specialNotesField.dispatchEvent("blur");

    await accessInstructionsField.fill(TEST.accessInstructions);
    await accessInstructionsField.dispatchEvent("input");
    await accessInstructionsField.dispatchEvent("change");
    await accessInstructionsField.dispatchEvent("blur");

    console.log(
      "Required notes exact values:",
      JSON.stringify({
        specialNotes: await specialNotesField.inputValue(),
        accessInstructions: await accessInstructionsField.inputValue()
      })
    );

    // IMPORTANT: use only the FIRST scheduled appointment.
    // We previously created/targeted a second appointment accidentally.
    const appointmentBlocks = page.locator('[id^="booking_visits_"]');
    const appointmentCount = await appointmentBlocks.count();
    console.log("Appointment block count:", appointmentCount);

    if (appointmentCount < 1) {
      throw new Error("NO_APPOINTMENT_BLOCK_FOUND");
    }

    const firstAppointment = appointmentBlocks.first();

    // Re-set ONLY the first appointment times after service frequency selection,
    // because selecting One Time can re-render/reset the appointment.
    const firstStartDate = firstAppointment.locator(
      'input[name^="multi_new_stpartdate_"]'
    ).first();
    const firstStartTime = firstAppointment.locator(
      'input[name^="multi_new_stparttime_"]'
    ).first();
    const firstEndDate = firstAppointment.locator(
      'input[name^="multi_new_etpartdate_"]'
    ).first();
    const firstEndTime = firstAppointment.locator(
      'input[name^="multi_new_etparttime_"]'
    ).first();

    async function setFirstAppointmentValue(locator, value) {
  await locator.waitFor({
    state: "visible",
    timeout: 10000
  });

  await locator.scrollIntoViewIfNeeded().catch(() => {});
  await locator.click({ force: true });

  await locator.press("Control+A").catch(() => {});
  await locator.press("Backspace").catch(() => {});
  await locator.type(value, { delay: 20 });

  await locator.press("Enter").catch(() => {});
  await locator.press("Tab").catch(() => {});

  await page.waitForTimeout(400);
}

    await setFirstAppointmentValue(firstStartDate, expectedAppointment.startDate);
    await setFirstAppointmentValue(firstStartTime, expectedAppointment.startTime);
    await setFirstAppointmentValue(firstEndDate, expectedAppointment.endDate);
    await setFirstAppointmentValue(firstEndTime, expectedAppointment.endTime);

    const appointmentTimes = {
      startDate: await firstStartDate.inputValue(),
      startTime: await firstStartTime.inputValue(),
      endDate: await firstEndDate.inputValue(),
      endTime: await firstEndTime.inputValue()
    };

    console.log(
      "First appointment date/time re-applied:",
      JSON.stringify(appointmentTimes)
    );

    if (
      !appointmentTimes.startDate ||
      !appointmentTimes.endDate ||
      appointmentTimes.startTime !== expectedAppointment.startTime ||
      appointmentTimes.endTime !== expectedAppointment.endTime
    ) {
      throw new Error(
        `APPOINTMENT_TIME_NOT_STICKING: ${JSON.stringify(appointmentTimes)}`
      );
    }

    // FIELDWORKER / UNASSIGNED HANDLING
    // "Unassigned Tasks Manager" is our placeholder meaning:
    // create the booking WITHOUT assigning a real fieldworker yet.
    // Octopus is allowed to save the appointment with a blank contractor id.
    // The dispatch watcher will pick it up afterward as NEEDS CLEANER.
    const shouldRemainUnassigned =
      /unassigned tasks manager/i.test(String(TEST.fieldworkerName || ""));

    if (shouldRemainUnassigned) {
      console.log(
        "Leaving appointment UNASSIGNED intentionally; no contractor id required."
      );

      const fieldworkerSearch = firstAppointment
        .locator('input[placeholder="Select Fieldworker"]')
        .first();

      if (await fieldworkerSearch.isVisible().catch(() => false)) {
        await fieldworkerSearch.fill("").catch(() => {});
        await fieldworkerSearch.press("Tab").catch(() => {});
      }

      // Clear any accidental contractor value that may have been inherited
      // during Octopus re-renders.
      await firstAppointment
        .locator('input[name^="contractor_"]')
        .first()
        .evaluate(el => {
          el.value = "";
          el.dispatchEvent(new Event("input", { bubbles: true }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
        })
        .catch(() => {});

      console.log("UNASSIGNED appointment state prepared.");
    } else {
      console.log("Selecting requested fieldworker with component-native input...");

      const fieldworkerSearch = firstAppointment
        .locator('input[placeholder="Select Fieldworker"]')
        .first();

      await fieldworkerSearch.waitFor({
        state: "visible",
        timeout: 15000
      });

      await fieldworkerSearch.scrollIntoViewIfNeeded();
      await fieldworkerSearch.click({ force: true });
      await fieldworkerSearch.fill("");

      await fieldworkerSearch.type(TEST.fieldworkerName, {
        delay: 35
      });

      await page.waitForTimeout(1500);

      const visibleWorkerOptions = page.locator(
        '[role="option"]:visible, .vs__dropdown-option:visible, li:visible'
      );

      const workerOptionsBefore = [];
      for (let i = 0; i < await visibleWorkerOptions.count(); i++) {
        const option = visibleWorkerOptions.nth(i);
        const txt = (await option.innerText().catch(() => ""))
          .replace(/\s+/g, " ")
          .trim();

        if (
          txt &&
          String(TEST.fieldworkerName || "")
            .toLowerCase()
            .split(/\s+/)
            .every(part => txt.toLowerCase().includes(part))
        ) {
          workerOptionsBefore.push(txt);
        }
      }

      console.log(
        "Matching fieldworker options:",
        JSON.stringify(workerOptionsBefore)
      );

      await fieldworkerSearch.press("ArrowDown").catch(() => {});
      await page.waitForTimeout(250);
      await fieldworkerSearch.press("Enter").catch(() => {});
      await page.waitForTimeout(1000);

      let fieldworkerSearchValue =
        await fieldworkerSearch.inputValue().catch(() => "");

      if (!fieldworkerSearchValue) {
        const exactWorkerOption = page
          .getByText(TEST.fieldworkerName, { exact: false })
          .filter({ visible: true })
          .last();

        if (await exactWorkerOption.isVisible().catch(() => false)) {
          await exactWorkerOption.click({
            force: true,
            timeout: 10000
          });
          await page.waitForTimeout(700);
          await fieldworkerSearch.press("Tab").catch(() => {});
          await page.waitForTimeout(700);
        }
      }

      console.log(
        "Requested fieldworker selection attempt completed:",
        TEST.fieldworkerName
      );
    }

    console.log("Re-applying appointment after fieldworker render...");

    // FAST/STABLE FINAL APPOINTMENT SET:
    // Do not use click/type here. Octopus can re-render these controls after
    // the fieldworker area changes, and Playwright can sit on stale/reactive
    // inputs for 30+ seconds per field. Set the live DOM values directly and
    // dispatch the same input/change/blur events Octopus listens for.
    const finalAppointmentState = await page.evaluate(
      ({ expectedAppointment, shouldRemainUnassigned }) => {
        const appointment = document.querySelector('[id^="booking_visits_"]');

        if (!appointment) {
          return {
            error: "NO_LIVE_APPOINTMENT_BLOCK",
            startDate: "",
            startTime: "",
            endDate: "",
            endTime: "",
            fieldworkerId: ""
          };
        }

        const find = prefix =>
          appointment.querySelector(`input[name^="${prefix}"]`);

        const setNativeValue = (el, value) => {
          if (!el) return false;

          const proto = Object.getPrototypeOf(el);
          const descriptor =
            Object.getOwnPropertyDescriptor(proto, "value") ||
            Object.getOwnPropertyDescriptor(
              window.HTMLInputElement.prototype,
              "value"
            );

          if (descriptor && descriptor.set) {
            descriptor.set.call(el, value);
          } else {
            el.value = value;
          }

          el.dispatchEvent(new Event("input", { bubbles: true }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
          el.dispatchEvent(new Event("blur", { bubbles: true }));
          return true;
        };

        const startDateEl = find("multi_new_stpartdate_");
        const startTimeEl = find("multi_new_stparttime_");
        const endDateEl = find("multi_new_etpartdate_");
        const endTimeEl = find("multi_new_etparttime_");
        const contractorEl = appointment.querySelector(
          'input[name^="contractor_"]'
        );

        const applied = {
          startDate: setNativeValue(
            startDateEl,
            expectedAppointment.startDate
          ),
          startTime: setNativeValue(
            startTimeEl,
            expectedAppointment.startTime
          ),
          endDate: setNativeValue(
            endDateEl,
            expectedAppointment.endDate
          ),
          endTime: setNativeValue(
            endTimeEl,
            expectedAppointment.endTime
          )
        };

        if (shouldRemainUnassigned && contractorEl) {
          setNativeValue(contractorEl, "");
        }

        return {
          applied,
          startDate: startDateEl?.value || "",
          startTime: startTimeEl?.value || "",
          endDate: endDateEl?.value || "",
          endTime: endTimeEl?.value || "",
          fieldworkerId: contractorEl?.value || ""
        };
      },
      {
        expectedAppointment,
        shouldRemainUnassigned
      }
    );

    console.log(
      "FINAL appointment + fieldworker state:",
      JSON.stringify(finalAppointmentState)
    );

    if (finalAppointmentState.error) {
      throw new Error(
        `FINAL_APPOINTMENT_DOM_ERROR: ${JSON.stringify(finalAppointmentState)}`
      );
    }

    if (
      finalAppointmentState.startDate !== expectedAppointment.startDate ||
      finalAppointmentState.startTime !== expectedAppointment.startTime ||
      finalAppointmentState.endDate !== expectedAppointment.endDate ||
      finalAppointmentState.endTime !== expectedAppointment.endTime
    ) {
      throw new Error(
        `FINAL_APPOINTMENT_NOT_STICKING: ${JSON.stringify(finalAppointmentState)}`
      );
    }

    if (
      !finalAppointmentState.fieldworkerId &&
      !shouldRemainUnassigned
    ) {
      throw new Error(
        `FIELDWORKER_ID_MISSING: ${JSON.stringify(finalAppointmentState)}`
      );
    }

    if (!finalAppointmentState.fieldworkerId) {
      console.log(
        "No fieldworker id present by design. Booking will save UNASSIGNED."
      );
    } else {
      console.log(
        "Fieldworker id committed:",
        finalAppointmentState.fieldworkerId
      );
    }

    console.log("Required booking fields completed.");

    console.log("Reading current form state...");

    const preSaveState = await page.evaluate(() => {
      const read = selector =>
        document.querySelector(selector)?.value ?? null;

      return {
        customer_id: read('input[name="customer_id"]'),
        customers: read('input[name="customers"]'),

        booking_address_visible:
          document.querySelector(
            'input[placeholder="Booking address"]'
          )?.value ?? null,

        address: read('input[name="address"]'),
        street_number: read("#street_number_0"),
        street_address: read("#street_address_0"),
        suburb: read("#suburb_0"),
        state: read("#state_0"),
        postcode: read("#postcode_0"),
        timezone: read("#time_zone0"),

        booking_address_flag: read("#booking_address_flag"),
        booking_updates_flag: read("#booking_updates_flag"),

        source_id: read('input[name="source_id"]'),
        business_address: read("#business_address"),

        sub_total: read("#sub_total"),
        total_quote: read("#total_qoute"),

        page_text: document.body.innerText
          .split("\n")
          .map(x => x.trim())
          .filter(Boolean)
          .filter(x =>
            /service|customer|location|booking|address|standard cleaning/i.test(
              x
            )
          )
          .slice(0, 100)
      };
    });

    console.log("");
    console.log("===== CREATE BOOKING PRE-SAVE CHECK =====");
    console.log(JSON.stringify(preSaveState, null, 2));
    console.log("===== END PRE-SAVE CHECK =====");
    console.log("");

    console.log("");
    console.log("LOCATION + SERVICE + SCHEDULE VALIDATED.");
    // Octopus re-renders the appointment while editing the service.
    // Re-apply the requested date/time immediately before Save.
    console.log("FINAL PRE-SAVE DATE/TIME FORCE...");

    const finalAppointment = page.locator('[id^="booking_visits_"]').first();

    async function finalSet(prefix, value) {
  const loc = finalAppointment.locator(
    `input[name^="${prefix}"]`
  ).first();

  await loc.waitFor({
    state: "visible",
    timeout: 10000
  });

  await loc.scrollIntoViewIfNeeded().catch(() => {});
  await loc.click({ force: true });

  // Use keyboard input so Octopus' date/time component receives the
  // same event sequence as a human typing into the field.
  await loc.press("Control+A").catch(() => {});
  await loc.press("Backspace").catch(() => {});
  await loc.type(value, { delay: 20 });

  await loc.press("Enter").catch(() => {});
  await loc.press("Tab").catch(() => {});

  await page.waitForTimeout(400);

  return loc;
}


const appointmentSummaryBeforeSave = (
  await page.locator("body").innerText().catch(() => "")
)
  .split("\n")
  .map(x => x.trim())
  .filter(Boolean)
  .filter(x =>
    /Appointment time|Start|End|AM|PM|booking|appointment/i.test(x)
  )
  .slice(-40);

console.log(
  "RENDERED APPOINTMENT SUMMARY BEFORE SAVE:",
  JSON.stringify(appointmentSummaryBeforeSave)
);

console.log("Leaving booking_id blank exactly like successful manual Octopus save.");

const nativeCustomerPayload = await page.locator('input[name="customers"]').first().inputValue().catch(() => "");
console.log("Native customers payload length:", nativeCustomerPayload.length);
console.log("Native customers payload preview:", nativeCustomerPayload.slice(0, 300));

if (!nativeCustomerPayload || nativeCustomerPayload.length < 100) {
  throw new Error(
    `CUSTOMER_PAYLOAD_NOT_FULL_OBJECT: ${nativeCustomerPayload}`
  );
}



console.log("Deposit skipped - not required.");
    
console.log("Attempting to save booking with full validation capture...");

    const postTraffic = [];

    page.on("request", request => {
      if (request.method() === "POST") {
        postTraffic.push({
          kind: "request",
          url: request.url(),
          postData: request.postData() || null
        });
      }
    });

    page.on("response", async response => {
      const request = response.request();
      if (request.method() === "POST") {
        let body = null;
        try {
          body = await response.text();
        } catch {}
        postTraffic.push({
          kind: "response",
          status: response.status(),
          url: response.url(),
          body: body ? body.slice(0, 8000) : null
        });
      }
    });

    const saveButton = page
      .getByText("Save changes", { exact: true })
      .last();

    await saveButton.waitFor({
      state: "visible",
      timeout: 15000
    });

    console.log(
      "Save button disabled:",
      await saveButton.isDisabled().catch(() => false)
    );

    await saveButton.scrollIntoViewIfNeeded();

    // NEW-BOOKING SAVE FIX:
    // Octopus' legacy /booking-add?old=1 endpoint is receiving a blank booking_id
    // field and then treating the request like an update. For a brand-new booking,
    // we will capture the browser-generated form submission and, only if the normal
    // save returns the specific "booking_id cannot be null" error, replay the exact
    // same form data WITHOUT the blank booking_id field.
    let normalSaveResponse = null;
    let normalSaveRequest = null;
    let normalSaveBody = "";

    const normalSaveRequestPromise = page.waitForRequest(
      request =>
        request.method() === "POST" &&
        /\/booking-add\?old=1/i.test(request.url()),
      { timeout: 15000 }
    ).catch(() => null);

    const normalSaveResponsePromise = page.waitForResponse(
      response =>
        response.request().method() === "POST" &&
        /\/booking-add\?old=1/i.test(response.url()),
      { timeout: 20000 }
    ).catch(() => null);

    await saveButton.click({
      timeout: 10000
    }).catch(async error => {
      console.log("Normal Save click failed:", error.message);
      console.log("Retrying with force...");
      await saveButton.click({
        force: true,
        timeout: 10000
      });
    });

    normalSaveRequest = await normalSaveRequestPromise;
    normalSaveResponse = await normalSaveResponsePromise;

    if (normalSaveResponse) {
      normalSaveBody = await normalSaveResponse.text().catch(() => "");
      console.log("Normal save response:", normalSaveBody.slice(0, 12000));
    } else {
      console.log("Normal save produced no matching response within timeout.");
    }

    // First give normal browser behavior a short chance to complete.
    await Promise.race([
      page.waitForURL(/\/booking\/view\/\d+/i, { timeout: 8000 }).catch(() => null),
      page.getByText("Notify Customer", { exact: true })
        .waitFor({ state: "visible", timeout: 8000 })
        .catch(() => null),
      page.waitForTimeout(8000)
    ]);

    // Some Octopus versions POST the exact form but fail because a blank booking_id
    // makes the legacy endpoint think this is an update. If that happens, replay
    // the exact browser-generated form body WITHOUT booking_id.
    const pageAlreadyLooksCreated = await page.evaluate(() => {
      const bodyText = document.body?.innerText || "";
      return (
        /\/booking\/view\/\d+/i.test(location.href) ||
        /\bBOK-\d+\b/i.test(bodyText) ||
        Array.from(document.querySelectorAll("body *")).some(el => {
          const text = String(el.innerText || el.textContent || "")
            .replace(/\s+/g, " ")
            .trim();
          const r = el.getBoundingClientRect();
          const s = getComputedStyle(el);
          return text === "Notify Customer" &&
                 s.display !== "none" &&
                 s.visibility !== "hidden" &&
                 r.width > 0 &&
                 r.height > 0;
        })
      );
    });

    const shouldReplayWithoutBookingId =
      !pageAlreadyLooksCreated &&
      normalSaveRequest &&
      (
        !normalSaveResponse ||
        /booking[_ ]?id.{0,80}(null|blank|required|missing|cannot)/i.test(normalSaveBody) ||
        /cannot be null/i.test(normalSaveBody)
      );

    if (shouldReplayWithoutBookingId) {
      console.log("Normal save did not create booking. Replaying form WITHOUT blank booking_id...");

      const originalPostData = normalSaveRequest.postData() || "";
      const params = new URLSearchParams(originalPostData);

      params.delete("booking_id");

      // Remove any weird bracketed / duplicate booking_id fields if Octopus emitted them.
      for (const key of [...params.keys()]) {
        if (/^booking_id(?:\[.*\])?$/i.test(key)) {
          params.delete(key);
        }
      }

      const replayBody = params.toString();
      console.log("Replay form body length:", replayBody.length);

      const replayResult = await page.evaluate(
        async ({ url, body }) => {
          const response = await fetch(url, {
            method: "POST",
            headers: {
              "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
              "X-Requested-With": "XMLHttpRequest"
            },
            credentials: "include",
            body
          });

          const text = await response.text();

          return {
            ok: response.ok,
            status: response.status,
            url: response.url,
            text: text.slice(0, 12000)
          };
        },
        {
          url: normalSaveRequest.url(),
          body: replayBody
        }
      );

      console.log("Replay save result:", JSON.stringify(replayResult));

      // If replay returned JSON/HTML containing a booking id or redirect URL,
      // navigate to it so the normal diagnostics below can verify creation.
      const replayBookingNumber =
        replayResult.text.match(/\bBOK-\d+\b/i)?.[0]?.toUpperCase() || null;

      const replayBookingId =
        replayResult.text.match(/\/booking\/view\/(\d+)/i)?.[1] ||
        replayResult.text.match(/["']booking_id["']\s*[:=]\s*["']?(\d+)/i)?.[1] ||
        null;

      if (replayBookingId && !/\/booking\/view\/\d+/i.test(page.url())) {
        await page.goto(
          `https://admin.octopuspro.com/booking/view/${replayBookingId}`,
          {
            waitUntil: "domcontentloaded",
            timeout: 30000
          }
        ).catch(() => {});
      } else if (replayBookingNumber) {
        console.log("Replay returned booking number:", replayBookingNumber);
      }

      await Promise.race([
        page.waitForURL(/\/booking\/view\/\d+/i, { timeout: 10000 }).catch(() => null),
        page.getByText("Notify Customer", { exact: true })
          .waitFor({ state: "visible", timeout: 10000 })
          .catch(() => null),
        page.waitForTimeout(10000)
      ]);
    }

    await page.waitForTimeout(1200);

    const saveDiagnostics = await page.evaluate(() => {
      const bodyText = document.body?.innerText || "";
      const bokMatch = bodyText.match(/\bBOK-\d+\b/i);
      const urlMatch = location.href.match(/\/booking\/view\/(\d+)/i);

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

      const visibleAlerts = Array.from(
        document.querySelectorAll(
          '.alert, .alert-danger, .alert-warning, .invalid-feedback, .text-danger, .error, [role="alert"], .toast, .notification'
        )
      )
        .filter(visible)
        .map(el =>
          String(el.innerText || el.textContent || "")
            .replace(/\s+/g, " ")
            .trim()
        )
        .filter(Boolean);

      const invalidFields = Array.from(
        document.querySelectorAll("input, textarea, select")
      )
        .filter(el => {
          try {
            return !el.checkValidity();
          } catch {
            return false;
          }
        })
        .map(el => ({
          tag: el.tagName,
          type: el.getAttribute("type") || "",
          name: el.getAttribute("name") || "",
          id: el.id || "",
          placeholder: el.getAttribute("placeholder") || "",
          value: "value" in el ? String(el.value || "") : "",
          required: !!el.required,
          validationMessage: el.validationMessage || ""
        }));

      const errorLines = bodyText
        .split("\n")
        .map(x => x.trim())
        .filter(Boolean)
        .filter(x =>
          /required|please|error|invalid|warning|confirm|missing|must|cannot|can't|select|enter|provide|booking|service|appointment/i.test(x)
        )
        .slice(0, 250);

      const allTextTail = bodyText
        .split("\n")
        .map(x => x.trim())
        .filter(Boolean)
        .slice(-220);

      const notifyCustomerVisible = Array.from(
        document.querySelectorAll("body *")
      ).some(el => {
        const text = String(el.innerText || el.textContent || "")
          .replace(/\s+/g, " ")
          .trim();
        const r = el.getBoundingClientRect();
        const s = getComputedStyle(el);
        return text === "Notify Customer" &&
               s.display !== "none" &&
               s.visibility !== "hidden" &&
               r.width > 0 &&
               r.height > 0;
      });

      return {
        url: location.href,
        booking_number: bokMatch ? bokMatch[0].toUpperCase() : null,
        booking_id: urlMatch ? urlMatch[1] : null,
        notify_customer_visible: notifyCustomerVisible,
        visibleAlerts,
        invalidFields,
        errorLines,
        allTextTail
      };
    });

    console.log("");
    console.log("===== FULL SAVE DIAGNOSTICS =====");
    console.log(JSON.stringify({
      saveDiagnostics,
      postTraffic
    }, null, 2));
    console.log("===== END FULL SAVE DIAGNOSTICS =====");
    console.log("");

    if (
      saveDiagnostics.booking_number ||
      saveDiagnostics.booking_id ||
      saveDiagnostics.notify_customer_visible
    ) {
      console.log("BOOKING CREATED SUCCESSFULLY.");
      console.log(
        "CREATED BOOKING:",
        JSON.stringify({
          booking_number: saveDiagnostics.booking_number,
          booking_id: saveDiagnostics.booking_id,
          url: saveDiagnostics.url
        })
      );

      FINAL_BOOKING_RESULT = {
        success: true,
        bookingNumber: saveDiagnostics.booking_number,
        bookingId: saveDiagnostics.booking_id,
        url: saveDiagnostics.url
      };

      console.log(
        "LISA_BOOKING_RESULT=" +
        JSON.stringify(FINAL_BOOKING_RESULT)
      );

      // We do not need to send Octopus notifications here.
      // The booking already exists at this point.
      const cancelNotify = page.getByText("Cancel", { exact: true }).last();
      if (
        saveDiagnostics.notify_customer_visible &&
        await cancelNotify.isVisible().catch(() => false)
      ) {
        await cancelNotify.click({ force: true }).catch(() => {});
        console.log("Notify Customer modal closed without sending.");
      }
    } else {
      throw new Error(
        `BOOKING_NOT_CREATED: alerts=${JSON.stringify(saveDiagnostics.visibleAlerts)} ` +
        `invalid=${JSON.stringify(saveDiagnostics.invalidFields)} ` +
        `normalSaveBody=${JSON.stringify(normalSaveBody.slice(0, 4000))}`
      );
    }

  } finally {
    await browser.close();
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});