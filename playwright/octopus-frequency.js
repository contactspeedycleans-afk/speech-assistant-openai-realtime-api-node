export function frequencyLabel(value) {
  const v = String(value || '').toLowerCase().replace(/[_-]/g, ' ').replace(/\s+/g, ' ').trim();
  if (/^(tri weekly|triweekly|every (three|3) weeks|3 weeks?)$/.test(v)) return 'Tri-weekly Cleans';
  if (/^(bi weekly|biweekly|fortnightly|every (two|2|other) weeks?|2 weeks?)$/.test(v)) return 'Bi-weekly Cleans';
  if (/^(monthly|every (four|4) weeks|4 weeks?)$/.test(v)) return 'Monthly Cleans';
  if (/^(weekly|every week|1 week)$/.test(v)) return 'Weekly Cleans';
  return 'One Time Cleaning';
}

export function actionableFrequencyChoices(rawChoices) {
  return [...new Map(
    (rawChoices || []).filter(x => x?.id).map(x => [x.id, x])
  ).values()];
}

export function frequencySelectionIsCommitted(selectedLabels, wanted) {
  const selected = (selectedLabels || []).filter(Boolean);
  return selected.length > 0 && selected.every(label => label === wanted);
}

export async function selectSingleFrequency(page, value) {
  const wanted = frequencyLabel(value);
  const rawChoices = await page.locator('label.checkbox-label:visible').evaluateAll(labels => labels
    .filter(x => /^(One Time Cleaning|Monthly Cleans|Bi-weekly Cleans|Tri-weekly Cleans|Weekly Cleans|Wants To See How The First Visit Goes)$/.test(x.textContent.trim()))
    .map(x => ({ id:x.getAttribute('for'), label:x.textContent.trim() })));
  // Octopus can render decorative labels, hidden mobile copies, and more than
  // one visible actionable copy of the same semantic frequency. Ignore labels
  // with no input and allow equivalent checked copies of the requested option.
  const choices = actionableFrequencyChoices(rawChoices);
  const target = choices.filter(x => x.label === wanted);
  if (target.length === 0) throw new Error('FREQUENCY_CONTROL_MISSING');
  // Use real clicks so Vue updates its model, not just the checkbox DOM property.
  for (const choice of choices) {
    const input = page.locator(`[id="${choice.id}"]`);
    const checked = choice.label === wanted;
    if (await input.isChecked() !== checked) {
      if (await input.isVisible()) await input.setChecked(checked, { force:true });
      else await input.evaluate(element => element.click());
    }
  }
  await page.waitForTimeout(150);
  const selected = [];
  for (const choice of choices) if (await page.locator(`[id="${choice.id}"]`).isChecked()) selected.push(choice.label);
  if (!frequencySelectionIsCommitted(selected, wanted)) throw new Error('FREQUENCY_NOT_COMMITTED');
  return wanted;
}
