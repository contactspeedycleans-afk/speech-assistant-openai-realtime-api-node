const test=require('node:test');
const assert=require('node:assert/strict');

test('frequency controls ignore decorative labels and duplicate mobile copies',async()=>{
  const {actionableFrequencyChoices}=await import('./playwright/octopus-frequency.js');
  const choices=actionableFrequencyChoices([
    {id:null,label:'One Time Cleaning'},
    {id:'one-time',label:'One Time Cleaning'},
    {id:'one-time',label:'One Time Cleaning'},
    {id:'weekly',label:'Weekly Cleans'},
  ]);
  assert.deepEqual(choices,[
    {id:'one-time',label:'One Time Cleaning'},
    {id:'weekly',label:'Weekly Cleans'},
  ]);
});

test('duplicate visible controls with different ids count as one semantic selection',async()=>{
  const {actionableFrequencyChoices,frequencySelectionIsCommitted}=await import('./playwright/octopus-frequency.js');
  const choices=actionableFrequencyChoices([
    {id:'desktop-one-time',label:'One Time Cleaning'},
    {id:'mobile-one-time',label:'One Time Cleaning'},
    {id:'weekly',label:'Weekly Cleans'},
  ]);
  assert.equal(choices.length,3);
  assert.equal(
    frequencySelectionIsCommitted(
      ['One Time Cleaning','One Time Cleaning'],
      'One Time Cleaning'
    ),
    true
  );
  assert.equal(
    frequencySelectionIsCommitted(
      ['One Time Cleaning','Weekly Cleans'],
      'One Time Cleaning'
    ),
    false
  );
});
