import test from 'node:test';
import assert from 'node:assert/strict';
import {createOctopusWriteGate} from '../lib/octopus-write-gate.js';
import {createBookingNoteQueue} from '../lib/booking-note-queue.js';
import {syncGenieBookingNotes} from '../lib/genie-booking-notes.js';
const PGlite=process.env.PGLITE_TEST_MODULE ? (await import(process.env.PGLITE_TEST_MODULE)).PGlite : null;
const payload={callSid:'CA'+'a'.repeat(32),bookingId:'123456',bookingNumber:'BOK-123',transcript:'Customer: Side door.',baseline:{specialNotes:'',accessInstructions:''}};
const notes={specialNotes:null,accessInstructions:'Side door.',needsReview:false,reviewReason:''};
async function fixture() {
 const pg=new PGlite();await pg.exec('CREATE TABLE lisa_call_history(call_sid text,ai_summary text,updated_at timestamptz)');
 const client={query:async(sql,args)=>/pg_try_advisory_lock/.test(sql)?{rows:[{locked:true}]}:/pg_advisory_unlock/.test(sql)?{rows:[]}:pg.query(sql,args),release(){}};
 return {pg,db:{query:(...args)=>pg.query(...args),connect:async()=>client}};
}
async function seed(db,key,p=payload,status='pending'){await db.query(`INSERT INTO lisa_booking_note_jobs(job_key,payload,status,updated_at) VALUES($1,$2,$3,NOW()-INTERVAL '10 minutes')`,[key,JSON.stringify(p),status]);}
test('real SQL: paused external notes held, new local-only Genie notes complete', {skip:!PGlite},async()=>{
 const {pg,db}=await fixture();let edits=0;const gate=createOctopusWriteGate({OCTOPUS_WRITES_PAUSED:'true'});
 const queue=createBookingNoteQueue(db,null,{start:false,gate,extract:async()=>notes,edit:async()=>{edits++;return{success:true};},sync:(p,n,e)=>syncGenieBookingNotes(p,n,e,async()=>({localOnly:true}))});
 try{await queue.status();await seed(db,'external');await queue.drain();let r=(await db.query('SELECT * FROM lisa_booking_note_jobs')).rows[0];assert.equal(r.status,'held');assert.equal(r.external_started_at,null);assert.equal(edits,0);
 await seed(db,'local',{...payload,bookingSystem:'genie_crm',genieJobId:'00000000-0000-4000-8000-000000000001'});await queue.drain();r=(await db.query("SELECT * FROM lisa_booking_note_jobs WHERE job_key='local'")).rows[0];assert.equal(r.status,'complete');assert.equal(r.result.localOnly,true);assert.equal(edits,0);assert.equal((await queue.status()).held,1);
 }finally{await pg.close();}
});
test('real SQL: timeout after dispatch and stale running job never retry', {skip:!PGlite},async()=>{
 const {pg,db}=await fixture();let edits=0;const gate=createOctopusWriteGate({});const queue=createBookingNoteQueue(db,null,{start:false,gate,extract:async()=>notes,edit:async()=>{edits++;throw Error('timeout after save');}});
 try{await queue.status();await seed(db,'attempted');await queue.drain();await queue.drain();let r=(await db.query("SELECT * FROM lisa_booking_note_jobs WHERE job_key='attempted'")).rows[0];assert.equal(r.status,'needs_review');assert.ok(r.external_started_at);assert.equal(edits,1);assert.equal((await queue.status()).unknown,1);assert.equal(gate.status().safeToCutover,false);
 await seed(db,'interrupted',payload,'running');await queue.drain();r=(await db.query("SELECT * FROM lisa_booking_note_jobs WHERE job_key='interrupted'")).rows[0];assert.equal(r.status,'needs_review');assert.equal(edits,1);assert.equal((await queue.status()).unknown,2);
 }finally{await pg.close();}
});
test('real SQL: completed remote write followed by failed Genie acknowledgement stays held', {skip:!PGlite},async()=>{
 const {pg,db}=await fixture();let edits=0;const gate=createOctopusWriteGate({});
 const queue=createBookingNoteQueue(db,null,{start:false,gate,extract:async()=>notes,edit:async()=>{edits++;return{success:true};},sync:(p,n,e)=>syncGenieBookingNotes(p,n,e,async req=>{if(req.operation==='complete')throw Error('ack timeout');return{bookingId:'123456',bookingNumber:'BOK-123',baseline:payload.baseline,notes};})});
 try{await queue.status();await seed(db,'ack',{...payload,bookingSystem:'genie_crm',genieJobId:'00000000-0000-4000-8000-000000000001'});await queue.drain();await queue.drain();assert.equal(edits,1);assert.equal((await queue.status()).unknown,1);assert.equal((await db.query("SELECT status FROM lisa_booking_note_jobs WHERE job_key='ack'")).rows[0].status,'needs_review');}
 finally{await pg.close();}
});
