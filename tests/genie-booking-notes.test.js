import test from 'node:test';
import assert from 'node:assert/strict';
import {validateNoteJob,validateCustomerEvidence} from '../lib/booking-note-rules.js';
import {syncGenieBookingNotes} from '../lib/genie-booking-notes.js';

test('local-only completion takes precedence over stale remote targets and waiting flags',async()=>{
  let edits=0;const operations=[];
  const result=await syncGenieBookingNotes({genieJobId:'local-job',callSid:'local-call',bookingNumber:'BOK-1'}, {},
    async()=>{edits++;throw Error('must not edit Octopus');},
    async request=>{operations.push(request.operation);return{localOnly:true,waiting:true,bookingId:'99999',bookingNumber:'BOK-99999'};});
  assert.equal(result.success,true);assert.equal(result.alreadyComplete,true);assert.equal(result.localOnly,true);assert.equal(result.waiting,false);
  assert.equal(result.outcome,'notes_saved_in_genie');assert.equal(edits,0);assert.deepEqual(operations,['apply']);
});

test('native replay completes locally without an Octopus retry or completion acknowledgement',async()=>{
  let edits=0,requests=0;
  for(let replay=0;replay<2;replay++){
    const result=await syncGenieBookingNotes({genieJobId:'local-job',callSid:'local-call',bookingNumber:'BOK-1'}, {},
      async()=>{edits++;},async request=>{requests++;assert.equal(request.operation,'apply');return{alreadyComplete:true,localOnly:true};});
    assert.equal(result.waiting,false);assert.equal(result.localOnly,true);
  }
  assert.equal(edits,0);assert.equal(requests,2);
});
const payload={bookingSystem:'genie_crm',genieJobId:'00000000-0000-4000-8000-000000000001',
  callSid:'CA'+'1'.repeat(32),bookingNumber:'BOK-123',transcript:'Customer: Side door.',baseline:{specialNotes:'',accessInstructions:''}};
test('Genie UUID and empty saved baseline survive validation',()=>{
  const result=validateNoteJob(payload);assert.equal(result.genieJobId,payload.genieJobId);assert.equal(result.bookingId,'');assert.deepEqual(result.baseline,payload.baseline);
  assert.throws(()=>validateNoteJob({...payload,genieJobId:'123'}),/INVALID_BOOKING_REFERENCE/);
});
test('pending mirror never edits Octopus under the Genie BOK',async()=>{
  const result=await syncGenieBookingNotes(payload,{},()=>{throw Error('must not edit')},async()=>({waiting:true}));assert.equal(result.waiting,true);
});
test('confirmed remote identity and baseline are used, then completion is acknowledged',async()=>{
  const calls=[];const baseline={specialNotes:'Saved remote note',accessInstructions:'Saved access'};
  const result=await syncGenieBookingNotes(payload,{needsReview:true},async p=>{
    assert.equal(p.bookingId,'9999');assert.equal(p.bookingNumber,'BOK-9999');assert.deepEqual(p.baseline,baseline);return {success:true,outcome:'notes_saved_verified'};
  },async p=>{calls.push(p);return {bookingId:9999,bookingNumber:'BOK-9999',baseline,notes:{specialNotes:'Final note',accessInstructions:'Side door'}}});
  assert.equal(result.success,true);assert.equal(calls[1].operation,'complete');assert.equal(calls[1].bookingNumber,'BOK-123');assert.equal(calls[1].octopusBookingNumber,'BOK-9999');
});
test('staff conflict never edits or acknowledges',async()=>{
  let edits=0;
  await assert.rejects(()=>syncGenieBookingNotes(payload,{},async()=>edits++,async()=>{throw Error('STAFF_NOTES_CHANGED')}),/STAFF_NOTES_CHANGED/);assert.equal(edits,0);
});
test('already completed replay never edits again',async()=>{
  const result=await syncGenieBookingNotes(payload,{},()=>{throw Error('must not edit')},async()=>({alreadyComplete:true}));assert.equal(result.outcome,'notes_already_synced');
});
test('Lisa statements cannot serve as evidence for new customer instructions',()=>{
  const notes={specialNotes:'One pet present.',accessInstructions:null,needsReview:false,reviewReason:'',specialNotesEvidence:['One pet present.'],accessInstructionsEvidence:[]};
  assert.throws(()=>validateCustomerEvidence(notes,'Customer: One person.\nLisa: One pet present.'),/NOTES_REQUIRE_REVIEW/);
  assert.throws(()=>validateCustomerEvidence({...notes,specialNotesEvidence:[]},'Customer: Hello.'),/NOTES_REQUIRE_REVIEW/);
});
