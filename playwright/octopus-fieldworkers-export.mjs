const ADMIN='https://admin.octopuspro.com',API='https://api.octopuspro.com',PATH='/api/v2/fieldworkers',COMPANY=18884;
export function fieldworkerRecord(row){
 if(!/^[1-9]\d*$/.test(String(row.user_id))||Number(row.company_id)!==COMPANY||Number(row.user_company_id)!==COMPANY)throw Error('fieldworker_tenant_mismatch');
 const fields=['user_id','username','display_name','first_name','last_name','email1','email2','email3','mobile1','mobile2','mobile3','phone1','phone2','phone3','unit_lot_number','street_number','street_address','suburb','state','postcode','timezone','active','blocked','is_deleted','created','updated','last_login','pause_email','receive_sms_for_notification','receive_email_for_notification','verified'];
 return Object.fromEntries(fields.map(key=>[key,row[key]??null]));
}
export function fieldworkerPage(body,page,seen){
 if(!Array.isArray(body.data)||Number(body.current_page)!==page||!Number.isSafeInteger(Number(body.total))||Number(body.total)<0)throw Error('fieldworker_page_mismatch');
 if(body.next_page_url){const u=new URL(body.next_page_url);if(u.origin!==API||u.pathname!==PATH||Number(u.searchParams.get('page'))!==page+1)throw Error('fieldworker_next_page_mismatch');}
 const rows=body.data.map(fieldworkerRecord);for(const r of rows){if(seen.has(String(r.user_id)))throw Error('fieldworker_duplicate');seen.add(String(r.user_id));}
 if(body.next_page_url&&!rows.length)throw Error('fieldworker_empty_page');
 return{rows,total:Number(body.total),next:Boolean(body.next_page_url)};
}
export async function exportFieldworkers(page){
 const capturedAt=new Date().toISOString();
 const captured=page.waitForRequest(r=>r.method()==='GET'&&r.url().startsWith(API+PATH+'?'),{timeout:45000});captured.catch(()=>{});
 await page.goto(ADMIN+'/fieldworkers?fltr[active]=0',{waitUntil:'domcontentloaded',timeout:60000});
 const req=await captured,authorization=(await req.allHeaders()).authorization;if(!authorization)throw Error('fieldworker_read_authorization_missing');
 const url=new URL(req.url());url.searchParams.set('active','0');url.searchParams.set('per_page','100');url.searchParams.delete('unique_id');
 const read=async number=>{url.searchParams.set('page',String(number));const response=await page.request.get(url.href,{headers:{authorization,accept:'application/json'},timeout:45000,maxRedirects:0});if(!response.ok())throw Error('fieldworker_read_failed');return response.json();};
 const seen=new Set(),rows=[];let expected=null,pages=0,exhausted=false;
 for(let n=1;n<=100;n++){const batch=fieldworkerPage(await read(n),n,seen);if(expected===null)expected=batch.total;if(expected!==batch.total)throw Error('fieldworker_count_changed');rows.push(...batch.rows);pages++;if(!batch.next){exhausted=true;break;}}
 const final=await read(1);const complete=exhausted&&rows.length===expected&&Number(final.total)===expected;
 return{ok:true,read_only:true,complete,companyId:COMPANY,captured_at:capturedAt,capturedThrough:new Date().toISOString(),total:expected,uniqueRows:seen.size,pages,rows};
}
