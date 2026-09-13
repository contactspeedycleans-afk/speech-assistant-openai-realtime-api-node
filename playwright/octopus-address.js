export function normalizeAddress(value) {
  return String(value || '').toLowerCase()
    .replace(/\b(?:road|street|avenue|court|drive|lane|boulevard|place|terrace|highway)\b/g,
      word => ({road:'rd',street:'st',avenue:'ave',court:'ct',drive:'dr',lane:'ln',boulevard:'blvd',place:'pl',terrace:'ter',highway:'hwy'}[word]))
    .replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');
}

export function matchesAddress(text, address) {
  const parts = String(text || '').split(',').map(normalizeAddress);
  const street = normalizeAddress(`${address.streetNumber} ${address.streetAddress}`);
  const locality = value => normalizeAddress(value)
    .replace(/^charter township of (.+)$/, '$1 township')
    .replace(/\bcharter township\b/g, 'township')
    .replace(/\btwp\b/g, 'township');
  const region = value => normalizeAddress(value).replace(/^michigan\b/, 'mi');
  const city = locality(address.suburb);
  const state = region(address.state);
  // Octopus sometimes inserts a county between locality and state. Preserve
  // exact house/street/locality; accept state only as a complete region field.
  const regions = parts.slice(2).map(region);
  return parts.length >= 3 && parts[0] === street && locality(parts[1]) === city &&
    regions.some(part => part === state ||
      (part.startsWith(state + ' ') && /^\d{5}(?: \d{4})?$/.test(part.slice(state.length + 1))));
}

export async function selectOctopusAddress(page, address) {
  const query = `${address.streetNumber} ${address.streetAddress}, ${address.suburb}, ${address.state}`;
  const input = page.locator('input[placeholder="Booking address"]').first();
  await input.waitFor({state:'visible', timeout:15000});
  let chosenText = '';
  // One bounded query. A rejected spelling must not trigger another identical search.
  for (let attempt = 0; attempt < 1; attempt++) {
    await input.fill('');
    await input.fill(query);
    const options = page.locator('[role="option"]:visible, .pac-item:visible, .vs__dropdown-option:visible, li:visible');
    let chosen = null;
    let suggestions = [];
    for (let poll = 0; poll < 10 && !chosen; poll++) {
      await page.waitForTimeout(250);
      // Read once across the process boundary, instead of dozens of slow
      // locator reads for unrelated navigation list items on every poll.
      const texts = await options.evaluateAll(nodes => nodes.map(x => (x.innerText || '').replace(/\s+/g,' ').trim()));
      suggestions = [];
      const matching = [];
      for (let i = 0; i < texts.length; i++) {
        const text = texts[i];
        if (/^\d/.test(text) && text.includes(',')) suggestions.push(text);
        if (matchesAddress(text, address)) matching.push({node:options.nth(i),text});
      }
      const unique = [...new Set(matching.map(item => normalizeAddress(item.text)))];
      if (unique.length === 1) { chosen = matching[0].node; chosenText = matching[0].text; }
    }
    if (!chosen) {
      return {success:false, outcome:'address_no_match', query, suggestions:[...new Set(suggestions)].slice(0,5)};
    }
    await chosen.click({timeout:10000});
    await page.waitForFunction(() => {
      const value = placeholder => [...document.querySelectorAll(`input[placeholder="${placeholder}"]`)]
        .find(el => el.getBoundingClientRect().width > 0)?.value;
      return value('Address Line 1') && value('State') &&
        document.querySelector('#lat-test-input')?.value && document.querySelector('#lng-test-input')?.value;
    }, null, {timeout:8000}).catch(() => null);
    // Google can omit locality for township addresses even when the exact
    // selected suggestion and coordinates are correct. Fill only that blank
    // component from the locality already matched above; never change a number.
    const suburbInput = page.locator('input[placeholder="Suburb / Locality"]:visible').first();
    if (await suburbInput.count() && !(await suburbInput.inputValue()).trim()) {
      await suburbInput.fill(String(address.suburb));
      await page.keyboard.press('Tab');
    }
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
    return {success:false, outcome:'address_selection_failed', selectedText:chosenText, ...location};
  }
  return {success:false, outcome:'address_selection_failed', query, selectedText:chosenText};
}
