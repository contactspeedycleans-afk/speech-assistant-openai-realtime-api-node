const test = require('node:test');
const assert = require('node:assert/strict');

test('frequency controls ignore decorative and duplicate labels', async () => {
  const { actionableFrequencyChoices } = await import('./playwright/octopus-frequency.js');
  assert.deepEqual(actionableFrequencyChoices([
    { id: null, label: 'One Time Cleaning' },
    { id: 'desktop-one-time', label: 'One Time Cleaning' },
    { id: 'desktop-one-time', label: 'One Time Cleaning' },
    { id: 'weekly', label: 'Weekly Cleans' },
  ]), [
    { id: 'desktop-one-time', label: 'One Time Cleaning' },
    { id: 'weekly', label: 'Weekly Cleans' },
  ]);
});

test('duplicate visible inputs can commit the same frequency', async () => {
  const { frequencySelectionIsCommitted } = await import('./playwright/octopus-frequency.js');
  assert.equal(frequencySelectionIsCommitted(
    ['One Time Cleaning', 'One Time Cleaning'], 'One Time Cleaning'
  ), true);
  assert.equal(frequencySelectionIsCommitted(
    ['One Time Cleaning', 'Weekly Cleans'], 'One Time Cleaning'
  ), false);
});
