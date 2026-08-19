const SMS_TOOLS = [
    {
        type: 'function',
        function: {
            name: 'search_company_knowledge',
            description: 'Search SpeedyCleans company knowledge when the answer is not already in the SMS instructions or account context.',
            parameters: {
                type: 'object',
                properties: {
                    query: { type: 'string' }
                },
                required: ['query'],
                additionalProperties: false
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'create_octopus_booking',
            description: 'Create one new OctopusPro booking only after the customer explicitly confirms the complete service, address, date, arrival window, duration and pricing.',
            parameters: {
                type: 'object',
                properties: {
                    customerName: { type: 'string' },
                    customerFirstName: { type: 'string' },
                    customerLastName: { type: 'string' },
                    customerPhone: { type: 'string' },
                    customerEmail: { type: 'string' },
                    serviceAddress: { type: 'string' },
                    streetNumber: { type: 'string' },
                    street: { type: 'string' },
                    city: { type: 'string' },
                    state: { type: 'string' },
                    zip: { type: 'string' },
                    serviceType: { type: 'string' },
                    requestedDate: { type: 'string', description: 'YYYY-MM-DD' },
                    requestedStartTime: { type: 'string', description: '24-hour HH:MM' },
                    arrivalWindow: { type: 'string' },
                    durationMinutes: { type: 'integer', minimum: 120 },
                    recurringFrequency: { type: 'string', enum: ['one_time', 'weekly', 'biweekly', 'triweekly', 'monthly'] },
                    quotedPrice: { type: 'number' },
                    specialRequests: { type: 'string' },
                    customerConfirmed: { type: 'boolean' }
                },
                required: ['customerName', 'customerFirstName', 'customerLastName', 'customerPhone', 'serviceAddress', 'streetNumber', 'street', 'city', 'state', 'zip', 'serviceType', 'requestedDate', 'requestedStartTime', 'arrivalWindow', 'durationMinutes', 'recurringFrequency', 'quotedPrice', 'customerConfirmed'],
                additionalProperties: false
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'lookup_octopus_booking',
            description: 'Securely look up one OctopusPro booking by BOK number for the recognized texting customer. This is read-only and must verify that the booking belongs to the caller before returning details.',
            parameters: {
                type: 'object',
                properties: {
                    bookingNumber: { type: 'string', description: 'OctopusPro BOK number, for example BOK-123456.' }
                },
                required: ['bookingNumber'],
                additionalProperties: false
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'cancel_octopus_booking',
            description: 'Cancel one exact future OctopusPro visit only after explicit customer confirmation. Never cancel an entire recurring series.',
            parameters: {
                type: 'object',
                properties: {
                    bookingId: { type: 'string' },
                    cancellationReason: { type: 'string' },
                    customerConfirmed: { type: 'boolean' },
                    cancellationScope: { type: 'string', enum: ['single_visit', 'recurring_series'] }
                },
                required: ['bookingId', 'cancellationReason', 'customerConfirmed', 'cancellationScope'],
                additionalProperties: false
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'reschedule_octopus_booking',
            description: 'Move one exact future OctopusPro visit after the customer explicitly confirms the exact new date and time.',
            parameters: {
                type: 'object',
                properties: {
                    bookingId: { type: 'string' },
                    requestedDate: { type: 'string', description: 'YYYY-MM-DD' },
                    requestedStartTime: { type: 'string', description: '24-hour HH:MM' },
                    customerConfirmed: { type: 'boolean' },
                    rescheduleScope: { type: 'string', enum: ['single_visit', 'recurring_series'] }
                },
                required: ['bookingId', 'requestedDate', 'requestedStartTime', 'customerConfirmed', 'rescheduleScope'],
                additionalProperties: false
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'lookup_octopus_billing',
            description: 'Read verified billing and card-on-file status for one recognized customer booking. Never collect full card details by SMS.',
            parameters: {
                type: 'object',
                properties: { bookingId: { type: 'string' } },
                required: ['bookingId'],
                additionalProperties: false
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'record_technician_status_update',
            description: 'For a recognized cleaner only: record their own en-route, arrived, started, completed, running-late or lockout update.',
            parameters: {
                type: 'object',
                properties: {
                    bookingNumber: { type: 'string' },
                    status: { type: 'string' },
                    note: { type: 'string' }
                },
                required: ['status'],
                additionalProperties: false
            }
        }
    }
];

function safeJson(value) {
    try {
        return JSON.parse(value || '{}');
    } catch {
        return {};
    }
}

function getDetroitDateContext() {
    const now = new Date();
    const parts = Object.fromEntries(
        new Intl.DateTimeFormat('en-US', {
            timeZone: 'America/Detroit',
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            weekday: 'long',
            hour: '2-digit',
            minute: '2-digit',
            hour12: true
        }).formatToParts(now)
            .filter((part) => part.type !== 'literal')
            .map((part) => [part.type, part.value])
    );

    return {
        isoDate: `${parts.year}-${parts.month}-${parts.day}`,
        weekday: parts.weekday,
        localTime: `${parts.hour}:${parts.minute} ${parts.dayPeriod}`,
        timezone: 'America/Detroit'
    };
}

function isValidFutureOrTodayDetroitDate(value) {
    const date = String(value || '').trim();
    return /^\d{4}-\d{2}-\d{2}$/.test(date) && date >= getDetroitDateContext().isoDate;
}

function summarizeBookings(bookings = []) {
    return bookings.map((booking) => ({
        bookingId: booking.booking_number || booking.octopus_booking_id || booking.id,
        octopusBookingId: booking.octopus_booking_id || null,
        date: booking.booking_date || null,
        arrivalWindow: booking.arrival_window || null,
        status: booking.status || null,
        serviceType: booking.service_type || null,
        total: booking.final_total || booking.estimated_total || null
    }));
}

async function runRealtimeHandler(handler, name, args, context = {}) {
    let output = null;
    const socket = {
        readyState: 1,
        send(raw) {
            const event = safeJson(raw);
            if (event.type === 'conversation.item.create' && event.item?.type === 'function_call_output') {
                output = safeJson(event.item.output);
            }
        }
    };

    await handler({
        response: {
            type: 'response.function_call_arguments.done',
            name,
            call_id: `sms-${Date.now()}`,
            arguments: JSON.stringify(args || {})
        },
        openAiWs: socket,
        WebSocket: { OPEN: 1 },
        ...context
    });

    return output || { success: false, error: 'The requested action returned no result.' };
}

async function createOctopusBooking(args, customerPhone) {
    if (args.customerConfirmed !== true) {
        return { success: false, outcome: 'confirmation_required', error: 'The customer must explicitly confirm the complete booking first.' };
    }

    const required = ['customerName', 'customerFirstName', 'customerLastName', 'serviceAddress', 'streetNumber', 'street', 'city', 'state', 'zip', 'serviceType', 'requestedDate', 'requestedStartTime', 'arrivalWindow'];
    const missing = required.filter((key) => !String(args[key] || '').trim());
    if (missing.length || Number(args.durationMinutes) < 120 || !Number.isFinite(Number(args.quotedPrice))) {
        return { success: false, outcome: 'missing_booking_details', missing };
    }

    if (!isValidFutureOrTodayDetroitDate(args.requestedDate)) {
        return {
            success: false,
            outcome: 'invalid_or_past_booking_date',
            error: `The requested booking date must be today or later in America/Detroit. Today is ${getDetroitDateContext().isoDate}. No booking was created.`
        };
    }

    const url = String(process.env.OCTOPUS_CREATE_BOOKING_WEBHOOK_URL || '').trim();
    if (!url) {
        return {
            success: false,
            outcome: 'connector_not_configured',
            staff_review_required: true,
            error: 'The OctopusPro create-booking connector is not configured. No booking was created.'
        };
    }

    const response = await fetch(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            ...(process.env.OCTOPUS_CREATE_BOOKING_SECRET
                ? { 'X-Emma-Secret': process.env.OCTOPUS_CREATE_BOOKING_SECRET }
                : {})
        },
        body: JSON.stringify({
            ...args,
            customerPhone,
            source: 'EMMA_SMS'
        }),
        signal: AbortSignal.timeout(45000)
    });

    const text = await response.text();
    const result = safeJson(text);
    const bookingId = result.bookingId || result.booking_id || result.octopusBookingId || result.octopus_booking_id;
    const bookingNumber = result.bookingNumber || result.booking_number || result.bokNumber;
    const verified = response.ok && result.success === true && Boolean(bookingId || bookingNumber);

    return {
        ...result,
        success: verified,
        verified_created_in_octopus: verified,
        bookingId: bookingId || null,
        bookingNumber: bookingNumber || null,
        ...(verified ? {} : {
            outcome: result.outcome || 'verification_failed',
            error: result.error || 'OctopusPro did not return a verified booking ID. No booking was promised.'
        })
    };
}

export async function runSmsReceptionist({
    openAiApiKey,
    model,
    systemMessage,
    history,
    customer,
    technician,
    customerBookings,
    customerPhone,
    searchCompanyKnowledge,
    handlers
}) {
    const identity = technician
        ? { role: 'technician', id: technician.id, name: technician.full_name || `${technician.first_name || ''} ${technician.last_name || ''}`.trim() }
        : customer
            ? {
                role: 'customer',
                id: customer.id,
                name: `${customer.first_name || ''} ${customer.last_name || ''}`.trim(),
                firstName: customer.first_name || '',
                lastName: customer.last_name || '',
                email: customer.email || '',
                serviceAddress: customer.address || '',
                streetNumber: customer.street_number || '',
                street: customer.street_address || '',
                city: customer.city || customer.suburb || '',
                state: customer.state || '',
                zip: customer.zip || customer.postcode || ''
            }
            : { role: 'unknown', name: '' };

    const contextMessage = [
        'LIVE VERIFIED ACCOUNT CONTEXT:',
        JSON.stringify({
            currentDateTime: getDetroitDateContext(),
            identity,
            futureBookings: summarizeBookings(customerBookings)
        }),
        `DATE AUTHORITY: Today is ${getDetroitDateContext().weekday}, ${getDetroitDateContext().isoDate}, and the local time is ${getDetroitDateContext().localTime} in America/Detroit. Resolve today, tomorrow, weekdays, and relative dates from this exact date. Never create or move a booking into the past.`,
        'Use only these verified records. Never expose private details before appropriate verification.',
        'Never say created, cancelled, rescheduled, paid, or completed unless the corresponding tool returns success true and a verification field when applicable.',
        technician
            ? 'This sender is a recognized cleaner. Cleaner operational updates are allowed; customer booking cancellation and customer billing disclosure are not.'
            : 'This sender is not a recognized cleaner. Never record a cleaner status update for them.'
    ].join('\n');

    const messages = [
        { role: 'system', content: systemMessage },
        { role: 'system', content: contextMessage },
        ...history
    ];

    let action = 'conversation';
    let actionResult = null;

    for (let round = 0; round < 5; round += 1) {
        const response = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${openAiApiKey}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                model,
                temperature: 0.35,
                messages,
                tools: SMS_TOOLS,
                tool_choice: 'auto'
            })
        });

        if (!response.ok) {
            throw new Error(`OpenAI SMS response failed (${response.status}): ${(await response.text()).slice(0, 500)}`);
        }

        const data = await response.json();
        const message = data.choices?.[0]?.message;
        if (!message) throw new Error('Emma generated no SMS response.');

        messages.push(message);
        const calls = message.tool_calls || [];
        if (!calls.length) {
            return {
                reply: String(message.content || '').trim(),
                identity,
                action,
                actionResult,
                futureBookings: summarizeBookings(customerBookings)
            };
        }

        for (const call of calls) {
            const name = call.function?.name;
            const args = safeJson(call.function?.arguments);
            let result;
            action = name || 'unknown_tool';

            if (name === 'search_company_knowledge') {
                try {
                    result = { success: true, results: await searchCompanyKnowledge(args.query || '') };
                } catch (error) {
                    result = { success: false, error: error.message };
                }
            } else if (name === 'create_octopus_booking') {
                result = await createOctopusBooking(args, customerPhone);
            } else if (name === 'lookup_octopus_booking') {
                if (technician) {
                    result = { success: false, error: 'Cleaner identities cannot access customer booking details through SMS.' };
                } else {
                    result = await runRealtimeHandler(
                        handlers.handleBillingLookupTool,
                        'lookup_octopus_billing',
                        { bookingId: args.bookingNumber },
                        { callerPhone: customerPhone, customerBookings }
                    );
                    if (result?.success === true) {
                        result = {
                            ...result,
                            action: 'booking_lookup',
                            bookingNumber: result.booking_number || args.bookingNumber,
                            bookingId: result.booking_id || result.octopus_booking_id || null,
                            verifiedForCaller: true,
                            read_only: true
                        };
                    }
                }
            } else if (name === 'cancel_octopus_booking') {
                if (technician) {
                    result = { success: false, error: 'Cleaner identities cannot cancel customer bookings through SMS.' };
                } else {
                    result = await runRealtimeHandler(handlers.handleCancelBookingTool, name, args, { customerBookings });
                }
            } else if (name === 'reschedule_octopus_booking') {
                if (technician) {
                    result = { success: false, error: 'Cleaner identities cannot reschedule customer bookings through SMS.' };
                } else if (!isValidFutureOrTodayDetroitDate(args.requestedDate)) {
                    result = {
                        success: false,
                        outcome: 'invalid_or_past_reschedule_date',
                        error: `The requested reschedule date must be today or later in America/Detroit. Today is ${getDetroitDateContext().isoDate}. No appointment was changed.`
                    };
                } else {
                    result = await runRealtimeHandler(handlers.handleRescheduleBookingTool, name, args, { customerBookings });
                }
            } else if (name === 'lookup_octopus_billing') {
                if (technician) {
                    result = { success: false, error: 'Cleaner identities cannot access customer billing through SMS.' };
                } else {
                    result = await runRealtimeHandler(handlers.handleBillingLookupTool, name, args, { callerPhone: customerPhone, customerBookings });
                }
            } else if (name === 'record_technician_status_update') {
                if (!technician) {
                    result = { success: false, error: 'This phone number is not matched to a recognized cleaner.' };
                } else {
                    result = await runRealtimeHandler(handlers.handleTechnicianStatusTool, name, args, { callerPhone: customerPhone });
                }
            } else {
                result = { success: false, error: 'Unsupported tool.' };
            }

            actionResult = result;
            messages.push({
                role: 'tool',
                tool_call_id: call.id,
                content: JSON.stringify(result)
            });
        }
    }

    throw new Error('Emma used too many SMS tool steps without completing a response.');
}
