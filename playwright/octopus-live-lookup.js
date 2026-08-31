import { chromium } from 'playwright';

const OCTOPUS_EMAIL = String(process.env.OCTOPUS_EMAIL || '').trim();
const OCTOPUS_PASSWORD = String(process.env.OCTOPUS_PASSWORD || '').trim();
const NOTIFICATIONS_URL = String(
  process.env.OCTOPUS_NOTIFICATIONS_URL || 'https://admin.octopuspro.com/notifications'
).trim();

function clean(value) {
  return String(value ?? '').trim();
}

function normalizePhone(value) {
  const digits = clean(value).replace(/\D/g, '');
  return digits.length >= 10 ? digits.slice(-10) : digits;
}

function parsePayload() {
  try {
    return JSON.parse(process.env.LISA_LOOKUP_PAYLOAD || '{}');
  } catch {
    return {};
  }
}

async function selectOrganization(page) {
  const speedycleans = page.getByText(/SpeedyCleans/i).first();
  if (await speedycleans.isVisible().catch(() => false)) {
    await speedycleans.click().catch(() => {});
    await page.waitForTimeout(3000);
  }
}

async function login(page) {
  if (!OCTOPUS_EMAIL || !OCTOPUS_PASSWORD) {
    throw new Error('OCTOPUS_EMAIL or OCTOPUS_PASSWORD is missing');
  }

  await page.goto('https://admin.octopuspro.com/login', {
    waitUntil: 'domcontentloaded',
    timeout: 60000
  });

  const email = page.locator(
    'input[type="email"], input[name="email"], input[name="username"], #email'
  ).first();
  const password = page.locator(
    'input[type="password"], input[name="password"], #password'
  ).first();

  await email.waitFor({ state: 'visible', timeout: 30000 });
  await email.fill(OCTOPUS_EMAIL);
  await password.fill(OCTOPUS_PASSWORD);
  await page.locator('button[type="submit"], input[type="submit"]').first().click();
  await page.waitForTimeout(4000);

  if (page.url().toLowerCase().includes('/checkuserinmulticompanies')) {
    await selectOrganization(page);
  }

  if (page.url().toLowerCase().includes('/login')) {
    throw new Error('OctopusPro login did not complete');
  }
}

function scopeAllows(text, scope) {
  const s = clean(scope).toLowerCase();
  if (!s || s === 'all' || s === 'upcoming') return true;
  const lower = text.toLowerCase();
  const today = new Date();
  const tomorrow = new Date(today.getTime() + 86400000);
  const isoToday = today.toISOString().slice(0, 10);
  const isoTomorrow = tomorrow.toISOString().slice(0, 10);

  if (s === 'today') return lower.includes(isoToday);
  if (s === 'tomorrow') return lower.includes(isoTomorrow);
  return true;
}

async function collectBookingLinks(page, payload) {
  const bookingNumber = clean(payload.bookingNumber || payload.booking_number).toUpperCase();
  const phone = normalizePhone(payload.phone || payload.customerPhone);
  const email = clean(payload.email || payload.customerEmail).toLowerCase();
  const customerName = clean(payload.customerName).toLowerCase();
  const requestedDate = clean(payload.requestedDate || payload.date);
  const scope = clean(payload.scope || 'all');

  const links = page.locator('a[href*="/booking/view/"]');
  const count = await links.count().catch(() => 0);
  const matches = [];

  for (let i = 0; i < count; i += 1) {
    const link = links.nth(i);
    const href = await link.getAttribute('href').catch(() => '');
    if (!href) continue;

    const row = link.locator('xpath=ancestor::tr[1]');
    let text = '';
    if (await row.count().catch(() => 0)) {
      text = await row.innerText().catch(() => '');
    }
    if (!text) {
      text = await link.locator('xpath=ancestor::*[self::div or self::li or self::article][1]').innerText().catch(() => '');
    }
    if (!text) text = await link.innerText().catch(() => '');

    const normalizedTextDigits = text.replace(/\D/g, '');
    const lower = text.toLowerCase();

    let score = 0;
    if (bookingNumber && lower.includes(bookingNumber.toLowerCase())) score += 100;
    if (phone && normalizedTextDigits.includes(phone)) score += 40;
    if (email && lower.includes(email)) score += 35;
    if (customerName && lower.includes(customerName)) score += 25;
    if (requestedDate && lower.includes(requestedDate.toLowerCase())) score += 20;

    if (bookingNumber && score < 100) continue;
    if (!bookingNumber && score === 0) continue;
    if (!scopeAllows(text, scope)) continue;

    const idMatch = href.match(/\/booking\/view\/(\d+)/i);
    const bokMatch = text.match(/BOK-\d+/i);

    matches.push({
      bookingId: idMatch ? Number(idMatch[1]) : null,
      bookingNumber: bokMatch ? bokMatch[0].toUpperCase() : bookingNumber || null,
      bookingUrl: href.startsWith('http') ? href : `https://admin.octopuspro.com${href}`,
      rawText: text.trim().slice(0, 2500),
      score
    });
  }

  return matches.sort((a, b) => b.score - a.score);
}

async function searchPage(page, url, payload) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(2500);

  if (page.url().toLowerCase().includes('/login')) {
    await login(page);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    await page.waitForTimeout(2500);
  }

  const terms = [
    payload.bookingNumber,
    payload.booking_number,
    payload.phone,
    payload.customerPhone,
    payload.email,
    payload.customerEmail,
    payload.customerName
  ].map(clean).filter(Boolean);

  const search = page.locator(
    'input[type="search"], input[placeholder*="search" i], input[name*="search" i], input[id*="search" i]'
  ).first();

  if (terms.length && await search.isVisible().catch(() => false)) {
    for (const term of terms) {
      await search.fill(term).catch(() => {});
      await search.press('Enter').catch(() => {});
      await page.waitForTimeout(1500);
      const matches = await collectBookingLinks(page, payload);
      if (matches.length) return matches;
    }
  }

  return collectBookingLinks(page, payload);
}

async function enrichBooking(page, match) {
  if (!match?.bookingUrl) return match;
  await page.goto(match.bookingUrl, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(1800);
  const body = await page.locator('body').innerText().catch(() => match.rawText || '');
  const bokMatch = body.match(/BOK-\d+/i);
  const statusMatch = body.match(/\b(Upcoming|Completed|Cancelled|Canceled|Arrived|Started|En Route|On Hold|Running Late)\b/i);
  return {
    ...match,
    bookingNumber: bokMatch ? bokMatch[0].toUpperCase() : match.bookingNumber,
    status: statusMatch ? statusMatch[1] : null,
    detailsText: body.trim().slice(0, 5000)
  };
}

async function main() {
  const payload = parsePayload();
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
  });

  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const page = await context.newPage();
    await login(page);

    const candidateUrls = [
      NOTIFICATIONS_URL,
      'https://admin.octopuspro.com/booking',
      'https://admin.octopuspro.com/bookings',
      'https://admin.octopuspro.com/booking/index'
    ];

    let matches = [];
    for (const url of candidateUrls) {
      matches = await searchPage(page, url, payload).catch(() => []);
      if (matches.length) break;
    }

    if (!matches.length) {
      console.log('LISA_LOOKUP_RESULT=' + JSON.stringify({
        success: true,
        found: false,
        source: 'octopus_live',
        bookings: [],
        reason: 'No live Octopus booking matched the supplied criteria.'
      }));
      return;
    }

    const enriched = [];
    for (const match of matches.slice(0, Math.max(1, Math.min(Number(payload.limit || 10), 10)))) {
      enriched.push(await enrichBooking(page, match));
    }

    console.log('LISA_LOOKUP_RESULT=' + JSON.stringify({
      success: true,
      found: enriched.length > 0,
      source: 'octopus_live',
      booking: enriched.length === 1 ? enriched[0] : null,
      bookings: enriched,
      count: enriched.length
    }));
  } catch (error) {
    console.log('LISA_LOOKUP_RESULT=' + JSON.stringify({
      success: false,
      found: false,
      source: 'octopus_live',
      error: error?.message || String(error)
    }));
  } finally {
    await browser.close().catch(() => {});
  }
}

await main();
