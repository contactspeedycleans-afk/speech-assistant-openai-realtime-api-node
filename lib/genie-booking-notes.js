// This endpoint is fixed: customer input can never select a credential destination.
const endpoint = 'https://getgeniecaller.com/api/integrations/lisa/genie-booking-notes';

export async function genieNotesRequest(payload, fetcher = fetch) {
  const secret = String(process.env.GENIE_CRM_SYNC_SECRET || '').trim();
  if (!secret) throw new Error('GENIE_NOTES_CREDENTIAL_MISSING');
  const response = await fetcher(endpoint, {
    method:payload?'POST':'GET',
    headers:{'Content-Type':'application/json','x-sync-secret':secret},
    ...(payload?{body:JSON.stringify(payload)}:{}),signal:AbortSignal.timeout(15000)
  });
  const data = await response.json();
  if (!response.ok || data.ok !== true) throw new Error(data.outcome || `GENIE_NOTES_HTTP_${response.status}`);
  return data;
}

export async function syncGenieBookingNotes(payload, notes, editOctopus, request = genieNotesRequest) {
  const reference = {genieJobId:payload.genieJobId,callSid:payload.callSid,bookingNumber:payload.bookingNumber};
  const remote = await request({...reference,operation:'apply',notes});
  // Native/Genie-owned notes are terminal locally, even if the API also returns
  // stale Octopus delivery fields. Never validate, edit, acknowledge, or retry them.
  if (remote.alreadyComplete === true || remote.localOnly === true) return {
    success:true,outcome:remote.localOnly === true?'notes_saved_in_genie':'notes_already_synced',
    alreadyComplete:true,localOnly:remote.localOnly === true,waiting:false
  };
  if (remote.waiting) return {success:true,waiting:true,outcome:'waiting_for_octopus'};
  if (!/^\d+$/.test(String(remote.bookingId || '')) || !/^BOK-\d+$/.test(remote.bookingNumber || '')) throw new Error('IDENTITY_MISMATCH');
  // A Genie BOK is never used to open an Octopus appointment.
  const result = await editOctopus({...payload,bookingId:String(remote.bookingId),bookingNumber:remote.bookingNumber,
    baseline:remote.baseline,notes:{...remote.notes,needsReview:false,reviewReason:''}});
  await request({...reference,operation:'complete',octopusBookingId:remote.bookingId,octopusBookingNumber:remote.bookingNumber});
  return result;
}
