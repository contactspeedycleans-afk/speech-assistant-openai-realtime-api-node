import test from 'node:test';
import assert from 'node:assert/strict';
import {invoiceRecord,invoicePage,exportOutstandingInvoices} from '../playwright/octopus-outstanding-invoices.mjs';
const row=(id=1)=>({id,booking_id:99,invoice_num:`INV-${id}`,invoice_type:'overdue',booking_invoice_company_id:18884,created:100,email_sent:1,booking:{booking_id:99,company_id:18884,customer_id:3,customer:{customer_id:3,company_id:18884,first_name:'Test',last_name:'Fixture',email1:'test@example.invalid'},qoute:125,paid_amount:25,refund:0,status:{name:'CANCELLED'}}});
const payload=(page,data,next=null)=>({current_page:page,data,per_page:100,next_page_url:next});
test('keeps canceled historical invoices and preserves source money without guessing net balance',()=>{
 const r=invoiceRecord(row());assert.equal(r.bookingStatus,'CANCELLED');assert.equal(r.bookingTotalRecorded,125);assert.equal(r.bookingPaidAmountRecorded,25);assert.equal(r.bookingRefundRecorded,0);assert.equal(r.invoiceDepositRecorded,null);assert.equal(r.balanceDue,undefined);
});
test('rejects other tenants, mismatched booking/customer identity and pagination drift',()=>{
 const a=row();a.booking.company_id=1;assert.throws(()=>invoiceRecord(a),/tenant/);
 const b=row();b.booking.booking_id=100;assert.throws(()=>invoiceRecord(b),/identity/);
 const c=row();c.booking.customer.customer_id=4;assert.throws(()=>invoiceRecord(c),/identity/);
 assert.throws(()=>invoicePage(payload(2,[row()]),1,new Set()),/pagination/);
 assert.throws(()=>invoicePage(payload(1,[row()],'https://evil.invalid/api/v2/invoices?page=2'),1,new Set()),/pagination/);
 assert.throws(()=>invoicePage(payload(1,[row(),row()]),1,new Set()),/duplicate/);
});
test('full ledger reads only the two allowlisted GET endpoints and reconciles first/final counts',async()=>{
 const reads=[];let counts=0;
 const page={url:()=> 'https://admin.octopuspro.com/invoices',goto:async()=>{},waitForRequest:async()=>({url:()=> 'https://api.octopuspro.com/api/v2/invoices?page=1&per_page=10&invoices_type=Outstanding',allHeaders:async()=>({authorization:'TEST_ONLY'})}),request:{get:async(url)=>{reads.push(url);return{ok:()=>true,status:()=>200,json:async()=>url.includes('/statistics')?{countOutStanding:{count:2}}:new URL(url).searchParams.get('page')==='1'?payload(1,[row(2)],'https://api.octopuspro.com/api/v2/invoices?page=2'):payload(2,[row(1)])}}}};
 const result=await exportOutstandingInvoices(page);assert.equal(result.complete,true);assert.equal(result.rowCount,2);assert.equal(result.uniqueInvoiceCount,2);assert.equal(result.pages,2);assert.equal(result.changed,false);assert.ok(reads.every(url=>new URL(url).origin==='https://api.octopuspro.com'));assert.ok(!JSON.stringify(result).includes('TEST_ONLY'));
 page.request.get=async(url)=>({ok:()=>true,status:()=>200,json:async()=>url.includes('/statistics')?{countOutStanding:{count:++counts===1?2:3}}:new URL(url).searchParams.get('page')==='1'?payload(1,[row(2)],'https://api.octopuspro.com/api/v2/invoices?page=2'):payload(2,[row(1)])});
 assert.equal((await exportOutstandingInvoices(page)).complete,false);
});
