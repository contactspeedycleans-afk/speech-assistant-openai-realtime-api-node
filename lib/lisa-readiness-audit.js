// Explicit operator-only diagnostic; no customer calls or booking writes.
export async function runReadinessAudit(client) {
  const sid = process.env.TWILIO_ACCT_SID || process.env.TWILIO_ACCOUNT_SID;
  const authorization = 'Basic ' + Buffer.from(`${sid}:${process.env.TWILIO_AUTH_TOKEN}`).toString('base64');
  const get = async uri => {
    if (!uri?.startsWith(`/2010-04-01/Accounts/${sid}/`)) throw new Error('Unexpected Twilio audit URI');
    const response = await fetch('https://api.twilio.com' + uri, {headers:{authorization},signal:AbortSignal.timeout(15000)});
    if (!response.ok) throw new Error(`Twilio audit HTTP ${response.status}`);
    return response.json();
  };
  for (const callSid of JSON.parse(process.env.LISA_READINESS_CALLS || '[]')) {
    if (!/^CA[a-f0-9]{32}$/i.test(callSid)) continue;
    try {
      const call = await client.calls(callSid).fetch();
      const rec = await get(call.subresourceUris.recordings);
      const notices = await get(call.subresourceUris.notifications);
      const events = await get(call.subresourceUris.events);
      console.log('LISA_READINESS_CALL=' + JSON.stringify({sid:callSid,answeredBy:call.answeredBy,status:call.status,recordings:(rec.recordings || []).map(r=>({sid:r.sid,duration:r.duration,status:r.status})),errors:(notices.notifications || []).map(n=>({code:n.error_code || n.errorCode})),events:(events.events || []).map(e=>({path:(e.request?.url || '').split('?')[0],status:e.response?.response_code,hangup:/<Hangup/i.test(e.response?.response_body || ''),stream:/<Stream/i.test(e.response?.response_body || '')}))}));
    } catch(error) { console.log('LISA_READINESS_CALL_ERROR=' + JSON.stringify({sid:callSid,error:error.message})); }
  }
  if (process.env.LISA_OWNER_ALERT_SELF_TEST === 'LISA-READINESS-20260913') {
    const tag = process.env.LISA_OWNER_ALERT_SELF_TEST;
    const to = '+15177451309';
    const prior = await client.messages.list({to,limit:50});
    let message = prior.find(m=>m.body?.includes(tag));
    if (!message) message = await client.messages.create({to,from:'+18105100055',body:`TEST ONLY: Lisa alert delivery check. No booking was created and no action is needed. Reference: ${tag}.`});
    for (let attempt=0;attempt<20;attempt++) {
      message = await client.messages(message.sid).fetch();
      if (['delivered','failed','undelivered'].includes(message.status)) break;
      await new Promise(resolve=>setTimeout(resolve,2000));
    }
    console.log('LISA_READINESS_SMS=' + JSON.stringify({sid:message.sid,status:message.status,errorCode:message.errorCode,errorMessage:message.errorMessage}));
  }
}
