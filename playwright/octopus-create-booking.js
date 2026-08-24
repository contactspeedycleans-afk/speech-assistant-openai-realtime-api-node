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
  serviceName: "Clean as Directed",
  bookingDate: "2026-08-25",
  startTime: "10:00",
  endTime: "12:00",
  price: "150.00"
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

    console.log("Selecting One Time Clean as Directed...");

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
  .locator('li[role="option"][aria-label="Clean as Directed"]')
  .filter({ hasText: "$150" })
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
    /Clean as Directed/i.test(bodyText);

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
    /Clean as Directed/i.test(x)
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
  'input[name="multi_new_stpartdate_80903_0[0]"]',
  "Tuesday, 25 August 2026"
);

await forceInputValue(
  'input[name="multi_new_stparttime_80903_0[0]"]',
  "10:00 AM"
);

await forceInputValue(
  'input[name="multi_new_etpartdate_80903_0[0]"]',
  "Tuesday, 25 August 2026"
);

await forceInputValue(
  'input[name="multi_new_etparttime_80903_0[0]"]',
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

    console.log("Completing required service + appointment note fields...");

    // --- Cleaning Instructions: exact known textarea from our inspection ---
    const cleaningInstructions = page.locator("#attribute_8090313990");

    await cleaningInstructions.waitFor({
      state: "visible",
      timeout: 10000
    });

    await cleaningInstructions.fill("Clean as directed.");
    await cleaningInstructions.dispatchEvent("change");
    await cleaningInstructions.dispatchEvent("blur");

    console.log(
      "Cleaning Instructions:",
      await cleaningInstructions.inputValue()
    );

    // --- Make sure this appointment is ONE TIME, not recurring ---
    const serviceCard = page.locator("#service_checked_809030");

    const recurringCleaning = serviceCard
      .getByText("Recurring Cleaning", { exact: true })
      .first();

    if (await recurringCleaning.isVisible().catch(() => false)) {
      console.log("Recurring Cleaning control found; switching to One Time Cleaning...");

      await recurringCleaning.click({ force: true });
      await page.waitForTimeout(700);

      const oneTimeChoice = page
        .getByText("One Time Cleaning", { exact: true })
        .last();

      if (await oneTimeChoice.isVisible().catch(() => false)) {
        await oneTimeChoice.click({ force: true });
        await page.waitForTimeout(700);
        console.log("One Time Cleaning selected.");
      } else {
        console.log("One Time Cleaning choice did not appear; continuing with current service state.");
      }
    } else {
      console.log("Recurring Cleaning control not visible; service appears already one-time.");
    }

    // --- Appointment Notes button is where Special Notes + Access Instructions live ---
    console.log("Opening appointment Notes...");

    const appointment = page.locator("#booking_visits_80903_0_0");

    const notesButton = appointment
      .getByText("Notes", { exact: true })
      .last();

    await notesButton.waitFor({
      state: "visible",
      timeout: 10000
    });

    await notesButton.click({
      force: true,
      timeout: 10000
    });

    await page.waitForTimeout(1000);

    async function fillVisibleFieldNearLabel(labelText, value) {
      const result = await page.evaluate(
        ({ labelText, value }) => {
          const norm = s =>
            String(s || "").replace(/\s+/g, " ").trim();

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

          const labels = Array.from(
            document.querySelectorAll(
              "label, div, span, p, strong"
            )
          ).filter(
            el =>
              visible(el) &&
              norm(el.innerText || el.textContent) === labelText
          );

          for (const label of labels) {
            // Search closest wrappers first.
            let wrapper = label.parentElement;

            for (
              let depth = 0;
              depth < 6 && wrapper;
              depth++, wrapper = wrapper.parentElement
            ) {
              const fields = Array.from(
                wrapper.querySelectorAll(
                  "textarea, input[type='text'], input:not([type])"
                )
              ).filter(visible);

              // Exclude address/location fields.
              const usable = fields.filter(field => {
                const ph = norm(
                  field.getAttribute("placeholder")
                );
                return !/booking address|address line|suburb|postal|zip|state|latitude|longitude|tag e\.g|unit \/ lot/i.test(
                  ph
                );
              });

              if (usable.length === 1) {
                const field = usable[0];

                const proto = Object.getPrototypeOf(field);
                const desc =
                  Object.getOwnPropertyDescriptor(
                    proto,
                    "value"
                  );

                if (desc?.set) {
                  desc.set.call(field, value);
                } else {
                  field.value = value;
                }

                field.dispatchEvent(
                  new Event("input", { bubbles: true })
                );
                field.dispatchEvent(
                  new Event("change", { bubbles: true })
                );
                field.dispatchEvent(
                  new Event("blur", { bubbles: true })
                );

                return {
                  filled: true,
                  label: labelText,
                  tag: field.tagName,
                  name: field.getAttribute("name") || "",
                  id: field.id || "",
                  placeholder:
                    field.getAttribute("placeholder") || "",
                  value: field.value
                };
              }
            }
          }

          return {
            filled: false,
            label: labelText,
            reason: "visible label/field not found"
          };
        },
        { labelText, value }
      );

      console.log(
        `${labelText}:`,
        JSON.stringify(result)
      );

      return result;
    }

    const specialNotes = await fillVisibleFieldNearLabel(
      "Special Notes",
      "."
    );

    const accessInstructions =
      await fillVisibleFieldNearLabel(
        "Access Instructions",
        "."
      );

    if (!specialNotes.filled || !accessInstructions.filled) {
      const notesState = await page.evaluate(() => {
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

        return Array.from(
          document.querySelectorAll(
            "textarea, input, label, button, div, span"
          )
        )
          .filter(visible)
          .map(el => ({
            tag: el.tagName,
            name: el.getAttribute("name") || "",
            id: el.id || "",
            placeholder:
              el.getAttribute("placeholder") || "",
            value:
              "value" in el ? String(el.value || "") : "",
            text: String(
              el.innerText || el.textContent || ""
            )
              .replace(/\s+/g, " ")
              .trim()
              .slice(0, 300)
          }))
          .filter(x =>
            /special|access|notes|instruction/i.test(
              [
                x.text,
                x.placeholder,
                x.name,
                x.id
              ].join(" ")
            )
          )
          .slice(0, 150);
      });

      console.log(
        "NOTES DEBUG:",
        JSON.stringify(notesState, null, 2)
      );

      throw new Error(
        `APPOINTMENT_NOTES_NOT_FILLED special=${JSON.stringify(
          specialNotes
        )} access=${JSON.stringify(accessInstructions)}`
      );
    }

    // If Notes opened a dialog/panel with its own Save/Confirm button,
    // save that note section before saving the whole booking.
    const visibleDialogs = page.locator(
      '[role="dialog"]:visible, .modal.show:visible'
    );

    if ((await visibleDialogs.count()) > 0) {
      const dialog = visibleDialogs.last();

      const noteSave = dialog
        .getByRole("button", {
          name: /^(Save|Confirm|Done|Add)$/i
        })
        .last();

      if (await noteSave.isVisible().catch(() => false)) {
        await noteSave.click({ force: true });
        await page.waitForTimeout(700);
        console.log("Appointment Notes saved.");
      }
    }

    console.log("Required service + appointment note fields completed.");

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
    console.log("Attempting to save booking...");

    const saveButton = page
      .getByText("Save changes", { exact: true })
      .last();

    await saveButton.waitFor({
      state: "visible",
      timeout: 15000
    });

    await saveButton.click({
      timeout: 10000
    });

    await page.waitForTimeout(8000);

    const created = await page.evaluate(() => {
      const bodyText = document.body?.innerText || "";
      const bokMatch = bodyText.match(/\bBOK-\d+\b/i);
      const urlMatch = location.href.match(/\/booking\/view\/(\d+)/i);

      return {
        url: location.href,
        booking_number: bokMatch ? bokMatch[0].toUpperCase() : null,
        booking_id: urlMatch ? urlMatch[1] : null,
        body_excerpt: bodyText
          .split("\n")
          .map(x => x.trim())
          .filter(Boolean)
          .filter(x =>
            /BOK-|Gina|Grand River|Howell|Clean as Directed|150|Aug|10:00|12:00|Upcoming/i.test(x)
          )
          .slice(0, 120)
      };
    });

    console.log("");
    console.log("===== CREATED BOOKING RESULT =====");
    console.log(JSON.stringify(created, null, 2));
    console.log("===== END CREATED BOOKING RESULT =====");
    console.log("");

    if (!created.booking_number && !created.booking_id) {
      throw new Error(
        `BOOKING_NOT_CREATED: stayed at ${created.url}`
      );
    }

    console.log("Booking created. Verifying booking page...");

    if (created.booking_id) {
      await page.goto(
        `https://admin.octopuspro.com/booking/view/${created.booking_id}`,
        {
          waitUntil: "domcontentloaded",
          timeout: 60000
        }
      );

      await page.waitForTimeout(5000);
    }

    const verification = await page.evaluate(() => {
      const bodyText = document.body?.innerText || "";

      return {
        url: location.href,
        booking_number:
          bodyText.match(/\bBOK-\d+\b/i)?.[0]?.toUpperCase() || null,
        has_customer: /Gina Manciolini/i.test(bodyText),
        has_address:
          /123 Grand River (Avenue|Ave)/i.test(bodyText) &&
          /Howell/i.test(bodyText) &&
          /48843/i.test(bodyText),
        has_service: /Clean as Directed/i.test(bodyText),
        has_price: /\$?\s*150(?:\.00)?/.test(bodyText),
        has_time:
          /10:00\s*AM/i.test(bodyText) &&
          /12:00\s*PM/i.test(bodyText),
        excerpt: bodyText
          .split("\n")
          .map(x => x.trim())
          .filter(Boolean)
          .filter(x =>
            /BOK-|Gina|Grand River|Howell|48843|Clean as Directed|150|10:00|12:00|Upcoming/i.test(x)
          )
          .slice(0, 160)
      };
    });

    console.log("");
    console.log("===== BOOKING VERIFICATION =====");
    console.log(JSON.stringify(verification, null, 2));
    console.log("===== END BOOKING VERIFICATION =====");
    console.log("");
    console.log("");
  } finally {
    await browser.close();
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});