import { chromium } from "playwright";

const OCTOPUS_EMAIL = process.env.OCTOPUS_EMAIL;
const OCTOPUS_PASSWORD = process.env.OCTOPUS_PASSWORD;
const ORGANIZATION_NAME =
  process.env.OCTOPUS_ORGANIZATION_NAME || "SpeedyCleans";

const TEST = {
  customerName: "Gina Manciolini",
  customerId: "1570670",
  streetNumber: "123",
  streetAddress: "Grand River Avenue",
  suburb: "Howell",
  state: "MI",
  postcode: "48843",
  serviceName: "Standard Cleaning",
  bookingDate: "2026-08-25",
  startTime: "10:00",
  endTime: "12:00",
  price: "82.50",
  fieldworkerName: "Unassigned Tasks Manager",
  specialNotes: ".",
  accessInstructions: "."
};

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

    console.log("Filling customer...");

    await setValue(
      page,
      'input[name="customer_id"]',
      TEST.customerId
    );

    await setValue(
      page,
      'input[name="customers"]',
      JSON.stringify([
        {
          id: TEST.customerId,
          name: TEST.customerName
        }
      ])
    );

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

    const exactAddressText =
      `${TEST.streetNumber} ${TEST.streetAddress}, ${TEST.suburb}, ${TEST.state} ${TEST.postcode}, United States`;

    const exactAddressResult = page
      .getByText(exactAddressText, { exact: true })
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
  "Tuesday, 25 August 2026"
);

await forceInputValue(
  'input[name^="multi_new_stparttime_"][name$="_0[0]"]',
  "10:00 AM"
);

await forceInputValue(
  'input[name^="multi_new_etpartdate_"][name$="_0[0]"]',
  "Tuesday, 25 August 2026"
);

await forceInputValue(
  'input[name^="multi_new_etparttime_"][name$="_0[0]"]',
  "12:00 PM"
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

    console.log("Completing required booking fields...");

    async function clickVisibleExactText(textValue) {
      const matches = page.getByText(textValue, { exact: true });
      const count = await matches.count();

      for (let i = 0; i < count; i++) {
        const item = matches.nth(i);
        if (await item.isVisible().catch(() => false)) {
          await item.scrollIntoViewIfNeeded().catch(() => {});
          await item.click({ force: true, timeout: 10000 });
          return true;
        }
      }

      return false;
    }

    async function fillNearExactLabel(labelText, value) {
      return await page.evaluate(
        ({ labelText, value }) => {
          const normalize = value =>
            String(value || "").replace(/\s+/g, " ").trim();

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

          const labels = Array.from(
            document.querySelectorAll("label, div, span, p, strong")
          ).filter(element => {
            if (!visible(element)) return false;

            const ownText = normalize(
              Array.from(element.childNodes)
                .filter(node => node.nodeType === Node.TEXT_NODE)
                .map(node => node.textContent)
                .join(" ")
            );

            const fullText = normalize(
              element.innerText || element.textContent
            );

            return ownText === labelText || fullText === labelText;
          });

          const forbidden = field => {
            const placeholder = normalize(
              field.getAttribute("placeholder")
            );
            const name = normalize(field.getAttribute("name"));
            const id = normalize(field.id);

            return /booking address|address line|suburb|postal|zip|state|latitude|longitude|customer|fieldworker|date|time/i.test(
              `${placeholder} ${name} ${id}`
            );
          };

          const setFieldValue = field => {
            const proto = Object.getPrototypeOf(field);
            const descriptor =
              Object.getOwnPropertyDescriptor(proto, "value");

            if (descriptor?.set) {
              descriptor.set.call(field, value);
            } else {
              field.value = value;
            }

            field.dispatchEvent(new Event("input", { bubbles: true }));
            field.dispatchEvent(new Event("change", { bubbles: true }));
            field.dispatchEvent(new Event("blur", { bubbles: true }));

            return {
              filled: true,
              label: labelText,
              tag: field.tagName,
              name: field.getAttribute("name") || "",
              id: field.id || "",
              placeholder: field.getAttribute("placeholder") || "",
              value: field.value
            };
          };

          for (const label of labels) {
            let wrapper = label.parentElement;

            for (
              let depth = 0;
              depth < 6 && wrapper;
              depth++, wrapper = wrapper.parentElement
            ) {
              const candidates = Array.from(
                wrapper.querySelectorAll(
                  'textarea, input[type="text"], input:not([type])'
                )
              ).filter(field => visible(field) && !forbidden(field));

              if (candidates.length === 1) {
                return setFieldValue(candidates[0]);
              }
            }

            const labelRect = label.getBoundingClientRect();
            const fields = Array.from(
              document.querySelectorAll(
                'textarea, input[type="text"], input:not([type])'
              )
            ).filter(field => {
              if (!visible(field) || forbidden(field)) return false;

              const rect = field.getBoundingClientRect();
              return (
                rect.top >= labelRect.bottom - 5 &&
                rect.top - labelRect.bottom < 220
              );
            });

            if (fields.length) {
              return setFieldValue(fields[0]);
            }
          }

          return {
            filled: false,
            label: labelText,
            reason: "visible field near exact label not found"
          };
        },
        { labelText, value }
      );
    }

    console.log("Selecting One Time Cleaning...");
    const oneTimeSelected = await clickVisibleExactText("One Time Cleaning");

    if (!oneTimeSelected) {
      throw new Error("ONE_TIME_NOT_SELECTED: visible One Time Cleaning option not found.");
    }

    await page.waitForTimeout(700);

    const specialNotesResult = await fillNearExactLabel(
      "Special Notes",
      TEST.specialNotes
    );

    console.log(
      "Special Notes:",
      JSON.stringify(specialNotesResult)
    );

    if (!specialNotesResult.filled) {
      throw new Error(
        `SPECIAL_NOTES_NOT_FILLED: ${JSON.stringify(specialNotesResult)}`
      );
    }

    const accessInstructionsResult = await fillNearExactLabel(
      "Access Instructions",
      TEST.accessInstructions
    );

    console.log(
      "Access Instructions:",
      JSON.stringify(accessInstructionsResult)
    );

    if (!accessInstructionsResult.filled) {
      throw new Error(
        `ACCESS_INSTRUCTIONS_NOT_FILLED: ${JSON.stringify(accessInstructionsResult)}`
      );
    }

    console.log("Selecting placeholder fieldworker...");

    const fieldworkerSearch = page
      .locator('input[placeholder="Select Fieldworker"]')
      .first();

    await fieldworkerSearch.waitFor({
      state: "visible",
      timeout: 15000
    });

    await fieldworkerSearch.click({ force: true });
    await fieldworkerSearch.fill(TEST.fieldworkerName);

    await page.waitForTimeout(1500);

    let fieldworkerSelected = false;

    const optionCandidates = page.locator(
      '[role="option"], .vs__dropdown-option, li'
    );

    const optionCount = await optionCandidates.count();

    for (let i = 0; i < optionCount; i++) {
      const option = optionCandidates.nth(i);
      const optionText = (
        await option.innerText().catch(() => "")
      )
        .replace(/\s+/g, " ")
        .trim();

      if (
        optionText &&
        optionText.toLowerCase().includes(
          TEST.fieldworkerName.toLowerCase()
        ) &&
        await option.isVisible().catch(() => false)
      ) {
        console.log("Found fieldworker:", optionText);
        await option.click({ force: true, timeout: 10000 });
        fieldworkerSelected = true;
        break;
      }
    }

    if (!fieldworkerSelected) {
      const exactFieldworker = page
        .getByText(TEST.fieldworkerName, { exact: false })
        .last();

      if (await exactFieldworker.isVisible().catch(() => false)) {
        console.log(
          "Found fieldworker:",
          (await exactFieldworker.innerText())
            .replace(/\s+/g, " ")
            .trim()
        );
        await exactFieldworker.click({
          force: true,
          timeout: 10000
        });
        fieldworkerSelected = true;
      }
    }

    if (!fieldworkerSelected) {
      throw new Error(
        `FIELDWORKER_NOT_SELECTED: could not find ${TEST.fieldworkerName}`
      );
    }

    await page.waitForTimeout(1000);

    console.log("Required booking fields completed.");

    console.log("Reading current form state...");

    const result = await page.evaluate(() => {
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
            /gina|grand river|howell|clean as directed|150|service|customer|location/i.test(
              x
            )
          )
          .slice(0, 100)
      };
    });

    console.log("");
    console.log("===== CREATE BOOKING PRE-SAVE CHECK =====");
    console.log(JSON.stringify(result, null, 2));
    console.log("===== END PRE-SAVE CHECK =====");
    console.log("");

    console.log("");
    console.log("LOCATION + SERVICE + SCHEDULE VALIDATED.");
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

    await page.waitForTimeout(8000);

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

      return {
        url: location.href,
        booking_number: bokMatch ? bokMatch[0].toUpperCase() : null,
        booking_id: urlMatch ? urlMatch[1] : null,
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

    if (saveDiagnostics.booking_number || saveDiagnostics.booking_id) {
      console.log("BOOKING CREATED SUCCESSFULLY.");
    } else {
      console.log("BOOKING NOT CREATED - validation details printed above.");
    }

  } finally {
    await browser.close();
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});