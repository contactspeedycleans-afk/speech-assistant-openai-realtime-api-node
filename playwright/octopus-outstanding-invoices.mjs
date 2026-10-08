// Read-only ledger export. These two GET routes and their paginator were
// observed in SpeedyCleans' native Outstanding invoice list on 2026-10-08.
const ADMIN = 'https://admin.octopuspro.com';
const API = 'https://api.octopuspro.com';
const INVOICES = '/api/v2/invoices';
const STATS = '/api/v2/invoices/statistics';
const COMPANY = 18884;
const number = value => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value)) ? Number(value) : null;
const id = value => /^[1-9]\d*$/.test(String(value)) ? String(value) : null;
export function invoiceRecord(row) {
  const b = row?.booking;
  if (!id(row?.id) || !id(row?.booking_id) || Number(row.booking_invoice_company_id) !== COMPANY ||
      !b || Number(b.company_id) !== COMPANY || String(b.booking_id) !== String(row.booking_id)) throw Error('invoice_tenant_or_identity_mismatch');
  const c = b.customer;
  if (c && (Number(c.company_id) !== COMPANY || String(c.customer_id) !== String(b.customer_id))) throw Error('invoice_customer_identity_mismatch');
  return {
    invoiceId: String(row.id), invoiceNumber: String(row.invoice_num || ''), ledger: 'Outstanding',
    invoiceType: String(row.invoice_type || ''), emailSent: row.email_sent === 1 || row.email_sent === '1',
    invoiceCreatedEpoch: number(row.created), customDueDate: row.custom_due_date ?? null,
    customDueDateType: row.custom_due_date_type ?? null,
    bookingId: String(b.booking_id), bookingNumber: String(b.booking_num || ''),
    bookingStatus: String(b.status?.name || ''), customerId: c ? String(c.customer_id) : String(b.customer_id || ''),
    customerName: c ? [c.first_name, c.last_name].filter(Boolean).join(' ') : '',
    customerEmails: c ? [...new Set([c.email1,c.email2,c.email3].filter(Boolean))] : [],
    customerPhones: c ? [...new Set([c.mobile1,c.mobile2,c.mobile3,c.phone1,c.phone2,c.phone3].filter(Boolean))] : [],
    serviceStartSource: b.booking_start ?? null, serviceEndSource: b.booking_end ?? null,
    timezone: b.timezone ?? null,
    bookingTotalRecorded: number(b.qoute), bookingSubtotalRecorded: number(b.sub_total),
    bookingPaidAmountRecorded: number(b.paid_amount), bookingRefundRecorded: number(b.refund),
    currencyCodeRecorded: b.currency_code ?? null,
    mergedInvoiceId: id(row.merged_invoice_id), parentInvoiceId: id(row.parent_id),
    invoiceDepositRecorded: number(row.deposit), bookingDepositRecorded: number(b.deposit),
    purchaseOrderNumber: row.purchase_order_number ?? null,
    sourceUrl: `${ADMIN}/booking/view/${b.booking_id}`
  };
}
export function invoicePage(payload, expectedPage, seen) {
  if (!Array.isArray(payload?.data) || Number(payload.current_page) !== expectedPage ||
      !Number.isInteger(Number(payload.per_page)) || Number(payload.per_page) < 1 || payload.data.length > Number(payload.per_page)) throw Error('invoice_pagination_schema_mismatch');
  let next = false;
  if (payload.next_page_url !== null) {
    const url = new URL(payload.next_page_url);
    if (url.origin !== API || url.pathname !== INVOICES || Number(url.searchParams.get('page')) !== expectedPage + 1) throw Error('invoice_pagination_schema_mismatch');
    next = true;
  }
  if (next && !payload.data.length) throw Error('invoice_empty_nonterminal_page');
  const records = payload.data.map(invoiceRecord);
  for (const record of records) {
    if (seen.has(record.invoiceId)) throw Error('invoice_duplicate_id');
    seen.add(record.invoiceId);
  }
  return { records, next };
}
export async function exportOutstandingInvoices(page) {
  const capturedFrom = new Date().toISOString();
  const capture = page.waitForRequest(r => {
    const u = new URL(r.url());
    return r.method() === 'GET' && u.origin === API && u.pathname === INVOICES;
  }, { timeout: 45000 });
  capture.catch(() => {});
  await page.goto(`${ADMIN}/invoices?fltr[invoice_type]=Outstanding`, {waitUntil:'domcontentloaded',timeout:60000});
  if (new URL(page.url()).pathname !== '/invoices') throw Error('invoice_access_rejected');
  const request = await capture;
  const { authorization } = await request.allHeaders();
  if (!authorization) throw Error('invoice_session_authorization_missing');
  const read = async url => {
    const u = new URL(url);
    if (u.origin !== API || ![INVOICES, STATS].includes(u.pathname)) throw Error('invoice_read_path_rejected');
    for (let attempt=0;attempt<3;attempt++) {
      const response = await page.request.get(u.href,{headers:{authorization,accept:'application/json'},timeout:45000,maxRedirects:0});
      if (response.status() === 429 || response.status() >= 500) { if(attempt===2)throw Error('invoice_source_read_failed'); await new Promise(resolve=>setTimeout(resolve,1000*(attempt+1))); continue; }
      if (!response.ok()) throw Error('invoice_source_read_failed');
      return response.json();
    }
  };
  const count = async () => {
    const payload = await read(`${API}${STATS}?company_id=${COMPANY}`);
    const value = Number(payload?.countOutStanding?.count);
    if (!Number.isSafeInteger(value) || value < 0) throw Error('invoice_count_schema_mismatch');
    return value;
  };
  const expectedCount = await count();
  const template = new URL(request.url());
  if (template.searchParams.get('invoices_type') !== 'Outstanding') throw Error('invoice_scope_mismatch');
  template.searchParams.set('per_page','100');
  template.searchParams.set('sort','booking_invoice.id');
  template.searchParams.set('method','desc');
  const invoices = [], seen = new Set(); let pages=0, exhausted=false;
  for(let pageNumber=1;pageNumber<=100;pageNumber++) {
    template.searchParams.set('page',String(pageNumber));
    const batch = invoicePage(await read(template.href),pageNumber,seen);
    invoices.push(...batch.records); pages++;
    if(!batch.next){exhausted=true;break;}
  }
  const finalCount = await count();
  const complete = exhausted && expectedCount === finalCount && invoices.length === expectedCount && seen.size === expectedCount;
  return { ok:true, action:'outstanding_invoice_export',read_only:true,changed:false,complete,
    companyId:COMPANY,capturedFrom,capturedThrough:new Date().toISOString(),expectedCount,finalCount,
    rowCount:invoices.length,uniqueInvoiceCount:seen.size,pages,exhausted,
    moneyScope:'Booking total, paid amount, refund and deposits are source fields associated with each invoice. This export does not infer net balance or collect money.',
    invoices };
}
