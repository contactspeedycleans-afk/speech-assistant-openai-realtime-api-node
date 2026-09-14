const assert = require('node:assert/strict');
const {test} = require('node:test');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(__dirname+'/playwright/octopus-address.js','utf8').replaceAll('export ','');
const ctx=vm.createContext({}); vm.runInContext(source,ctx);
const address={streetNumber:'4130',streetAddress:'Sweet Road',suburb:'Howell',state:'MI'};
test('screenshot address matches without ZIP',()=>assert.equal(ctx.matchesAddress('4130 Sweet Road, Howell, MI, United States',address),true));
test('abbreviations are accepted',()=>assert.equal(ctx.matchesAddress('4130 Sweet Rd, Howell, MI 48843, United States',address),true));
test('wrong state and city cannot be selected',()=>assert.equal(ctx.matchesAddress('4130 Sweet Road, Winter Park, FL, United States',address),false));
test('unique postal-locality fallback keeps exact street and state',()=>assert.equal(ctx.matchesStreetAndState('4130 Sweet Road, Genoa Township, MI 48843, United States',address),true));
test('postal-locality fallback rejects another state',()=>assert.equal(ctx.matchesStreetAndState('4130 Sweet Road, Genoa Township, FL 48843, United States',address),false));
test('house numbers must match exactly',()=>assert.equal(ctx.matchesAddress('14130 Sweet Road, Howell, MI, United States',address),false));
test('similar sounding road is not a match',()=>assert.equal(ctx.matchesAddress('4130 Fleet Road, Howell, MI, United States',address),false));
test('dropdown navigation labels are ignored',()=>assert.equal(ctx.matchesAddress('Bookings',address),false));
test('partial spoken address can expand a missing number prefix',()=>{
  const partial={streetNumber:'738',streetAddress:'Knighton Drive',suburb:'Farmington Hills',state:'MI',postcode:'48331'};
  const picked=ctx.chooseClosestAddress([
    '30738 Knighton Dr, Farmington Hills, MI 48331, United States',
    '30802 Knighton Dr, Farmington Hills, MI 48331, United States'
  ],partial);
  assert.equal(picked.text.startsWith('30738 Knighton'),true);
});
test('short street prefix and number suffix pick one clear local result',()=>{
  const partial={streetNumber:'4247',streetAddress:'roll',suburb:'Hartland',state:'MI'};
  const picked=ctx.chooseClosestAddress([
    '247 Rolling Acres Dr, Hartland, MI 48353, United States',
    '4247 Rollins St, Grand Rapids, MI 49534, United States'
  ],partial);
  assert.equal(picked.text.startsWith('247 Rolling Acres'),true);
});
test('equally plausible partial results require clarification',()=>{
  const partial={streetNumber:'247',streetAddress:'roll',suburb:'',state:''};
  assert.equal(ctx.chooseClosestAddress([
    '247 Rolling Acres Dr, Hartland, MI 48353, United States',
    '247 Rolling Hills Dr, Howell, MI 48843, United States'
  ],partial),null);
});
