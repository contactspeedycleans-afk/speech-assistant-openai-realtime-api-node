import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const source=readFileSync(new URL('../playwright/octopus-booking-actions.js',import.meta.url),'utf8');
const code=source.slice(source.indexOf('async function rescheduleBooking(page)'),source.indexOf('function summarizeAssignmentWrite'));
async function run({oldStart='11:00 AM',oldEnd='2:00 PM',savedStart='9:00 AM',savedEnd='12:00 PM',expectedStart='11:00'}={}){
  const clicks=[],applied=[];let result;
  const appointment={fromDate:'2099-09-27',toDate:'2099-09-27',fromTime:oldStart,toTime:oldEnd};
  const persisted={...appointment,fromTime:savedStart,toTime:savedEnd};
  const locator={first(){return this},async waitFor(){}};
  const verifier={async goto(){},locator:()=>locator,async waitForTimeout(){},async close(){},
    context:()=>({newCDPSession:async()=>({send:async()=>{}})})};
  const response={ok:()=>true,status:()=>200,statusText:()=> 'OK'};
  const page={async waitForTimeout(){},waitForResponse:async()=>response,
    context:()=>({newPage:async()=>verifier}),url:()=> 'https://example.invalid/booking/view/900123',
    getByText(){throw Error('Silent update must not open notification flow')}};
  const ctx={URL,console:{log(){}},process:{env:{LISA_SKIP_RESCHEDULE_NOTIFICATION:'true',LISA_RESCHEDULE_EXPECTED_DATE:'2099-09-27',LISA_RESCHEDULE_EXPECTED_START:expectedStart}},
    bookingId:'900123',requestedDate:'2099-09-27',requestedStartTime:'09:00',mode:'reschedule',
    getPageState:async()=>({toDo:true}),readStoredAppointment:async p=>p===page?appointment:persisted,
    normalizeDateText:s=>s,formatLongDate:s=>s,formatClockTime:n=>`${Math.floor(n/60)}:${String(n%60).padStart(2,'0')}`,
    parseClockTime(value){const [,h,m,ampm]=String(value).match(/^(\d+):(\d+)\s*(AM|PM)?$/);return (ampm?(+h%12)+(ampm==='PM'?12:0):+h)*60+(+m)},
    applyStoredAppointment:async(p,v)=>applied.push(v),
    waitForLargestVisibleExactText:async(p,label)=>({evaluate:async()=>clicks.push(label),click:async()=>clicks.push(label)}),
    summarizeSaveResponse:async()=>({body:{IsSuccess:true,is_updated:1,SavedMessage:true}}),logResult:r=>{result=r}};
  vm.runInNewContext(code+'\nglobalThis.run=rescheduleBooking;',ctx);await ctx.run(page);return {result,clicks,applied};
}
test('confirmed silent reschedule preserves duration, reads saved appointment, and never clicks Send',async()=>{
  const {result,clicks,applied}=await run();assert.equal(result.verified_rescheduled_in_octopus,true);
  assert.equal(result.customer_notification_sent,false);assert.equal(result.duration_minutes,180);assert.deepEqual(clicks,['Save changes']);assert.equal(applied[0].toTime,'12:00');
});
test('server success cannot override contradictory fresh appointment data',async()=>{
  const {result,clicks}=await run({savedStart:'11:00 AM',savedEnd:'2:00 PM'});
  assert.equal(result.verified_rescheduled_in_octopus,false);assert.equal(result.customer_notification_sent,false);assert.deepEqual(clicks,['Save changes']);
});
test('a staff-edited old time is never overwritten',async()=>{
  const {result,clicks}=await run({oldStart:'10:00 AM',oldEnd:'1:00 PM'});assert.equal(result.outcome,'appointment_changed_since_confirmation');assert.equal(clicks.length,0);
});
test('retry at the target time only reads the existing appointment',async()=>{
  const {result,clicks}=await run({oldStart:'9:00 AM',oldEnd:'12:00 PM'});assert.equal(result.outcome,'already_rescheduled');assert.equal(result.changed,false);assert.equal(clicks.length,0);
});
