const test = require('node:test');
const assert = require('node:assert/strict');
test('frequency chooses exactly the requested option and defaults conservatively', async()=>{
  const {frequencyLabel}=await import('./playwright/octopus-frequency.js');
  for (const value of ['', 'unsure','one-time','one_time','one time cleaning','weekly or monthly']) assert.equal(frequencyLabel(value),'One Time Cleaning');
  for (const [value,wanted] of [['weekly','Weekly Cleans'],['biweekly','Bi-weekly Cleans'],['every other week','Bi-weekly Cleans'],['monthly','Monthly Cleans'],['every 3 weeks','Tri-weekly Cleans']]) assert.equal(frequencyLabel(value),wanted);
});
test('note replacement is idempotent and preserves staff changes',async()=>{
  const {mergeNote}=await import('./lib/booking-note-rules.js');
  assert.equal(mergeNote('Door code 1111','Door code 1111','Door code 2222'),'Door code 2222');
  assert.equal(mergeNote('Door code 2222','Door code 1111','Door code 2222'),'Door code 2222');
  assert.equal(mergeNote('Staff: use back gate','old',null),'Staff: use back gate');
  assert.throws(()=>mergeNote('Staff: use back gate','old','Door code 2222'),/STAFF_NOTES_CHANGED/);
});
test('job cannot target a guessed BOK as an internal booking id',async()=>{
  const {validateNoteJob}=await import('./lib/booking-note-rules.js');
  const p={callSid:'CA'+'a'.repeat(32),bookingId:'571989',bookingNumber:'BOK-27909',transcript:'Customer: Door code is 2468.'};
  assert.equal(validateNoteJob(p).bookingId,'571989');
  assert.throws(()=>validateNoteJob({...p,bookingId:'BOK-27909'}));
  assert.throws(()=>validateNoteJob({...p,callSid:''}));
  assert.throws(()=>validateNoteJob({...p,transcript:''}));
});
test('malformed or incomplete extraction cannot overwrite notes',async()=>{
  const {extractBookingNotes}=await import('./lib/booking-note-queue.js');
  const payload={baseline:{},transcript:'Customer: use the side door.'};
  await assert.rejects(()=>extractBookingNotes(payload,async()=>({ok:true,json:async()=>({choices:[{finish_reason:'length'}]})})),/INCOMPLETE/);
  await assert.rejects(()=>extractBookingNotes(payload,async()=>({ok:false,status:429})),/429/);
});
test('one bounded extraction returns the final corrected instructions',async()=>{
  const {extractBookingNotes}=await import('./lib/booking-note-queue.js');
  let calls=0;
  const result=await extractBookingNotes({baseline:{},transcript:'Customer: code 1111. Actually 2222.'},async(url,req)=>{
    calls++;
    const body=JSON.parse(req.body);
    assert.equal(body.response_format.json_schema.strict,true);
    assert.match(body.messages[0].content,/Latest explicit correction wins/);
    return {ok:true,json:async()=>({choices:[{finish_reason:'stop',message:{content:JSON.stringify({specialNotes:null,accessInstructions:'Door code 2222.',needsReview:false,reviewReason:''})}}]})};
  });
  assert.equal(calls,1);assert.equal(result.accessInstructions,'Door code 2222.');
});
