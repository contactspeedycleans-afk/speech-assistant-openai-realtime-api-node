import { chromium } from 'playwright';

const OCTOPUS_EMAIL = String(process.env.OCTOPUS_EMAIL || '').trim();
const OCTOPUS_PASSWORD = String(process.env.OCTOPUS_PASSWORD || '').trim();
const NOTIFICATIONS_URL = String(process.env.OCTOPUS_NOTIFICATIONS_URL || 'https://admin.octopuspro.com/notifications').trim();
const BASE = 'https://admin.octopuspro.com';

const clean = (v) => String(v ?? '').trim();
const digits = (v) => clean(v).replace(/\D/g, '');
const normalizePhone = (v) => { const d = digits(v); return d.length >= 10 ? d.slice(-10) : d; };
const normalizeBok = (v) => { const d = digits(v); return d ? `BOK-${d}` : clean(v).toUpperCase(); };

function parsePayload() {
  try { return JSON.parse(process.env.LISA_LOOKUP_PAYLOAD || '{}'); }
  catch { return {}; }
}

function localDateParts(offsetDays = 0) {
  const now = new Date(Date.now() + offsetDays * 86400000);
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Detroit', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(now).reduce((a, p) => (a[p.type] = p.value, a), {});
}

function isoDetroit(offsetDays = 0) {
  const p = localDateParts(offsetDays);
  return `${p.year}-${p.month}-${p.day}`;
}

function parseDateFromText(text) {
  const s = clean(text);
  let m = s.match(/\b(20\d{2})[-\/]([01]?\d)[-\/]([0-3]?\d)\b/);
  if (m) return `${m[1]}-${String(m[2]).padStart(2,'0')}-${String(m[3]).padStart(2,'0')}`;
  m = s.match(/\b([01]?\d)[\/]([0-3]?\d)[\/](20\d{2})\b/);
  if (m) return `${m[3]}-${String(m[1]).padStart(2,'0')}-${String(m[2]).padStart(2,'0')}`;
  const month = '(January|February|March|April|May|June|July|August|September|October|November|December)';
  m = s.match(new RegExp(`\\b${month}\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,)?\\s+(20\\d{2})\\b`, 'i'));
  if (m) {
    const n = new Date(`${m[1]} 1, 2000`).getMonth() + 1;
    return `${m[3]}-${String(n).padStart(2,'0')}-${String(m[2]).padStart(2,'0')}`;
  }
  return null;
}

function dateAllowed(iso, scope, requestedDate) {
  if (requestedDate) {
    const wanted = parseDateFromText(requestedDate) || clean(requestedDate).slice(0,10);
    if (iso && wanted && iso !== wanted) return false;
  }
  if (!iso) return true;
  const today = isoDetroit(0);
  const s = clean(scope).toLowerCase();
  if (s === 'today') return iso === today;
  if (s === 'tomorrow') return iso === isoDetroit(1);
  if (s === 'future') return iso > today;
  if (s === 'upcoming') return iso >= today;
  if (s === 'past' || s === 'history') return iso < today;
  return true;
}

async function selectOrganization(page) {
  const org = page.getByText(/SpeedyCleans/i).first();
  if (await org.isVisible().catch(() => false)) { await org.click().catch(() => {}); await page.waitForTimeout(2500); }
}

async function login(page) {
  if (!OCTOPUS_EMAIL || !OCTOPUS_PASSWORD) throw new Error('OCTOPUS_EMAIL or OCTOPUS_PASSWORD is missing');
  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  const email = page.locator('input[type="email"], input[name="email"], input[name="username"], #email').first();
  const password = page.locator('input[type="password"], input[name="password"], #password').first();
  await email.waitFor({ state: 'visible', timeout: 30000 });
  await email.fill(OCTOPUS_EMAIL); await password.fill(OCTOPUS_PASSWORD);
  await page.locator('button[type="submit"], input[type="submit"]').first().click();
  await page.waitForTimeout(3500);
  if (page.url().toLowerCase().includes('/checkuserinmulticompanies')) await selectOrganization(page);
  if (page.url().toLowerCase().includes('/login')) throw new Error('OctopusPro login did not complete');
}

function criteria(payload) {
  return {
    bookingNumber: normalizeBok(payload.bookingNumber || payload.booking_number),
    bookingId: Number(String(payload.bookingId || payload.octopusBookingId || payload.octopus_booking_id || '').replace(/\D/g,'')) || null,
    phone: normalizePhone(payload.phone || payload.customerPhone),
    email: clean(payload.email || payload.customerEmail).toLowerCase(),
    customerName: clean(payload.customerName).toLowerCase(),
    requestedDate: clean(payload.requestedDate || payload.date),
    scope: clean(payload.scope || 'all').toLowerCase(),
    limit: Math.max(1, Math.min(Number(payload.limit || 10), 10))
  };
}

function scoreText(text, c) {
  const lower = text.toLowerCase(); const d = text.replace(/\D/g, '');
  let score = 0;
  if (c.bookingNumber && lower.includes(c.bookingNumber.toLowerCase())) score += 1000;
  if (c.phone && d.includes(c.phone)) score += 100;
  if (c.email && lower.includes(c.email)) score += 80;
  if (c.customerName && lower.includes(c.customerName)) score += 60;
  if (c.requestedDate && lower.includes(c.requestedDate.toLowerCase())) score += 40;
  return score;
}

async function bookingLinksOnPage(page, c) {
  const links = page.locator('a[href*="/booking/view/"]');
  const count = Math.min(await links.count().catch(() => 0), 500);
  const out = [];
  for (let i=0; i<count; i++) {
    const link = links.nth(i); const href = await link.getAttribute('href').catch(() => '');
    if (!href) continue;
    let text = '';
    for (const xp of ['xpath=ancestor::tr[1]','xpath=ancestor::*[self::div or self::li or self::article][1]']) {
      text = await link.locator(xp).innerText().catch(() => ''); if (text) break;
    }
    if (!text) text = await link.innerText().catch(() => '');
    const score = scoreText(text, c);
    if (c.bookingNumber && score < 1000) continue;
    if (!c.bookingNumber && score === 0) continue;
    const date = parseDateFromText(text);
    if (!dateAllowed(date, c.scope, c.requestedDate)) continue;
    const id = href.match(/\/booking\/view\/(\d+)/i)?.[1] || null;
    const bok = text.match(/BOK-\d+/i)?.[0]?.toUpperCase() || c.bookingNumber || null;
    out.push({ bookingId: id ? Number(id) : null, bookingNumber: bok, bookingUrl: href.startsWith('http') ? href : `${BASE}${href}`, date, rawText: text.trim().slice(0,3000), score });
  }
  return out;
}

async function trySearchInputs(page, terms, c) {
  const inputs = page.locator('input[type="search"], input[placeholder*="search" i], input[name*="search" i], input[id*="search" i]');
  const n = Math.min(await inputs.count().catch(() => 0), 8);
  for (let i=0; i<n; i++) {
    const input = inputs.nth(i);
    if (!await input.isVisible().catch(() => false)) continue;
    for (const term of terms) {
      await input.fill('').catch(() => {}); await input.fill(term).catch(() => {});
      await input.press('Enter').catch(() => {}); await page.waitForTimeout(1800);
      const m = await bookingLinksOnPage(page,c); if (m.length) return m;
    }
  }
  return [];
}

async function scanPages(page, c, maxPages=8) {
  const found = [];
  for (let p=0; p<maxPages; p++) {
    found.push(...await bookingLinksOnPage(page,c));
    if (found.length && c.bookingNumber) break;
    const next = page.locator('a[rel="next"], .pagination a:has-text("Next"), button:has-text("Next")').first();
    if (!await next.isVisible().catch(() => false) || await next.isDisabled().catch(() => false)) break;
    const before = page.url(); await next.click().catch(() => {}); await page.waitForTimeout(1600);
    if (page.url() === before && p > 0) break;
  }
  return found;
}

async function searchUrl(page, url, c, terms) {
  await page.goto(url,{waitUntil:'domcontentloaded',timeout:60000}).catch(()=>{}); await page.waitForTimeout(1800);
  if (page.url().toLowerCase().includes('/login')) { await login(page); await page.goto(url,{waitUntil:'domcontentloaded',timeout:60000}).catch(()=>{}); await page.waitForTimeout(1800); }
  let m = await trySearchInputs(page,terms,c); if (m.length) return m;
  return scanPages(page,c);
}

async function enrich(page, m) {
  await page.goto(m.bookingUrl,{waitUntil:'domcontentloaded',timeout:60000}).catch(()=>{}); await page.waitForTimeout(1200);
  const body = await page.locator('body').innerText().catch(()=>m.rawText||'');
  const bookingNumber = body.match(/BOK-\d+/i)?.[0]?.toUpperCase() || m.bookingNumber;
  const status = body.match(/\b(To\s*Do|TODO|Upcoming|Completed|Finished|Cancelled|Canceled|Assigned|Arrived|Started|In Progress|En Route|On The Way|On Hold|Running Late|Needs Cleaner)\b/i)?.[1] || null;
  const date = parseDateFromText(body) || m.date || null;
  return {...m, bookingNumber, status, date, detailsText: body.trim().slice(0,6000)};
}

async function main() {
  const payload=parsePayload(), c=criteria(payload);
  console.log('LISA_LOOKUP_DEBUG=' + JSON.stringify({bookingNumber:c.bookingNumber||null,bookingId:c.bookingId||null,phone:c.phone||null,customerName:c.customerName||null,requestedDate:c.requestedDate||null,scope:c.scope}));
  const browser=await chromium.launch({headless:true,args:['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage']});
  try {
    const context=await browser.newContext({viewport:{width:1440,height:1000}}); const page=await context.newPage(); await login(page);
    const terms=[c.bookingNumber, digits(c.bookingNumber), c.phone, c.email, c.customerName].filter(Boolean);
    const urls=[`${BASE}/booking`,`${BASE}/bookings`,`${BASE}/booking/index`,NOTIFICATIONS_URL];
    let matches=[];

    // FAST EXACT PATH: when watcher/Postgres supplies the numeric Octopus booking
    // ID, open the booking directly. This avoids slow list-page crawling and makes
    // a BOK Lisa just created readable immediately.
    if (c.bookingId) {
      const directUrl = `${BASE}/booking/view/${c.bookingId}`;
      await page.goto(directUrl,{waitUntil:'domcontentloaded',timeout:60000}).catch(()=>{});
      if (page.url().toLowerCase().includes('/login')) {
        await login(page);
        await page.goto(directUrl,{waitUntil:'domcontentloaded',timeout:60000}).catch(()=>{});
      }
      await page.waitForTimeout(900);
      const bodyText = await page.locator('body').innerText().catch(()=> '');
      const pageBok = bodyText.match(/BOK-\d+/i)?.[0]?.toUpperCase() || c.bookingNumber || null;
      if (!c.bookingNumber || pageBok === c.bookingNumber) {
        matches=[{
          bookingId:c.bookingId,
          bookingNumber:pageBok,
          bookingUrl:directUrl,
          date:parseDateFromText(bodyText),
          rawText:bodyText.trim().slice(0,3000),
          score:2000
        }];
      }
    }

    if (!matches.length) {
      for (const url of urls) {
        matches=await searchUrl(page,url,c,terms).catch(()=>[]);
        if(matches.length) break;
      }
    }
    const unique=[...new Map(matches.map(x=>[x.bookingUrl,x])).values()].sort((a,b)=>b.score-a.score);
    const enriched=[];
    for(const m of unique.slice(0,c.limit)) { const e=await enrich(page,m); if(dateAllowed(e.date,c.scope,c.requestedDate)) enriched.push(e); }
    enriched.sort((a,b)=>{
      if (c.scope==='future'||c.scope==='upcoming'||c.scope==='today'||c.scope==='tomorrow') return clean(a.date).localeCompare(clean(b.date));
      if (c.scope==='past'||c.scope==='history') return clean(b.date).localeCompare(clean(a.date));
      return b.score-a.score;
    });
    if(!enriched.length) {
      console.log('LISA_LOOKUP_RESULT='+JSON.stringify({success:true,found:false,source:'octopus_live',booking:null,bookings:[],count:0,criteria:{bookingNumber:c.bookingNumber||null,scope:c.scope},reason:c.bookingNumber?'Exact booking number was not found in live Octopus search.':'No live Octopus booking matched the supplied criteria.'})); return;
    }
    console.log('LISA_LOOKUP_RESULT='+JSON.stringify({success:true,found:true,source:'octopus_live',booking:enriched.length===1?enriched[0]:enriched[0],bookings:enriched,count:enriched.length,criteria:{bookingNumber:c.bookingNumber||null,scope:c.scope}}));
  } catch(error) {
    console.log('LISA_LOOKUP_RESULT='+JSON.stringify({success:false,found:false,source:'octopus_live',booking:null,bookings:[],error:error?.message||String(error)}));
  } finally { await browser.close().catch(()=>{}); }
}
await main();
