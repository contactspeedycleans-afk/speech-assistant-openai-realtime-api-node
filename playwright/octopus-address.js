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

export function matchesStreetAndState(text, address) {
  const parts = String(text || '').split(',').map(normalizeAddress);
  const street = normalizeAddress(`${address.streetNumber} ${address.streetAddress}`);
  const state = normalizeAddress(address.state).replace(/^michigan\b/, 'mi');
  const regions = parts.slice(2).map(value =>
    normalizeAddress(value).replace(/^michigan\b/, 'mi'));
  return parts.length >= 3 && parts[0] === street &&
    regions.some(part => part === state ||
      (part.startsWith(state + ' ') && /^\d{5}(?: \d{4})?$/.test(part.slice(state.length + 1))));
}

function addressCandidateParts(text) {
  const parts = String(text || '').split(',').map(part => part.trim());
  const first = normalizeAddress(parts[0]);
  const match = first.match(/^(\d+[a-z]?)\s+(.+)$/);
  return {
    number: match?.[1] || '',
    street: match?.[2] || '',
    city: normalizeAddress(parts[1]),
    regions: parts.slice(2).map(normalizeAddress),
  };
}

export function scoreAddressCandidate(text, address) {
  const candidate = addressCandidateParts(text);
  const wantedNumber = normalizeAddress(address.streetNumber);
  const wantedStreet = normalizeAddress(address.streetAddress);
  if (!candidate.number || !candidate.street || !wantedNumber || !wantedStreet) return -1;

  let score = 0;
  if (candidate.number === wantedNumber) score += 50;
  else {
    const shorter = candidate.number.length < wantedNumber.length ? candidate.number : wantedNumber;
    const longer = candidate.number.length < wantedNumber.length ? wantedNumber : candidate.number;
    if (shorter.length >= 3 && longer.endsWith(shorter) && longer.length - shorter.length <= 2) score += 35;
    else return -1;
  }

  if (candidate.street === wantedStreet) score += 35;
  else if (candidate.street.startsWith(wantedStreet) || wantedStreet.startsWith(candidate.street)) score += 30;
  else return -1;

  const wantedCity = normalizeAddress(address.suburb);
  const wantedState = normalizeAddress(address.state).replace(/^michigan\b/, 'mi');
  const wantedPostcode = normalizeAddress(address.postcode);
  if (wantedCity) score += candidate.city === wantedCity ? 20 : -20;
  if (wantedState) {
    if (!candidate.regions.some(part => part === wantedState || part.startsWith(wantedState + ' '))) return -1;
    score += 15;
  }
  if (wantedPostcode) {
    if (!candidate.regions.some(part => part.includes(wantedPostcode))) return -1;
    score += 15;
  }
  return score;
}

export function chooseClosestAddress(texts, address) {
  const scored = texts
    .map((text, index) => ({text, index, score:scoreAddressCandidate(text, address)}))
    .filter(item => item.score >= 60)
    .sort((a, b) => b.score - a.score);
  if (!scored.length) return null;
  if (scored[1] && scored[0].score - scored[1].score < 15) return null;
  return scored[0];
}

export async function selectOctopusAddress(page, address) {
  const postcode = String(address.postcode || '').trim();
  const fullQuery = `${address.streetNumber} ${address.streetAddress}, ${address.suburb}, ${address.state}${postcode ? ` ${postcode}` : ''}`;
  // Start with exactly what the customer said. Octopus/Google often expands a
  // short phrase such as "4247 roll" to the full local address by itself.
  const partialQuery = `${address.streetNumber} ${address.streetAddress}`.trim();
  const queries = [partialQuery];
  if (address.suburb || address.state || postcode) queries.push(fullQuery);
  if (postcode) {
    // Google/Octopus can return the postal locality instead of the city spoken
    // by the customer. A ZIP-assisted query lets Octopus resolve that official
    // locality without Lisa guessing a different street or house number.
    queries.push(`${address.streetNumber} ${address.streetAddress}, ${address.state} ${postcode}`);
  }
  const uniqueQueries = [...new Set(queries.filter(Boolean))];
  const input = page.locator('input[placeholder="Booking address"]').first();
  await input.waitFor({state:'visible', timeout:15000});
  let chosenText = '';
  let lastSuggestions = [];
  // At most two bounded queries: the customer's complete address first, then
  // an optional ZIP-assisted form that allows Google's official locality.
  for (const query of uniqueQueries) {
    await input.fill('');
    await input.click();
    // Real keystrokes reliably trigger the Google Places listener used by the
    // native Octopus booking form. fill() alone intermittently leaves an empty
    // suggestion list even though the same address autocompletes for a person.
    await input.type(query, {delay: 12});
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
      // If Octopus supplies a different official postal locality, accept it
      // only when there is exactly one suggestion with the exact house number,
      // exact street, and exact state. This keeps wrong-city/state suggestions
      // out while handling legitimate township and mailing-city differences.
      if (!matching.length) {
        const safeFallback = texts
          .map((text, index) => ({node:options.nth(index), text}))
          .filter(item => matchesStreetAndState(item.text, address));
        const uniqueFallback = [...new Set(
          safeFallback.map(item => normalizeAddress(item.text))
        )];
        if (uniqueFallback.length === 1) matching.push(safeFallback[0]);
      }
      // Speech transcription can omit leading house-number digits or leave a
      // partial street word. Select a correction only when one candidate is a
      // clearly better number-suffix/street-prefix match than every alternative.
      if (!matching.length) {
        const closest = chooseClosestAddress(texts, address);
        if (closest) matching.push({node:options.nth(closest.index), text:closest.text});
      }
      const unique = [...new Set(matching.map(item => normalizeAddress(item.text)))];
      if (unique.length === 1) { chosen = matching[0].node; chosenText = matching[0].text; }
    }
    lastSuggestions = suggestions;
    if (!chosen) {
      continue;
    }
    await chosen.click({timeout:10000});

    // Octopus' updated booking form can accept the autocomplete choice without
    // opening the required map/location dialog. Explicitly open the pin control
    // beside this address field when the parsed location inputs are still absent.
    const visibleAddressLine = page
      .locator('input[placeholder="Address Line 1"]:visible')
      .first();
    if (!(await visibleAddressLine.isVisible().catch(() => false))) {
      const pinLocationLink = input
        .locator('xpath=..')
        .getByRole('link')
        .filter({ visible: true })
        .first();
      if (await pinLocationLink.isVisible().catch(() => false)) {
        console.log('Opening Octopus pin-location confirmation...');
        await pinLocationLink.click({ force: true, timeout: 10000 });
      }
    }

    await page.waitForFunction(() => {
      const value = placeholder => [...document.querySelectorAll(`input[placeholder="${placeholder}"]`)]
        .find(el => el.getBoundingClientRect().width > 0)?.value;
      return value('Address Line 1') && value('State') &&
        document.querySelector('#lat-test-input')?.value && document.querySelector('#lng-test-input')?.value;
    }, null, {timeout:8000}).catch(() => null);
    // Google can omit locality for township addresses even when the exact
    // selected suggestion and coordinates are correct. Fill only that blank
    // component from the locality already matched above; never change a number.
    const addressLineInput = page.locator('input[placeholder="Address Line 1"]:visible').first();
    if (await addressLineInput.count() && !(await addressLineInput.inputValue()).trim()) {
      await addressLineInput.fill(`${address.streetNumber} ${address.streetAddress}`.trim());
      await page.keyboard.press('Tab');
    }
    const suburbInput = page.locator('input[placeholder="Suburb / Locality"]:visible').first();
    if (await suburbInput.count() && !(await suburbInput.inputValue()).trim()) {
      await suburbInput.fill(String(address.suburb));
      await page.keyboard.press('Tab');
    }
    const stateInput = page.locator('input[placeholder="State"]:visible').first();
    if (await stateInput.count() && !(await stateInput.inputValue()).trim()) {
      await stateInput.fill(String(address.state));
      await page.keyboard.press('Tab');
    }
    const postcodeInput = page.locator('input[placeholder="Postal / Zip code"]:visible').first();
    if (await postcodeInput.count() && !(await postcodeInput.inputValue()).trim() && postcode) {
      await postcodeInput.fill(postcode);
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
  return {success:false, outcome:'address_no_match', query:fullQuery,
    suggestions:[...new Set(lastSuggestions)].slice(0,5), selectedText:chosenText};
}
