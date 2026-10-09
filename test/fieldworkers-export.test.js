import {test} from 'node:test';import assert from 'node:assert/strict';import {fieldworkerRecord,fieldworkerPage} from '../playwright/octopus-fieldworkers-export.mjs';
const row={user_id:1,company_id:18884,user_company_id:18884,email1:'cleaner@example.com',user_code:'secret',user_devices:[{devicetoken:'secret'}]};
test('only roster fields leave the source',()=>{const r=fieldworkerRecord(row);assert.equal(r.email1,row.email1);assert.equal(r.user_code,undefined);assert.equal(r.user_devices,undefined);});
test('tenant mismatch is rejected',()=>assert.throws(()=>fieldworkerRecord({...row,company_id:2})));
test('pagination rejects duplicate workers and external next URLs',()=>{const seen=new Set();fieldworkerPage({data:[row],current_page:1,total:1,next_page_url:null},1,seen);assert.throws(()=>fieldworkerPage({data:[row],current_page:2,total:1},2,seen));assert.throws(()=>fieldworkerPage({data:[row],current_page:1,total:2,next_page_url:'https://evil.example/?page=2'},1,new Set()));});
