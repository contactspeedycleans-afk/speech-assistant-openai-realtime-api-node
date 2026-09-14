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


export function validateSelectedLocation(location, selectedText) {
  const selectedStreet = String(selectedText || '').split(',')[0].trim();
  const line1 = normalizeAddress(location.addressLine1);
  const combined = normalizeAddress(`${location.addressLine1 || ''} ${location.addressLine2 || ''}`);
  const expected = normalizeAddress(selectedStreet);
  const latitude = Number(location.latitude);
  const longitude = Number(location.longitude);
  const valid = expected && (line1 === expected || combined === expected) &&
    location.suburb && location.state && String(location.latitude || '').trim() &&
    String(location.longitude || '').trim() && Number.isFinite(latitude) &&
    Number.isFinite(longitude) && Math.abs(latitude) <= 90 && Math.abs(longitude) <= 180;
  if (!valid) return {success:false, outcome:'address_selection_failed', selectedText, ...location};
  return {success:true, outcome:'address_selected', selectedText, ...location,
    // Lisa consumes a complete street line; keep the native split separately.
    nativeAddressLine1:location.addressLine1,
    nativeAddressLine2:location.addressLine2,
    addressLine1:selectedStreet};
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

    // Wait for the active location editor; hidden copies of the map inputs
    // exist elsewhere on the updated booking page.
    const lineSelector = 'input[placeholder="Address Line 1"]:visible';
    let lineInput = page.locator(lineSelector).first();
    await lineInput.waitFor({state:'visible', timeout:4000}).catch(() => null);
    if (!(await lineInput.isVisible())) {
      const pin = page.getByText('Pin Location on Map', {exact:true});
      if (await pin.isVisible()) await pin.click({timeout:10000});
      await lineInput.waitFor({state:'visible', timeout:10000});
    }
    const field = placeholder => page.locator(`input[placeholder="${placeholder}"]:visible`).first();
    const read = async placeholder => {
      const locator = field(placeholder);
      return await locator.count() ? (await locator.inputValue()).trim() : '';
    };
    // Let Google finish populating the native fields before filling omissions.
    for (let poll = 0; poll < 20; poll++) {
      if (await read('Address Line 1') && await read('State') &&
          await read('Latitude') && await read('Longitude')) break;
      await page.waitForTimeout(200);
    }
    const selectedParts = chosenText.split(',').map(value => value.trim());
    const selectedStreet = selectedParts[0];
    const selectedCity = selectedParts[1] || String(address.suburb || '');
    const selectedState = String(address.state || '');
    // Octopus may split the house number and street between lines 1 and 2.
    // Preserve its populated fields, and derive missing parts from the actual
    // selected suggestion, never from a partial speech transcription.
    const currentLine2 = await read('Address Line 2');
    const missingLine1 = normalizeAddress(currentLine2) ===
      normalizeAddress(selectedStreet.replace(/^\d+[a-z-]*\s+/i, ''))
      ? (selectedStreet.match(/^\d+[a-z-]*/i)?.[0] || selectedStreet)
      : selectedStreet;
    for (const [placeholder, fallback] of [
      ['Address Line 1', missingLine1],
      ['Suburb / Locality', selectedCity],
      ['State', selectedState],
      ['Postal / Zip code', postcode],
    ]) {
      if (!(await read(placeholder)) && fallback) {
        await field(placeholder).fill(fallback);
        await field(placeholder).press('Tab');
      }
    }
    const location = {
      bookingAddress:await read('Booking address'),
      addressLine1:await read('Address Line 1'),
      addressLine2:await read('Address Line 2'),
      suburb:await read('Suburb / Locality'),
      state:await read('State'),
      postcode:await read('Postal / Zip code'),
      latitude:await read('Latitude'),
      longitude:await read('Longitude'),
    };
    return validateSelectedLocation(location, chosenText);

  }
  return {success:false, outcome:'address_no_match', query:fullQuery,
    suggestions:[...new Set(lastSuggestions)].slice(0,5), selectedText:chosenText};
}
