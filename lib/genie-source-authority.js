// Fixed credential destination; mode/tenant are never accepted from an action payload.
const endpoint='https://getgeniecaller.com/api/integrations/lisa/job-context';
export async function legacyActionGuard(fetcher=fetch,env=process.env){
  const nativeRequired=String(env.GENIE_CRM_SOURCE_MODE||'mirror').trim().toLowerCase()!=='mirror';
  const handoff=outcome=>({success:false,found:null,needsStaffReview:true,retry_booking:false,outcome,
    error:'Staff must verify this action in Genie. No appointment change is confirmed.'});
  const secret=String(env.GENIE_CRM_SYNC_SECRET||'').trim();
  const expected=String(env.GENIE_CRM_BUSINESS_ID||env.TWILIO_SYNC_BUSINESS_ID||'').trim();
  let observedNative=false;
  try{
    if(!secret)throw new Error('credential_missing');
    const response=await fetcher(endpoint,{headers:{'x-sync-secret':secret},signal:AbortSignal.timeout(12000),cache:'no-store'});
    const result=await response.json();
    observedNative=result?.sourceMode==='native';
    if(!response.ok||result.ok!==true||!['mirror','native'].includes(result.sourceMode)||!result.businessId)throw new Error('authority_unavailable');
    if(expected&&expected!==result.businessId)return handoff('source_tenant_mismatch');
    if(result.sourceMode==='native')return handoff(expected&&result.authoritative===true?'native_action_requires_staff':'source_authority_unavailable');
    if(nativeRequired)return handoff('source_mode_conflict');
    return null;
  }catch{return nativeRequired||observedNative?handoff('source_authority_unavailable'):null;}
}
