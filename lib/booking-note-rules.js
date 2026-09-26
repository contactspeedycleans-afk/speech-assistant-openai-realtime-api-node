export const NOTE_DEFAULTS = {
  specialNotes:'No special cleaning priorities or pets reported.',
  accessInstructions:'No special access instructions reported.'
};
export function validateNoteJob(body) {
  const genie = body.bookingSystem === 'genie_crm';
  const validId = genie
    ? /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(body.genieJobId || '')
    : /^\d+$/.test(String(body.bookingId || ''));
  if (!/^CA[a-f0-9]{32}$/i.test(body.callSid || '') || !validId || !/^BOK-\d+$/.test(body.bookingNumber || '')) throw new Error('INVALID_BOOKING_REFERENCE');
  if (typeof body.transcript !== 'string' || !body.transcript.trim() || body.transcript.length > 150000) throw new Error('INVALID_TRANSCRIPT');
  if (genie && (typeof body.baseline?.specialNotes !== 'string' || typeof body.baseline?.accessInstructions !== 'string')) throw new Error('INVALID_NOTE_BASELINE');
  return {
    callSid:body.callSid, bookingId:genie?'':String(body.bookingId), bookingNumber:body.bookingNumber,
    ...(genie?{bookingSystem:'genie_crm',genieJobId:body.genieJobId}:{}),
    transcript:body.transcript,
    baseline:{specialNotes:String(body.baseline?.specialNotes ?? (genie?'':NOTE_DEFAULTS.specialNotes)), accessInstructions:String(body.baseline?.accessInstructions ?? (genie?'':NOTE_DEFAULTS.accessInstructions))}
  };
}
export function mergeNote(current, baseline, desired) {
  const clean = x => String(x || '').trim();
  if (desired == null || clean(current) === clean(desired)) return clean(current);
  if (clean(current) !== clean(baseline)) throw new Error('STAFF_NOTES_CHANGED');
  return clean(desired);
}
export function validateExtractedNotes(notes) {
  for (const key of ['specialNotes','accessInstructions']) {
    if (notes[key] !== null && (typeof notes[key] !== 'string' || notes[key].length > 8000 || !notes[key].trim())) throw new Error('INVALID_EXTRACTED_NOTES');
  }
  if (typeof notes.needsReview !== 'boolean' || typeof notes.reviewReason !== 'string') throw new Error('INVALID_REVIEW_RESULT');
  return notes;
}

export function validateCustomerEvidence(notes, transcript) {
  const customer = String(transcript).split(/\r?\n/).filter(line=>/^Customer:\s*/.test(line)).map(line=>line.replace(/^Customer:\s*/, '').trim());
  for (const field of ['specialNotes','accessInstructions']) {
    const evidence = notes[field+'Evidence'];
    if (!Array.isArray(evidence) || evidence.some(quote=>typeof quote!=='string'||!quote.trim()||!customer.some(line=>line.includes(quote.trim())))) throw new Error('NOTES_REQUIRE_REVIEW: Evidence is not an exact primary-customer quote.');
    if (notes[field] !== null && evidence.length===0) throw new Error('NOTES_REQUIRE_REVIEW: Changed instructions have no customer evidence.');
  }
  return validateExtractedNotes(notes);
}
