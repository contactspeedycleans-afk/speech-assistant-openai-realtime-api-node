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

    // ONE-TIME ONLY MODE.
    // Always click the actual visible One Time Cleaning control exactly like a human.
    console.log("FORCING ONE TIME CLEANING SELECTION...");

    const oneTimeInput = page.locator(
      'input[name="attribute_8087013985[]"][value="37558"]'
    ).first();

    await oneTimeInput.waitFor({
      state: "attached",
      timeout: 10000
    });

    const oneTimeMeta = await oneTimeInput.evaluate(el => ({
      id: el.id || "",
      name: el.getAttribute("name") || "",
      value: el.value || "",
      checked: !!el.checked
    }));

    console.log("One Time input before click:", JSON.stringify(oneTimeMeta));

    // Best path: click the label tied to the real input, if Octopus supplied one.
    if (oneTimeMeta.id) {
      const tiedLabel = page.locator(`label[for="${oneTimeMeta.id}"]`).first();

      if (await tiedLabel.isVisible().catch(() => false)) {
        console.log("Clicking One Time label tied to input...");
        await tiedLabel.scrollIntoViewIfNeeded().catch(() => {});
        await tiedLabel.click({ force: true, timeout: 10000 });
        await page.waitForTimeout(800);
      }
    }

    // Second path: click the smallest visible control containing exactly this text.
    if (!(await oneTimeInput.isChecked().catch(() => false))) {
      const exactTextNodes = page.getByText("One Time Cleaning", {
        exact: true
      });

      for (let i = 0; i < await exactTextNodes.count(); i++) {
        const node = exactTextNodes.nth(i);
        if (!(await node.isVisible().catch(() => false))) continue;

        const clickable = node.locator(
          'xpath=ancestor-or-self::label[1] | ancestor-or-self::button[1] | ancestor-or-self::*[@role="button"][1] | ancestor-or-self::div[1]'
        ).first();

        if (await clickable.count()) {
          console.log("Clicking visible One Time Cleaning control...");
          await clickable.scrollIntoViewIfNeeded().catch(() => {});
          await clickable.click({ force: true, timeout: 10000 });
          await page.waitForTimeout(800);
          break;
        }
      }
    }

    // Third path: real browser click on the underlying control.
    if (!(await oneTimeInput.isChecked().catch(() => false))) {
      console.log("Clicking One Time input directly...");
      await oneTimeInput.click({ force: true, timeout: 10000 });
      await page.waitForTimeout(800);
    }

    // Final framework event sequence.
    await oneTimeInput.evaluate(el => {
      if (!el.checked) el.checked = true;
      el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
      el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    });

    await page.waitForTimeout(1000);

    const oneTimeAfter = await oneTimeInput.evaluate(el => ({
      id: el.id || "",
      checked: !!el.checked,
      value: el.value || "",
      className: el.className || "",
      parentText: String(el.parentElement?.innerText || "")
        .replace(/\s+/g, " ")
        .trim()
    }));

    console.log("ONE TIME AFTER CLICK:", JSON.stringify(oneTimeAfter));



    async function chooseOneTimeCleaning() {
      console.log("Selecting One Time Cleaning exactly like the web form...");

      // The manual Octopus flow uses the visible One Time Cleaning button.
      // Do NOT rely on manually toggling the hidden checkbox state.
      const oneTimeText = page.getByText("One Time Cleaning", {
        exact: true
      });

      const count = await oneTimeText.count();
      let clicked = false;
      let clickedState = null;

      for (let i = 0; i < count; i++) {
        const node = oneTimeText.nth(i);

        if (!(await node.isVisible().catch(() => false))) continue;

        const candidate = node.locator(
          'xpath=ancestor-or-self::button[1] | ancestor-or-self::*[@role="button"][1] | ancestor-or-self::label[1] | ancestor-or-self::div[1]'
        ).first();

        if (await candidate.count()) {
          await candidate.scrollIntoViewIfNeeded().catch(() => {});
          await candidate.click({
            force: true,
            timeout: 10000
          });

          await page.waitForTimeout(800);

          clickedState = await candidate.evaluate(el => ({
            tag: el.tagName,
            text: String(el.innerText || el.textContent || "")
              .replace(/\s+/g, " ")
              .trim(),
            className: el.className || "",
            ariaPressed: el.getAttribute("aria-pressed"),
            ariaChecked: el.getAttribute("aria-checked"),
            ariaSelected: el.getAttribute("aria-selected")
          })).catch(() => null);

          clicked = true;
          break;
        }
      }

      if (!clicked) {
        throw new Error("ONE_TIME_VISIBLE_CONTROL_NOT_FOUND");
      }

      console.log(
        "One Time visible control after click:",
        JSON.stringify(clickedState)
      );

      // Give Vue time to commit its model.
      await page.waitForTimeout(1200);

      // Verify from the service card itself that One Time Cleaning is rendered
      // as the chosen value. The form validator is the final authority.
      const serviceAreaText = await page.locator("body").innerText();

      if (!/One Time or Recurring/i.test(serviceAreaText) ||
          !/One Time Cleaning/i.test(serviceAreaText)) {
        throw new Error("ONE_TIME_SELECTION_NOT_RENDERED");
      }

      return true;
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
      await locator.waitFor({ state: "attached", timeout: 10000 });
      await locator.evaluate((el, nextValue) => {
        const proto = Object.getPrototypeOf(el);
        const desc = Object.getOwnPropertyDescriptor(proto, "value");
        if (desc?.set) desc.set.call(el, nextValue);
        else el.value = nextValue;
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
        el.dispatchEvent(new Event("blur", { bubbles: true }));
      }, value);
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
    // Use the fieldworker component's keyboard selection first because a raw LI click
    // was visually finding the worker but was not committing the Vue/select state.
    console.log("Selecting placeholder fieldworker with component-native input...");

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

    // Type normally so Octopus/Vue receives keyboard/input events.
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

      if (txt && /Unassigned Tasks Manager/i.test(txt)) {
        workerOptionsBefore.push(txt);
      }
    }

    console.log(
      "Matching fieldworker options:",
      JSON.stringify(workerOptionsBefore)
    );

    // Preferred path: keyboard selection. This lets the actual select component
    // commit its internal value instead of only clicking visible text.
    await fieldworkerSearch.press("ArrowDown").catch(() => {});
    await page.waitForTimeout(250);
    await fieldworkerSearch.press("Enter").catch(() => {});
    await page.waitForTimeout(1000);

    let fieldworkerSearchValue =
      await fieldworkerSearch.inputValue().catch(() => "");

    let firstAppointmentText = (
      await firstAppointment.innerText().catch(() => "")
    )
      .replace(/\s+/g, " ")
      .trim();

    let pageHasWorker =
      /Unassigned Tasks Manager/i.test(firstAppointmentText) ||
      /Unassigned Tasks Manager/i.test(
        await page.locator("body").innerText().catch(() => "")
      );

    // Fallback: if keyboard selection did not visibly commit, click the exact
    // matching visible option and then press Tab to commit/blur the component.
    if (!pageHasWorker && !fieldworkerSearchValue) {
      const exactWorkerOption = page
        .getByText(/Unassigned Tasks Manager/i)
        .filter({ visible: true })
        .last();

      if (await exactWorkerOption.isVisible().catch(() => false)) {
        console.log(
          "Keyboard commit not visible; clicking exact fieldworker option..."
        );

        await exactWorkerOption.click({
          force: true,
          timeout: 10000
        });

        await page.waitForTimeout(700);
        await fieldworkerSearch.press("Tab").catch(() => {});
        await page.waitForTimeout(700);
      }
    }

    fieldworkerSearchValue =
      await fieldworkerSearch.inputValue().catch(() => "");

    firstAppointmentText = (
      await firstAppointment.innerText().catch(() => "")
    )
      .replace(/\s+/g, " ")
      .trim();

    const fieldworkerDomState = await firstAppointment.evaluate(el => {
      const allInputs = Array.from(
        el.querySelectorAll("input")
      ).map(input => ({
        type: input.getAttribute("type") || "",
        name: input.getAttribute("name") || "",
        id: input.id || "",
        placeholder: input.getAttribute("placeholder") || "",
        value: input.value || "",
        checked:
          input.type === "checkbox" || input.type === "radio"
            ? !!input.checked
            : null
      }));

      const selectedLike = Array.from(
        el.querySelectorAll(
          '.vs__selected, [aria-selected="true"], .selected, .active'
        )
      ).map(node =>
        String(node.innerText || node.textContent || "")
          .replace(/\s+/g, " ")
          .trim()
      ).filter(Boolean);

      return {
        text: String(el.innerText || el.textContent || "")
          .replace(/\s+/g, " ")
          .trim(),
        allInputs,
        selectedLike
      };
    });

    console.log(
      "Fieldworker search value:",
      JSON.stringify(fieldworkerSearchValue)
    );

    console.log(
      "First appointment fieldworker DOM state:",
      JSON.stringify(fieldworkerDomState)
    );

    // Do not abort here based only on visible text. The Octopus component may keep
    // the selected worker in Vue state without rendering the name in this container.
    // The final Save validation below is the authoritative test.
    console.log("Fieldworker selection attempt completed.");

    console.log("Re-applying appointment after fieldworker render...");

    const liveFirstAppointment = page.locator('[id^="booking_visits_"]').first();

    const liveStartDate = liveFirstAppointment.locator(
      'input[name^="multi_new_stpartdate_"]'
    ).first();

    const liveStartTime = liveFirstAppointment.locator(
      'input[name^="multi_new_stparttime_"]'
    ).first();

    const liveEndDate = liveFirstAppointment.locator(
      'input[name^="multi_new_etpartdate_"]'
    ).first();

    const liveEndTime = liveFirstAppointment.locator(
      'input[name^="multi_new_etparttime_"]'
    ).first();

    await setFirstAppointmentValue(liveStartDate, "Tuesday, 25 August 2026");
    await setFirstAppointmentValue(liveStartTime, "10:00 AM");
    await setFirstAppointmentValue(liveEndDate, "Tuesday, 25 August 2026");
    await setFirstAppointmentValue(liveEndTime, "12:00 PM");

    await page.waitForTimeout(500);

    const finalAppointmentState = {
      startDate: await liveStartDate.inputValue(),
      startTime: await liveStartTime.inputValue(),
      endDate: await liveEndDate.inputValue(),
      endTime: await liveEndTime.inputValue(),
      fieldworkerId: await liveFirstAppointment
        .locator('input[name^="contractor_"]')
        .first()
        .inputValue()
        .catch(() => "")
    };

    console.log(
      "FINAL appointment + fieldworker state:",
      JSON.stringify(finalAppointmentState)
    );

    if (
      finalAppointmentState.startDate !== "Tuesday, 25 August 2026" ||
      finalAppointmentState.startTime !== "10:00 AM" ||
      finalAppointmentState.endDate !== "Tuesday, 25 August 2026" ||
      finalAppointmentState.endTime !== "12:00 PM"
    ) {
      throw new Error(
        `FINAL_APPOINTMENT_NOT_STICKING: ${JSON.stringify(finalAppointmentState)}`
      );
    }

    if (!finalAppointmentState.fieldworkerId) {
      throw new Error(
        `FIELDWORKER_ID_MISSING: ${JSON.stringify(finalAppointmentState)}`
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
    console.log("LOCATION + SERVICE + SCHEDULE VALIDATED.");
    // Octopus re-renders the appointment while editing the service.
    // Re-apply the requested date/time immediately before Save.
    console.log("FINAL PRE-SAVE DATE/TIME FORCE...");

    const finalAppointment = page.locator('[id^="booking_visits_"]').first();

    async function finalSet(prefix, value) {
      const loc = finalAppointment.locator(`input[name^="${prefix}"]`).first();
      await loc.waitFor({ state: "attached", timeout: 10000 });

      await loc.evaluate((el, nextValue) => {
        const proto = Object.getPrototypeOf(el);
        const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;

        if (setter) setter.call(el, nextValue);
        else el.value = nextValue;

        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
        el.dispatchEvent(new Event("blur", { bubbles: true }));
      }, value);

      return loc;
    }

    const finalStartDate = await finalSet(
      "multi_new_stpartdate_",
      "Tuesday, 25 August 2026"
    );
    const finalStartTime = await finalSet(
      "multi_new_stparttime_",
      "10:00 AM"
    );
    const finalEndDate = await finalSet(
      "multi_new_etpartdate_",
      "Tuesday, 25 August 2026"
    );
    const finalEndTime = await finalSet(
      "multi_new_etparttime_",
      "12:00 PM"
    );

    await page.waitForTimeout(500);

    console.log(
      "FINAL PRE-SAVE DATE/TIME:",
      JSON.stringify({
        startDate: await finalStartDate.inputValue(),
        startTime: await finalStartTime.inputValue(),
        endDate: await finalEndDate.inputValue(),
        endTime: await finalEndTime.inputValue()
      })
    );

    // Click One Time one more time right before Save, because it is the ONLY mode.
    const finalOneTimeText = page.getByText("One Time Cleaning", {
      exact: true
    });

    for (let i = 0; i < await finalOneTimeText.count(); i++) {
      const node = finalOneTimeText.nth(i);
      if (!(await node.isVisible().catch(() => false))) continue;

      console.log("FINAL One Time click immediately before Save...");
      await node.scrollIntoViewIfNeeded().catch(() => {});
      await node.click({ force: true, timeout: 10000 });
      await page.waitForTimeout(700);
      break;
    }

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

    // Manual Octopus behavior: Save creates the booking first, then opens
    // a "Notify Customer" modal. That modal is NOT required to create the BOK.
    await Promise.race([
      page.waitForURL(/\/booking\/view\/\d+/i, { timeout: 12000 }).catch(() => null),
      page.getByText("Notify Customer", { exact: true })
        .waitFor({ state: "visible", timeout: 12000 })
        .catch(() => null),
      page.waitForTimeout(12000)
    ]);

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
        `BOOKING_NOT_CREATED: ${JSON.stringify(saveDiagnostics.visibleAlerts)}`
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