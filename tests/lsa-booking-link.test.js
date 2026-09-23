import test from 'node:test';
import assert from 'node:assert/strict';
import {
    buildLsaBookingLinkSms,
    createLsaLineMatcher,
    normalizeUsPhone
} from '../lib/lsaBookingLink.js';

test('normalizes common US phone formats', () => {
    assert.equal(normalizeUsPhone('(248) 555-0100'), '12485550100');
    assert.equal(normalizeUsPhone('+1 248 555 0100'), '12485550100');
    assert.equal(normalizeUsPhone('private'), '');
});

test('defaults to the 248 LSA destination when no number is configured', () => {
    const isLsaLine = createLsaLineMatcher();
    assert.equal(isLsaLine('+1 (248) 555-0100'), true);
    assert.equal(isLsaLine('+1 (810) 510-0055'), false);
});

test('configured LSA numbers override the area-code fallback', () => {
    const isLsaLine = createLsaLineMatcher('+1 810 555 0100, 517-555-0199');
    assert.equal(isLsaLine('+1 810 555 0100'), true);
    assert.equal(isLsaLine('+1 248 555 0100'), false);
});

test('booking text combines speed, availability, an offer, and opt-out language', () => {
    const body = buildLsaBookingLinkSms({
        bookingLink: 'https://speedycleans.com/get-a-quote'
    });
    assert.match(body, /availability/i);
    assert.match(body, /about a minute/i);
    assert.match(body, /eligible booking offer/i);
    assert.match(body, /Reply STOP/i);
    assert.match(body, /https:\/\/speedycleans\.com\/get-a-quote/);
});

