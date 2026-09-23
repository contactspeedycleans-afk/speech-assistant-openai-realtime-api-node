const DEFAULT_BOOKING_LINK = 'https://speedycleans.com/get-a-quote';

export function normalizeUsPhone(value = '') {
    const digits = String(value || '').replace(/\D/g, '');
    if (digits.length === 10) return `1${digits}`;
    if (digits.length === 11 && digits.startsWith('1')) return digits;
    return '';
}

export function createLsaLineMatcher(configuredNumbers = '') {
    const configured = new Set(
        String(configuredNumbers || '')
            .split(',')
            .map(normalizeUsPhone)
            .filter(Boolean)
    );

    return (phoneNumber = '') => {
        const normalized = normalizeUsPhone(phoneNumber);
        if (!normalized) return false;
        if (configured.size > 0) return configured.has(normalized);

        // Safe default for the dedicated 248-area-code LSA destination.
        return normalized.startsWith('1248');
    };
}

export function buildLsaBookingLinkSms({
    bookingLink = DEFAULT_BOOKING_LINK,
    offerText = ''
} = {}) {
    const link = String(bookingLink || DEFAULT_BOOKING_LINK).trim();
    const offer = String(offerText || '').trim();
    const offerSentence = offer
        ? ` ${offer}`
        : ' Ask Lisa about any eligible booking offer.';

    return `SpeedyCleans here - see availability and start booking in about a minute: ${link}\n${offerSentence.trim()} Prefer to stay on the call? Lisa can book you fast. Reply STOP to opt out.`;
}
