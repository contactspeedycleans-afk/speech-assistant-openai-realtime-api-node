export function normalizeAddress(value) {
  return String(value || '').toLowerCase()
    .replace(/\b(?:road|street|avenue|court|drive|lane|boulevard|place|terrace|highway)\b/g,
      word => ({road:'rd',street:'st',avenue:'ave',court:'ct',drive:'dr',lane:'ln',boulevard:'blvd',place:'pl',terrace:'ter',highway:'hwy'}[word]))
    .replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');
}

export function matchesAddress(text, address) {
  const parts = String(text || '').split(',').map(normalizeAddress);
  const street = normalizeAddress(`${address.streetNumber} ${address.streetAddress}`);
  const city = normalizeAddress(address.suburb);
  const state = normalizeAddress(address.state);
  // Exact number/street and locality; ZIP need not appear in Google's suggestion.
  return parts.length >= 3 && parts[0] === street && parts[1] === city &&
    (parts[2] === state || parts[2].startsWith(state + ' '));
}

export async function selectOctopusAddress(page, address) {
  const query = `${address.streetNumber} ${address.streetAddress}, ${address.suburb}, ${address.state}`;
  const input = page.locator('input[placeholder="Booking address"]').first();
  await input.waitFor({state:'visible', timeout:15000});
  let chosenText = '';
  // Two bounded UI attempts, always selecting the validated match, never first/ArrowDown.
  for (let attempt = 0; attempt < 2; attempt++) {
    await input.fill('');
    await input.fill(query);
    const options = page.locator('[role="option"]:visible, .pac-item:visible, .vs__dropdown-option:visible, li:visible');
    let chosen = null;
    let suggestions = [];
    for (let poll = 0; poll < 12 && !chosen; poll++) {
      await page.waitForTimeout(250);
      const count = await options.count();
      suggestions = [];
      const matching = [];
      for (let i = 0; i < count; i++) {
        const text = (await options.nth(i).innerText().catch(() => '')).replace(/\s+/g,' ').trim();
        if (/^\d/.test(text) && text.includes(',')) suggestions.push(text);
        if (matchesAddress(text, address)) matching.push({node:options.nth(i),text});
      }
      const unique = [...new Set(matching.map(item => normalizeAddress(item.text)))];
      if (unique.length === 1) { chosen = matching[0].node; chosenText = matching[0].text; }
    }
    if (!chosen) {
      if (attempt === 0) continue;
      return {success:false, outcome:'address_no_match', query, suggestions:[...new Set(suggestions)].slice(0,5)};
    }
    await chosen.click({timeout:10000});
    await page.waitForFunction(() => {
      const value = placeholder => [...document.querySelectorAll(`input[placeholder="${placeholder}"]`)]
        .find(el => el.getBoundingClientRect().width > 0)?.value;
      return value('Address Line 1') && value('Suburb / Locality') && value('State') &&
        document.querySelector('#lat-test-input')?.value && document.querySelector('#lng-test-input')?.value;
    }, null, {timeout:8000}).catch(() => null);
    const location = await page.evaluate(() => {
      const value = placeholder => [...document.querySelectorAll(`input[placeholder="${placeholder}"]`)]
        .find(el => el.getBoundingClientRect().width > 0)?.value || '';
      return {bookingAddress:value('Booking address'),addressLine1:value('Address Line 1'),
        addressLine2:value('Address Line 2'),suburb:value('Suburb / Locality'),state:value('State'),
        postcode:value('Postal / Zip code'),latitude:document.querySelector('#lat-test-input')?.value || '',
        longitude:document.querySelector('#lng-test-input')?.value || ''};
    });
    if (location.addressLine1 && location.suburb && location.state && location.latitude && location.longitude) {
      return {success:true, outcome:'address_selected', selectedText:chosenText, ...location};
    }
  }
  return {success:false, outcome:'address_selection_failed', query, selectedText:chosenText};
}
