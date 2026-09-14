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
