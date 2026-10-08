import test from 'node:test';
import assert from 'node:assert/strict';
import { loginMigrationSession } from '../playwright/octopus-admin-login.mjs';
function fakeLoginPage({ organization = false, fieldworkerOnly = false } = {}) {
  let state = 'new'; const actions = [];
  const url = () => 'https://admin.octopuspro.com/' + (state === 'organization' ? 'login' : state === 'dashboard' ? 'dashboard' : 'login');
  const locator = selector => ({
    first() { return this; },
    waitFor: async () => {},
    fill: async value => { actions.push({ action: 'fill', field: selector.includes('password') ? 'password' : 'email', value }); },
    isVisible: async () => selector.includes('password') || selector.includes('email') ? state === 'login' : selector.includes('remember') ? false : selector.includes('submit'),
    click: async () => { actions.push({ action: 'submit' }); state = state === 'login' && organization ? 'organization' : 'dashboard'; },
    check: async () => {},
    count: async () => selector === 'select' && state === 'organization' ? 2 : 0,
    nth: index => ({ isVisible: async () => state === 'organization', locator: () => ({ allTextContents: async () => index === 0 ? ['Choose company', 'SpeedyCleans'] : fieldworkerOnly ? ['Fieldworker'] : ['Fieldworker', 'Account Admin'] }), selectOption: async ({ label }) => { actions.push({ action: 'select', label }); } })
  });
  return { actions, goto: async destination => { actions.push({ action: 'goto', destination }); state = 'login'; }, locator, url, waitForLoadState: async () => {}, waitForURL: async predicate => { assert.equal(predicate(new URL(url())), true); }, getByRole: role => role === 'heading' ? { isVisible: async () => state === 'organization' } : locator('submit'), getByText: label => ({ first() { return this; }, isVisible: async () => state === 'organization' && label === 'Fieldworker', click: async () => assert.fail('unexpected role text click') }) };
}

test('export login submits the real login form and chooses an existing admin role only', async () => {
  for (const organization of [false, true]) {
    const page = fakeLoginPage({ organization }); const stages = [];
    await loginMigrationSession(page, { email: 'test@example.invalid', password: 'TEST_ONLY', organizationName: 'SpeedyCleans', onStage: async stage => stages.push(stage) });
    assert.equal(page.actions[0].destination, 'https://admin.octopuspro.com/login');
    assert.deepEqual(page.actions.filter(a => a.action === 'fill').map(a => a.field), ['email', 'password']);
    assert.equal(stages.at(-1), 'login_destination_verification');
    if (organization) assert.deepEqual(page.actions.filter(a => a.action === 'select').map(a => a.label), ['SpeedyCleans', 'Account Admin']);
    assert.ok(!page.actions.some(a => a.label === 'Fieldworker'));
  }
  const restricted = fakeLoginPage({ organization: true, fieldworkerOnly: true });
  await assert.rejects(loginMigrationSession(restricted, { email: 'test@example.invalid', password: 'TEST_ONLY', organizationName: 'SpeedyCleans' }), /export_admin_role_unavailable/);
  assert.equal(restricted.actions.filter(a => a.action === 'submit').length, 1);
});
