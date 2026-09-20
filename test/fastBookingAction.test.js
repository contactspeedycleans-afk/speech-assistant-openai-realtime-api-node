import test from 'node:test';
import assert from 'node:assert/strict';
import { createFastBookingAction } from '../lib/fastBookingAction.js';

test('uses the one-pass Fast Booking action', async () => {
    let request;
    const action = createFastBookingAction({
        url: 'https://example.test/lisa/booking-action',
        secret: 'x',
        fetchImpl: async (_url, options) => {
            request = JSON.parse(options.body);
            return new Response(JSON.stringify({
                success: true,
                verified_created_in_octopus: true,
                bookingNumber: 'BOK-12345'
            }), { status: 200 });
        }
    });

    const result = await action({ customerName: 'Test Caller' });
    assert.equal(request.action, 'create_fast');
    assert.equal(request.customerConfirmed, true);
    assert.equal(result.bookingNumber, 'BOK-12345');
});

test('returns to the caller while booking continues in the background', async () => {
    let completeBackground;
    const backgroundDone = new Promise(resolve => { completeBackground = resolve; });
    const action = createFastBookingAction({
        url: 'https://example.test/lisa/booking-action',
        secret: 'x',
        callerWaitMs: 5,
        fetchImpl: async () => {
            await new Promise(resolve => setTimeout(resolve, 20));
            return new Response(JSON.stringify({
                success: true,
                verified_created_in_octopus: true,
                bookingNumber: 'BOK-67890'
            }), { status: 200 });
        },
        onBackgroundComplete: completeBackground
    });

    const result = await action({ customerName: 'Test Caller' });
    assert.equal(result.outcome, 'processing');
    assert.equal(result.backgroundCompletion, true);
    const finalResult = await backgroundDone;
    assert.equal(finalResult.bookingNumber, 'BOK-67890');
});
