export function frequencyLabel(value) {
  const v = String(value || '').toLowerCase().replace(/[_-]/g, ' ').replace(/\s+/g, ' ').trim();
  if (/^(tri weekly|triweekly|every (three|3) weeks|3 weeks?)$/.test(v)) return 'Tri-weekly Cleans';
  if (/^(bi weekly|biweekly|fortnightly|every (two|2|other) weeks?|2 weeks?)$/.test(v)) return 'Bi-weekly Cleans';
  if (/^(monthly|every (four|4) weeks|4 weeks?)$/.test(v)) return 'Monthly Cleans';
  if (/^(weekly|every week|1 week)$/.test(v)) return 'Weekly Cleans';
  return 'One Time Cleaning';
}

export async function selectSingleFrequency(page, value) {
  const wanted = frequencyLabel(value);
  const choices = await page.locator('label.checkbox-label').evaluateAll(labels => labels
    .filter(x => /^(One Time Cleaning|Monthly Cleans|Bi-weekly Cleans|Tri-weekly Cleans|Weekly Cleans|Wants To See How The First Visit Goes)$/.test(x.textContent.trim()))
    .map(x => ({ id:x.getAttribute('for'), label:x.textContent.trim() })));
  const target = choices.filter(x => x.label === wanted);
  if (target.length !== 1 || choices.some(x => !x.id)) throw new Error('FREQUENCY_CONTROL_AMBIGUOUS');
  // Use real clicks so Vue updates its model, not just the checkbox DOM property.
  for (const choice of choices) {
    const input = page.locator(`[id="${choice.id}"]`);
    const checked = choice.label === wanted;
    if (await input.isChecked() !== checked) {
      if (await input.isVisible()) await input.setChecked(checked, { force:true });
      else await page.locator(`label[for="${choice.id}"]`).click();
    }
  }
  await page.waitForTimeout(150);
  const selected = [];
  for (const choice of choices) if (await page.locator(`[id="${choice.id}"]`).isChecked()) selected.push(choice.label);
  if (selected.length !== 1 || selected[0] !== wanted) throw new Error('FREQUENCY_NOT_COMMITTED');
  return wanted;
}
