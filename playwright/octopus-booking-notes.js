import { mergeNote } from '../lib/booking-note-rules.js';
import { selectSingleFrequency } from './octopus-frequency.js';

export function resolveNoteFields(ids) {
  const special = ids.filter(id=>/^attribute_\d+17483$/.test(id));
  const access = ids.filter(id=>/^attribute_\d+13969$/.test(id));
  if (special.length !== 1 || access.length !== 1 || special[0].slice(0,-5) !== access[0].slice(0,-5)) throw new Error('NOTE_FIELD_AMBIGUOUS');
  return {specialNotes:'#'+special[0],accessInstructions:'#'+access[0]};
}

export async function updateBookingNotes(page, payload) {
  const { bookingNumber, baseline = {}, notes = {} } = payload;
  if (!/^BOK-\d+$/.test(bookingNumber || '')) throw new Error('INVALID_BOOKING_REFERENCE');
  const verifyIdentity = async () => {
    const text = await page.locator('body').innerText();
    if (!(text.match(/\bBOK-\d+\b/g) || []).includes(bookingNumber)) throw new Error('BOOKING_IDENTITY_MISMATCH');
  };
  await verifyIdentity();
  if (payload.inspectOnly) {
    await page.waitForTimeout(2000);
    return {success:true,outcome:'notes_read_only_inspection',bookingNumber,fields:await page.locator('textarea, input[id^="attribute_"]').evaluateAll(nodes=>nodes.map(n=>({id:n.id,name:n.name,type:n.type,visible:!!n.getClientRects().length}))),labels:await page.locator('label').allTextContents()};
  }
  await page.locator('textarea[id^="attribute_"]').first().waitFor({state:'attached',timeout:15000});
  const fields = resolveNoteFields(await page.locator('textarea[id^="attribute_"]').evaluateAll(nodes=>nodes.map(node=>node.id)));
  const expected = {};
  let changed = false;
  for (const [key, selector] of Object.entries(fields)) {
    const field = page.locator(selector);
    if (await field.count() !== 1) throw new Error('NOTE_FIELD_AMBIGUOUS');
    expected[key] = mergeNote(await field.inputValue(), baseline[key], notes[key]);
  }
  for (const [key, selector] of Object.entries(fields)) {
    const field = page.locator(selector);
    if (await field.inputValue() === expected[key]) continue;
    if (!await field.isVisible()) {
      const label = key === 'specialNotes' ? 'Special Notes' : 'Access Instructions';
      await page.getByText(label, {exact:true}).last().click();
    }
    await field.fill(expected[key]);
    await field.press('Tab');
    changed = true;
  }
  // Only used by an explicitly requested repair/test, never inferred from notes.
  if (payload.repairFrequency) { await selectSingleFrequency(page, payload.repairFrequency); changed = true; }
  if (!changed) return {success:true,outcome:'notes_already_current',bookingNumber};
  if (payload.captureOnly) {
    let captured = false;
    await page.route('**/*', async route => {
      if (route.request().method() !== 'GET') { captured = true; return route.abort(); }
      return route.continue();
    });
    await page.getByText('Save changes',{exact:true}).first().click();
    await page.waitForTimeout(1500);
    return {success:captured,outcome:'notes_save_captured_not_written',bookingNumber};
  }
  const responsePromise = page.waitForResponse(r => r.request().method() === 'POST' && r.url().includes('/save-booking-services'), {timeout:20000});
  await page.getByText('Save changes',{exact:true}).first().click();
  const response = await responsePromise;
  if (!response.ok()) throw new Error('NOTES_SAVE_REJECTED');
  // Do not click Notify Customer. Reopen and read stored values instead.
  await page.reload({waitUntil:'domcontentloaded'});
  await page.locator(fields.specialNotes).waitFor({state:'attached',timeout:15000});
  await verifyIdentity();
  for (const [key, selector] of Object.entries(fields)) {
    if ((await page.locator(selector).inputValue()).trim() !== expected[key].trim()) throw new Error('NOTES_SAVE_NOT_PERSISTED');
  }
  if (payload.repairFrequency) {
    const selected = await page.locator('input[name="attribute_8087013985[]"]:checked').count();
    if (selected !== 1) throw new Error('FREQUENCY_SAVE_NOT_PERSISTED');
  }
  return {success:true,outcome:'notes_saved_verified',bookingNumber};
}
