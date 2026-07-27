async function loginToOctopus(page) {
  console.log("Logging into OctopusPro...");

  await page.goto("https://admin.octopuspro.com/login", {
    waitUntil: "domcontentloaded",
    timeout: 60000
  });

  const emailInput = page.locator(
    'input[type="email"], input[name="email"], input[name="username"], #email'
  ).first();

  const passwordInput = page.locator(
    'input[type="password"], input[name="password"], #password'
  ).first();

  await emailInput.waitFor({
    state: "visible",
    timeout: 30000
  });

  await emailInput.fill(OCTOPUS_EMAIL);
  await passwordInput.fill(OCTOPUS_PASSWORD);

  const submitButton = page.locator(
    'button[type="submit"], input[type="submit"]'
  ).first();

  await submitButton.click();

  await page.waitForURL(
    url => !url.toString().includes("/login"),
    { timeout: 60000 }
  );

  await page.waitForLoadState("domcontentloaded");
  await page.waitForTimeout(3000);

  console.log("URL after login:", page.url());

  if (page.url().toLowerCase().includes("/login")) {
    throw new Error("OctopusPro login failed or returned to the login page.");
  }

  console.log("OctopusPro login successful.");
}
