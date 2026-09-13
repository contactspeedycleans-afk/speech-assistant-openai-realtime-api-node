export const NOTE_DEFAULTS = {
  specialNotes:'No special cleaning priorities or pets reported.',
  accessInstructions:'No special access instructions reported.'
};
export function validateNoteJob(body) {
  if (!/^CA[a-f0-9]{32}$/i.test(body.callSid || '') || !/^\d+$/.test(String(body.bookingId || '')) || !/^BOK-\d+$/.test(body.bookingNumber || '')) throw new Error('INVALID_BOOKING_REFERENCE');
  if (typeof body.transcript !== 'string' || !body.transcript.trim() || body.transcript.length > 150000) throw new Error('INVALID_TRANSCRIPT');
  return {
    callSid:body.callSid, bookingId:String(body.bookingId), bookingNumber:body.bookingNumber,
    transcript:body.transcript,
    baseline:{specialNotes:String(body.baseline?.specialNotes || NOTE_DEFAULTS.specialNotes), accessInstructions:String(body.baseline?.accessInstructions || NOTE_DEFAULTS.accessInstructions)}
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
