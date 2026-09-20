const DEFAULT_FAST_BOOKING_URL =
    'https://lisa-fast-booking-test-production.up.railway.app/lisa/booking-action';

async function postFastBooking(url, secret, payload, fetchImpl) {
    const response = await fetchImpl(url, {
        method: 'POST',
        headers: {
            'content-type': 'application/json',
            'x-lisa-secret': secret
        },
        body: JSON.stringify({
            ...payload,
            action: 'create_fast',
            customerConfirmed: true,
            fieldworkerName: 'Unassigned Tasks Manager',
            source: 'EMMA_LIVE_CALL_FAST'
        }),
        signal: AbortSignal.timeout(180000)
    });

    const text = await response.text();
    let result;
    try {
        result = JSON.parse(text);
    } catch {
        throw new Error(`Fast Booking returned HTTP ${response.status} with invalid JSON`);
    }

    if (!response.ok) {
        throw new Error(result?.error || `Fast Booking returned HTTP ${response.status}`);
    }
    return result;
}

export function createFastBookingAction({
    fetchImpl = fetch,
    url = process.env.LISA_FAST_BOOKING_ACTION_URL || DEFAULT_FAST_BOOKING_URL,
    secret = process.env.LISA_FAST_BOOKING_SECRET || process.env.LISA_ACTION_SECRET,
    callerWaitMs = 28000,
    onBackgroundComplete = () => {},
    onBackgroundError = () => {}
} = {}) {
    return async payload => {
        const endpoint = String(url || '').trim();
        const actionSecret = String(secret || '').trim();
        if (!endpoint || !actionSecret) {
            throw new Error('Fast Booking connection is not configured.');
        }

        const request = postFastBooking(endpoint, actionSecret, payload, fetchImpl);
        const timeoutMarker = Symbol('caller_wait_expired');
        let timeoutId;
        const callerTimeout = new Promise(resolve => {
            timeoutId = setTimeout(() => resolve(timeoutMarker), callerWaitMs);
        });
        const result = await Promise.race([request, callerTimeout]);
        clearTimeout(timeoutId);

        if (result === timeoutMarker) {
            request.then(onBackgroundComplete).catch(onBackgroundError);
            return {
                success: false,
                verified_created_in_octopus: false,
                outcome: 'processing',
                backgroundCompletion: true,
                customer_message:
                    'I have submitted your appointment and Octopus is processing it in the background. Continue the conversation without hold music. You may ask one optional question about entry instructions, pets, or special notes while it processes, but do not repeat the address, phone number, date, time, service, or price. The booking number will be texted and emailed when ready. Do not say Octopus confirmed it yet and do not call the booking tool again.'
            };
        }

        return result;
    };
}
