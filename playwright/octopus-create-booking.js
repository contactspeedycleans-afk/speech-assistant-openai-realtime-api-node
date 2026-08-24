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

    console.log("Completing required booking fields with exact DOM inspection...");

    async function chooseOneTimeCleaning() {
      const exact = page.locator(
        'input[name="attribute_8087013985[]"][value="37558"]'
      ).first();

      if (await exact.count()) {
        await exact.evaluate(el => {
          el.checked = true;
          el.dispatchEvent(new Event("input", { bubbles: true }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
        });

        await page.waitForTimeout(500);

        const state = await exact.evaluate(el => ({
          name: el.getAttribute("name") || "",
          value: el.value || "",
          checked: !!el.checked
        }));

        console.log("One Time Cleaning exact input:", JSON.stringify(state));

        if (state.checked) return true;
      }

      const fallback = await page.evaluate(() => {
        const norm = s => String(s || "").replace(/\s+/g, " ").trim();
        const visible = el => {
          if (!el) return false;
          const r = el.getBoundingClientRect();
          const st = getComputedStyle(el);
          return st.display !== "none" &&
                 st.visibility !== "hidden" &&
                 r.width > 0 &&
                 r.height > 0;
        };

        const candidates = Array.from(
          document.querySelectorAll("label, div, span, button")
        ).filter(visible);

        const target = candidates.find(el =>
          norm(el.innerText || el.textContent) === "One Time Cleaning"
        );

        if (!target) {
          return { selected: false, reason: "visible One Time Cleaning label not found" };
        }

        const wrapper = target.closest("label") || target.parentElement || target;
        const input =
          wrapper.querySelector?.('input[type="radio"], input[type="checkbox"]') ||
          target.querySelector?.('input[type="radio"], input[type="checkbox"]');

        target.click();

        if (input) {
          input.checked = true;
          input.dispatchEvent(new Event("input", { bubbles: true }));
          input.dispatchEvent(new Event("change", { bubbles: true }));
        }

        return {
          selected: input ? !!input.checked : true,
          inputName: input?.getAttribute("name") || "",
          inputValue: input?.value || "",
          checked: input ? !!input.checked : null
        };
      });

      console.log("One Time Cleaning fallback:", JSON.stringify(fallback));
      return !!fallback.selected;
    }

    async function inspectLabeledFields() {
      return await page.evaluate(() => {
        const norm = s => String(s || "").replace(/\s+/g, " ").trim();
        const visible = el => {
          if (!el) return false;
          const r = el.getBoundingClientRect();
          const st = getComputedStyle(el);
          return st.display !== "none" &&
                 st.visibility !== "hidden" &&
                 r.width > 0 &&
                 r.height > 0;
        };

        const fields = Array.from(document.querySelectorAll('textarea, input, select'))
          .filter(visible)
          .map(el => {
            let parent = el.parentElement;
            const ancestors = [];
            for (let i = 0; i < 5 && parent; i++, parent = parent.parentElement) {
              const t = norm(parent.innerText || parent.textContent);
              if (t && t.length < 1200) ancestors.push(t);
            }
            return {
              tag: el.tagName,
              type: el.getAttribute("type") || "",
              name: el.getAttribute("name") || "",
              id: el.id || "",
              value: "value" in el ? String(el.value || "") : "",
              placeholder: el.getAttribute("placeholder") || "",
              ancestors
            };
          });

        return fields.filter(f =>
          /special notes|access instructions|one time or recurring|fieldworker/i.test(
            [f.name, f.id, f.placeholder, ...f.ancestors].join(" ")
          )
        );
      });
    }

    // Exact required service fields discovered from live Octopus DOM.
    const specialNotesField = page.locator("#attribute_8087017483").first();
    const accessInstructionsField = page.locator("#attribute_8087013969").first();

    await specialNotesField.waitFor({
      state: "visible",
      timeout: 10000
    });

    await accessInstructionsField.waitFor({
      state: "visible",
      timeout: 10000
    });

    await specialNotesField.fill(TEST.specialNotes);
    await specialNotesField.dispatchEvent("input");
    await specialNotesField.dispatchEvent("change");
    await specialNotesField.dispatchEvent("blur");

    await accessInstructionsField.fill(TEST.accessInstructions);
    await accessInstructionsField.dispatchEvent("input");
    await accessInstructionsField.dispatchEvent("change");
    await accessInstructionsField.dispatchEvent("blur");

    const requiredNotesState = {
      specialNotes: await specialNotesField.inputValue(),
      accessInstructions: await accessInstructionsField.inputValue()
    };

    console.log(
      "Required notes exact values:",
      JSON.stringify(requiredNotesState)
    );

    if (
      requiredNotesState.specialNotes !== TEST.specialNotes ||
      requiredNotesState.accessInstructions !== TEST.accessInstructions
    ) {
      throw new Error(
        `REQUIRED_NOTES_NOT_STICKING: ${JSON.stringify(requiredNotesState)}`
      );
    }

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
      await locator.waitFor({ state: "attached", timeout: 10000 });
      await locator.evaluate((el, nextValue) => {
        const proto = Object.getPrototypeOf(el);
        const desc = Object.getOwnPropertyDescriptor(proto, "value");

        if (desc?.set) {
          desc.set.call(el, nextValue);
        } else {
          el.value = nextValue;
        }

        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
        el.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: "Tab" }));
        el.dispatchEvent(new Event("blur", { bubbles: true }));
      }, value);

      await locator.press("Tab").catch(() => {});
      await page.waitForTimeout(150);
    }

    await setFirstAppointmentValue(firstStartDate, "Tuesday, 25 August 2026");
    await setFirstAppointmentValue(firstStartTime, "10:00 AM");
    await setFirstAppointmentValue(firstEndDate, "Tuesday, 25 August 2026");
    await setFirstAppointmentValue(firstEndTime, "12:00 PM");

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
      appointmentTimes.startTime !== "10:00 AM" ||
      appointmentTimes.endTime !== "12:00 PM"
    ) {
      throw new Error(
        `APPOINTMENT_TIME_NOT_STICKING: ${JSON.stringify(appointmentTimes)}`
      );
    }

    // Select fieldworker inside the FIRST appointment only.
    const fieldworkerSearch = firstAppointment
      .locator('input[placeholder="Select Fieldworker"]')
      .first();

    await fieldworkerSearch.waitFor({
      state: "visible",
      timeout: 15000
    });

    await fieldworkerSearch.click({ force: true });
    await fieldworkerSearch.fill(TEST.fieldworkerName);
    await page.waitForTimeout(1200);

    let selectedFieldworker = false;

    const options = page.locator(
      '[role="option"]:visible, .vs__dropdown-option:visible, li:visible'
    );
    const optionCount = await options.count();

    for (let i = 0; i < optionCount; i++) {
      const option = options.nth(i);
      const txt = (await option.innerText().catch(() => ""))
        .replace(/\s+/g, " ")
        .trim();

      if (
        txt &&
        txt.toLowerCase().includes(TEST.fieldworkerName.toLowerCase())
      ) {
        console.log("Selecting fieldworker option:", txt);
        await option.click({ force: true, timeout: 10000 });
        selectedFieldworker = true;
        break;
      }
    }

    if (!selectedFieldworker) {
      throw new Error(
        `FIELDWORKER_NOT_SELECTED: ${TEST.fieldworkerName}`
      );
    }

    await page.waitForTimeout(700);

    const fieldworkerState = await firstAppointment.evaluate(el => {
      const txt = String(el.innerText || el.textContent || "")
        .replace(/\s+/g, " ")
        .trim();

      const hiddenValues = Array.from(
        el.querySelectorAll('input[type="hidden"]')
      ).map(input => ({
        name: input.getAttribute("name") || "",
        value: input.value || ""
      }));

      return { text: txt, hiddenValues };
    });

    console.log(
      "First appointment fieldworker state:",
      JSON.stringify(fieldworkerState)
    );

    if (
      !/Unassigned Tasks Manager/i.test(fieldworkerState.text) &&
      !fieldworkerState.hiddenValues.some(x =>
        /fieldworker|worker|assigned/i.test(x.name) && x.value
      )
    ) {
      throw new Error(
        `FIELDWORKER_NOT_STICKING: ${JSON.stringify(fieldworkerState)}`
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
            /gina|grand river|howell|clean as directed|150|service|customer|location/i.test(
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
    const preSaveRequiredState = {
      oneTimeChecked: await page.locator(
        'input[name="attribute_8087013985[]"][value="37558"]'
      ).first().isChecked().catch(() => false),

      specialNotes: await page.locator(
        "#attribute_8087017483"
      ).first().inputValue().catch(() => ""),

      accessInstructions: await page.locator(
        "#attribute_8087013969"
      ).first().inputValue().catch(() => ""),

      fieldworkerText: (
        await firstAppointment.innerText().catch(() => "")
      ).replace(/\s+/g, " ").trim()
    };

    console.log(
      "PRE-SAVE REQUIRED STATE:",
      JSON.stringify(preSaveRequiredState)
    );

    if (!preSaveRequiredState.oneTimeChecked) {
      throw new Error("PRE_SAVE_ONE_TIME_NOT_CHECKED");
    }

    if (!preSaveRequiredState.specialNotes) {
      throw new Error("PRE_SAVE_SPECIAL_NOTES_EMPTY");
    }

    if (!preSaveRequiredState.accessInstructions) {
      throw new Error("PRE_SAVE_ACCESS_INSTRUCTIONS_EMPTY");
    }

    if (
      !preSaveRequiredState.fieldworkerText.includes(
        TEST.fieldworkerName
      )
    ) {
      throw new Error(
        "PRE_SAVE_FIELDWORKER_NOT_CONFIRMED"
      );
    }

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