export async function selectBookingWorker(page, appointment, desiredWorker) {
  const search = appointment.locator('input[placeholder="Select Fieldworker"]').first();
  await search.waitFor({ state: "visible", timeout: 10000 });
  await search.fill(desiredWorker);

  const escapedWorker = [...desiredWorker]
    .map(char => "\\^$.*+?()[]{}|".includes(char) ? `\\\\${char}` : char)
    .join("");
  const optionName = new RegExp(`^${escapedWorker}(?:\\s|\\(|$)`, "i");
  const deadline = Date.now() + 12000;

  while (Date.now() < deadline) {
    await page.waitForTimeout(300);
    const option = page
      .getByRole("option", { name: optionName })
      .filter({ visible: true })
      .first();

    if (!(await option.isVisible().catch(() => false))) continue;
    try {
      await option.click({ force: true, timeout: 3000 });
    } catch {
      continue;
    }

    await page.waitForTimeout(300);
    if (!(await search.isVisible().catch(() => false))) return;
  }

  throw new Error(`FIELDWORKER_OPTION_NOT_FOUND: ${desiredWorker}`);
}
