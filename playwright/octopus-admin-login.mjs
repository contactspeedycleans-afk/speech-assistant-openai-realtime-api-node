const ADMIN = 'https://admin.octopuspro.com';
const isLogin = url => /\/login(?:\/|$)/i.test(url.pathname) || url.searchParams.get('logout') === '1';
const isOrganization = url => /checkuserinmulticompanies/i.test(url.pathname);
const adminRole = value => /^(?:(?:account|company|super)\s*)?admin(?:istrator)?$|^owner$/i.test(String(value).trim());

// This is deliberately separate from the watcher's notification login helper,
// whose role chooser selects Fieldworker. Export needs existing admin access;
// it never changes permissions or prints form contents, URLs or credentials.
export async function loginMigrationSession(page, { email, password, organizationName, onStage = async () => {} }) {
  if (!email || !password || !organizationName) throw Error('export_login_configuration_missing');
  await onStage('login_form_navigation');
  await page.goto(`${ADMIN}/login`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  const emailInput = page.locator('input[type="email"], input[name="email"], input[name="username"], #email').first();
  const passwordInput = page.locator('input[type="password"], input[name="password"], #password').first();
  await emailInput.waitFor({ state: 'visible', timeout: 30000 });
  await passwordInput.waitFor({ state: 'visible', timeout: 30000 });
  await emailInput.fill(email);
  await passwordInput.fill(password);
  const remember = page.locator('input[type="checkbox"][name*="remember"]').first();
  if (await remember.isVisible().catch(() => false)) await remember.check();
  const submit = page.locator('button[type="submit"], input[type="submit"]').first();
  await submit.waitFor({ state: 'visible', timeout: 30000 });

  // The workspace chooser can remain under /login. Detect its visible controls
  // rather than waiting for a URL that only changes after Continue is pressed.
  const waitForLoginStep = async ({ allowChooser }) => {
    const deadline = Date.now() + 180000;
    while (Date.now() < deadline) {
      await page.waitForLoadState('domcontentloaded');
      const current = new URL(page.url());
      if (current.origin === ADMIN) {
        const chooserHeading = page.getByRole('heading', { name: 'Select your organization and role', exact: true });
        const selects = page.locator('select');
        let organizationOptionVisible = false;
        for (let i = 0; i < await selects.count(); i++) {
          const select = selects.nth(i);
          if (await select.isVisible().catch(() => false)) {
            const options = await select.locator('option').allTextContents();
            if (options.some(value => value.trim().toLowerCase() === organizationName.trim().toLowerCase())) organizationOptionVisible = true;
          }
        }
        const chooserVisible = isOrganization(current) || await chooserHeading.isVisible().catch(() => false) || organizationOptionVisible;
        if (allowChooser && chooserVisible) return true;
        const passwordVisible = await passwordInput.isVisible().catch(() => false);
        if (!chooserVisible && !isLogin(current) && !/panel-first-login/i.test(current.pathname) && !passwordVisible) return false;
      }
      await page.waitForTimeout(250);
    }
    const current = new URL(page.url());
    console.error('OCTOPUS_LOGIN_STEP_TIMEOUT', JSON.stringify({
      stage: allowChooser ? 'after_login_submit' : 'after_workspace_continue',
      loginPath: isLogin(current),
      legacyOrganizationPath: isOrganization(current),
      passwordFieldVisible: await passwordInput.isVisible().catch(() => false),
      organizationChooserVisible: await page.getByRole('heading', { name: 'Select your organization and role', exact: true }).isVisible().catch(() => false)
    }));
    throw Error('octopus_login_step_timeout_180000');
  };

  await onStage('login_form_submit');
  await submit.click();
  const organizationRequired = await waitForLoginStep({ allowChooser: true });

  if (organizationRequired) {
    await onStage('organization_selection');
    const selects = page.locator('select');
    let selectedOrganization = false;
    for (let i = 0; i < await selects.count(); i++) {
      const select = selects.nth(i);
      const options = await select.locator('option').allTextContents();
      const exact = options.filter(value => value.trim().toLowerCase() === organizationName.trim().toLowerCase());
      if (exact.length === 1) { await select.selectOption({ label: exact[0].trim() }); selectedOrganization = true; break; }
    }
    if (!selectedOrganization) {
      const organization = page.getByText(organizationName, { exact: true }).first();
      if (!await organization.isVisible().catch(() => false)) throw Error('export_organization_unavailable');
      await organization.click();
    }
    // Some accounts expose roles as a select, others as labeled buttons/text.
    // Choose only an explicitly offered admin role; never choose Fieldworker.
    let selectedAdmin = false;
    for (let i = 0; i < await selects.count(); i++) {
      const select = selects.nth(i);
      const roles = (await select.locator('option').allTextContents()).filter(adminRole);
      if (roles.length === 1) { await select.selectOption({ label: roles[0].trim() }); selectedAdmin = true; break; }
    }
    if (!selectedAdmin) {
      const role = page.getByText(/^(?:(?:account|company|super)\s*)?admin(?:istrator)?$|^owner$/i).first();
      if (await role.isVisible().catch(() => false)) { await role.click(); selectedAdmin = true; }
    }
    // A notice about a separate Fieldworker account is not the selected role.
    // Explicit Fieldworker-only role options still fail closed.
    if (!selectedAdmin) {
      for (let i = 0; i < await selects.count(); i++) {
        const options = await selects.nth(i).locator('option').allTextContents();
        if (options.some(value => /^fieldworker$/i.test(value.trim()))) throw Error('export_admin_role_unavailable');
      }
    }
    {
      const candidates = [page.locator('button[type="submit"], input[type="submit"]').first(), page.getByRole('button', { name: /^(?:continue|select|login|log in|submit|go)$/i }).first()];
      let submitted = false;
      for (const button of candidates) if (await button.isVisible().catch(() => false)) { await button.click(); submitted = true; break; }
      if (!submitted) throw Error('export_organization_submit_unavailable');
    }
    await waitForLoginStep({ allowChooser: false });
  }
  await onStage('login_destination_verification');
  const destination = new URL(page.url());
  if (destination.origin !== ADMIN || isLogin(destination) || isOrganization(destination) || await passwordInput.isVisible().catch(() => false)) throw Error('export_login_not_authenticated');
}
