import { spawn } from 'node:child_process';

export function createOpenAiToolHandlers({
    searchCompanyKnowledge,
    recordTechnicianStatusUpdate,
    db
}) {
    async function handleKnowledgeTool({
        response,
        openAiWs,
        WebSocket
    }) {
        if (
            response.type ===
            'response.function_call_arguments.done'
        ) {
            console.log(
                'Knowledge handler received:',
                response.type,
                response.name
            );
        }

        if (
            response.type !==
                'response.function_call_arguments.done' ||
            response.name !==
                'search_company_knowledge'
        ) {
            return false;
        }

        let toolArguments = {};

        try {
            toolArguments = JSON.parse(
                response.arguments || '{}'
            );
        } catch (error) {
            console.error(
                'Could not parse knowledge tool arguments:',
                error
            );
        }

        console.log(
            'Knowledge tool arguments:',
            toolArguments
        );

        let toolOutput;

        try {
            const knowledgeResults =
                await searchCompanyKnowledge(
                    toolArguments.query
                );

            toolOutput = JSON.stringify({
                query: toolArguments.query || '',
                results: knowledgeResults
            });
        } catch (error) {
            console.error(
                'Company knowledge search failed:',
                error
            );

            toolOutput = JSON.stringify({
                query: toolArguments.query || '',
                results: [],
                error:
                    'The company knowledge search was temporarily unavailable.'
            });
        }

        if (openAiWs.readyState === WebSocket.OPEN) {
            openAiWs.send(
                JSON.stringify({
                    type: 'conversation.item.create',
                    item: {
                        type: 'function_call_output',
                        call_id: response.call_id,
                        output: toolOutput
                    }
                })
            );

            openAiWs.send(
                JSON.stringify({
                    type: 'response.create'
                })
            );
        }

        return true;
    }

    async function handleTechnicianStatusTool({
        response,
        openAiWs,
        WebSocket,
        callerPhone
    }) {
        if (
            response.type !==
                'response.function_call_arguments.done' ||
            response.name !==
                'record_technician_status_update'
        ) {
            return false;
        }

        let toolArguments = {};

        try {
            toolArguments = JSON.parse(
                response.arguments || '{}'
            );
        } catch (error) {
            console.error(
                'Could not parse technician tool arguments:',
                error
            );
        }

        let toolOutput;

        try {
            const savedUpdate =
                await recordTechnicianStatusUpdate({
                    bookingNumber:
                        toolArguments.bookingNumber || '',
                    technicianName:
                        toolArguments.technicianName || '',
                    status:
                        toolArguments.status || '',
                    reportedTime:
                        toolArguments.reportedTime || '',
                    notes:
                        toolArguments.notes || '',
                    callerPhone
                });

            toolOutput = JSON.stringify({
                success: true,
                updateId: savedUpdate.id,
                createdAt: savedUpdate.created_at
            });
        } catch (error) {
            console.error(
                'Technician update failed:',
                error
            );

            toolOutput = JSON.stringify({
                success: false,
                error:
                    error.message ||
                    'Unable to save technician update.'
            });
        }

        if (openAiWs.readyState === WebSocket.OPEN) {
            openAiWs.send(
                JSON.stringify({
                    type: 'conversation.item.create',
                    item: {
                        type: 'function_call_output',
                        call_id: response.call_id,
                        output: toolOutput
                    }
                })
            );

            openAiWs.send(
                JSON.stringify({
                    type: 'response.create'
                })
            );
        }

        return true;
    }

    async function resolveInternalBookingId(
        rawBookingId,
        customerBookings = []
    ) {
        const digits = String(rawBookingId || '')
            .replace(/\D/g, '');

        if (!digits) {
            throw new Error(
                'A valid BOK number or Octopus booking ID is required.'
            );
        }

        if (!db) {
            throw new Error(
                'The booking database connection is unavailable.'
            );
        }

        const bokNumber = `BOK-${digits}`;
        const result = await db.query(
            `
            SELECT
                octopus_booking_id::text AS internal_booking_id,
                booking_number::text AS booking_number
            FROM public.booking_tracking
            WHERE
                UPPER(TRIM(booking_number::text)) = $1
                OR REGEXP_REPLACE(
                    booking_number::text,
                    '[^0-9]',
                    '',
                    'g'
                ) = $2
            ORDER BY id DESC
            LIMIT 1
            `,
            [bokNumber, digits]
        );

        const mappedId = Number(
            result.rows[0]?.internal_booking_id
        );

        if (Number.isInteger(mappedId) && mappedId > 0) {
            console.log('Resolved Octopus booking number:', {
                suppliedBookingId: rawBookingId,
                bookingNumber:
                    result.rows[0]?.booking_number ||
                    bokNumber,
                internalBookingId: mappedId
            });

            return mappedId;
        }

        const inactiveStatuses = new Set([
            'cancelled',
            'canceled',
            'completed',
            'failed'
        ]);
        const now = Date.now();
        const activeCustomerBookings = customerBookings
            .filter(booking => {
                const status = String(
                    booking.status || ''
                ).trim().toLowerCase();
                const bookingTime = new Date(
                    booking.booking_date
                ).getTime();

                return (
                    !inactiveStatuses.has(status) &&
                    Number.isFinite(bookingTime) &&
                    bookingTime >= now - 12 * 60 * 60 * 1000
                );
            })
            .map(booking => ({
                ...booking,
                resolvedInternalId: Number(
                    String(
                        booking.octopus_booking_id || ''
                    ).replace(/\D/g, '')
                )
            }))
            .filter(booking =>
                Number.isInteger(
                    booking.resolvedInternalId
                ) &&
                booking.resolvedInternalId > 0
            );

        if (activeCustomerBookings.length === 1) {
            const onlyBooking = activeCustomerBookings[0];

            console.log(
                'BOK mapping missing; using the recognized caller\'s only active future booking:',
                {
                    suppliedBookingId: rawBookingId,
                    internalBookingId:
                        onlyBooking.resolvedInternalId,
                    bookingDate:
                        onlyBooking.booking_date,
                    status: onlyBooking.status
                }
            );

            return onlyBooking.resolvedInternalId;
        }

        if (activeCustomerBookings.length > 1) {
            throw new Error(
                `${bokNumber} was not mapped, and this caller has multiple active future bookings. Ask which appointment date they mean.`
            );
        }

        const numericId = Number(digits);

        // Octopus internal IDs in this account are six-digit IDs.
        // A shorter value is normally the visible BOK number and must
        // never be sent directly to /booking/view/.
        if (Number.isInteger(numericId) && numericId >= 100000) {
            console.log(
                'Using supplied value as an internal Octopus booking ID:',
                numericId
            );

            return numericId;
        }

        throw new Error(
            `${bokNumber} was not found in booking_tracking. Wait for the booking sync or verify the booking number.`
        );
    }

    function runOctopusCancellation({
        bookingId,
        cancellationReason
    }) {
        return new Promise((resolve, reject) => {
            const child = spawn(
                process.execPath,
                [
                    'playwright/octopus-booking-actions.js',
                    'cancel',
                    String(bookingId),
                    cancellationReason || 'Other'
                ],
                {
                    cwd: process.cwd(),
                    env: process.env,
                    stdio: ['ignore', 'pipe', 'pipe']
                }
            );

            let stdout = '';
            let stderr = '';
            let settled = false;

            const timeout = setTimeout(() => {
                if (settled) return;
                settled = true;
                child.kill('SIGTERM');
                reject(
                    new Error(
                        'Octopus cancellation timed out.'
                    )
                );
            }, 150000);

            child.stdout.on('data', chunk => {
                stdout += chunk.toString();
            });

            child.stderr.on('data', chunk => {
                stderr += chunk.toString();
            });

            child.on('error', error => {
                if (settled) return;
                settled = true;
                clearTimeout(timeout);
                reject(error);
            });

            child.on('close', code => {
                if (settled) return;
                settled = true;
                clearTimeout(timeout);

                const resultMatch = stdout.match(
                    /===== BOOKING ACTION RESULT =====\s*([\s\S]*?)\s*===== END BOOKING ACTION RESULT =====/
                );

                if (!resultMatch) {
                    reject(
                        new Error(
                            stderr.trim() ||
                            `Octopus cancellation exited with code ${code}.`
                        )
                    );
                    return;
                }

                try {
                    resolve(JSON.parse(resultMatch[1]));
                } catch (error) {
                    reject(
                        new Error(
                            `Could not parse Octopus cancellation result: ${error.message}`
                        )
                    );
                }
            });
        });
    }

    function runOctopusReschedule({
        bookingId,
        requestedDate,
        requestedStartTime
    }) {
        return new Promise((resolve, reject) => {
            const child = spawn(
                process.execPath,
                [
                    'playwright/octopus-booking-actions.js',
                    'reschedule',
                    String(bookingId),
                    requestedDate,
                    requestedStartTime
                ],
                {
                    cwd: process.cwd(),
                    env: process.env,
                    stdio: ['ignore', 'pipe', 'pipe']
                }
            );

            let stdout = '';
            let stderr = '';
            let settled = false;

            const timeout = setTimeout(() => {
                if (settled) return;
                settled = true;
                child.kill('SIGTERM');
                reject(
                    new Error(
                        'Octopus rescheduling timed out.'
                    )
                );
            }, 180000);

            child.stdout.on('data', chunk => {
                stdout += chunk.toString();
            });

            child.stderr.on('data', chunk => {
                stderr += chunk.toString();
            });

            child.on('error', error => {
                if (settled) return;
                settled = true;
                clearTimeout(timeout);
                reject(error);
            });

            child.on('close', code => {
                if (settled) return;
                settled = true;
                clearTimeout(timeout);

                const resultMatch = stdout.match(
                    /===== BOOKING ACTION RESULT =====\s*([\s\S]*?)\s*===== END BOOKING ACTION RESULT =====/
                );

                if (!resultMatch) {
                    reject(
                        new Error(
                            stderr.trim() ||
                            `Octopus rescheduling exited with code ${code}.`
                        )
                    );
                    return;
                }

                try {
                    resolve(JSON.parse(resultMatch[1]));
                } catch (error) {
                    reject(
                        new Error(
                            `Could not parse Octopus rescheduling result: ${error.message}`
                        )
                    );
                }
            });
        });
    }

    function runOctopusBillingLookup({ bookingId }) {
        return new Promise((resolve, reject) => {
            const child = spawn(
                process.execPath,
                [
                    'playwright/octopus-booking-actions.js',
                    'billing',
                    String(bookingId)
                ],
                {
                    cwd: process.cwd(),
                    env: process.env,
                    stdio: ['ignore', 'pipe', 'pipe']
                }
            );

            let stdout = '';
            let stderr = '';
            let settled = false;
            const timeout = setTimeout(() => {
                if (settled) return;
                settled = true;
                child.kill('SIGTERM');
                reject(new Error('Octopus billing lookup timed out.'));
            }, 120000);

            child.stdout.on('data', chunk => {
                stdout += chunk.toString();
            });
            child.stderr.on('data', chunk => {
                stderr += chunk.toString();
            });
            child.on('error', error => {
                if (settled) return;
                settled = true;
                clearTimeout(timeout);
                reject(error);
            });
            child.on('close', code => {
                if (settled) return;
                settled = true;
                clearTimeout(timeout);

                const resultMatch = stdout.match(
                    /===== BOOKING ACTION RESULT =====\s*([\s\S]*?)\s*===== END BOOKING ACTION RESULT =====/
                );
                if (!resultMatch) {
                    reject(new Error(
                        stderr.trim() ||
                        `Octopus billing lookup exited with code ${code}.`
                    ));
                    return;
                }

                try {
                    resolve(JSON.parse(resultMatch[1]));
                } catch (error) {
                    reject(new Error(
                        `Could not parse Octopus billing result: ${error.message}`
                    ));
                }
            });
        });
    }

    async function handleBillingLookupTool({
        response,
        openAiWs,
        WebSocket,
        callerPhone,
        customerBookings = []
    }) {
        if (
            response.type !== 'response.function_call_arguments.done' ||
            response.name !== 'lookup_octopus_billing'
        ) {
            return false;
        }

        let toolArguments = {};
        try {
            toolArguments = JSON.parse(response.arguments || '{}');
        } catch (error) {
            console.error('Could not parse billing lookup arguments:', error);
        }

        let toolResult;
        try {
            const internalBookingId = await resolveInternalBookingId(
                toolArguments.bookingId,
                customerBookings
            );
            const callerDigits = String(callerPhone || '')
                .replace(/\D/g, '')
                .slice(-10);
            const allowedIds = new Set(
                customerBookings
                    .map(booking => Number(String(
                        booking.octopus_booking_id || ''
                    ).replace(/\D/g, '')))
                    .filter(id => Number.isInteger(id) && id > 0)
            );

            const isSynchronizedBooking = allowedIds.has(internalBookingId);

            // customerBookings can be incomplete or stale. Never reject an
            // explicitly supplied internal ID before checking its verified
            // cached phone or performing the live read-only Octopus lookup.
            let cachedResult = { rows: [] };
            try {
                cachedResult = await db.query(
                `
                SELECT
                    booking_number,
                    octopus_booking_id,
                    customer_phone_normalized,
                    invoice_id,
                    invoice_status,
                    payment_status,
                    invoice_total,
                    amount_paid,
                    balance_due,
                    card_on_file,
                    card_status_verified,
                    billing_synced_at
                FROM public.booking_tracking
                WHERE octopus_booking_id::text = $1
                ORDER BY id DESC
                LIMIT 1
                `,
                [String(internalBookingId)]
                );
            } catch (cacheReadError) {
                console.error(
                    'Billing cache read failed; continuing with live Octopus lookup:',
                    cacheReadError
                );
            }
            const cached = cachedResult.rows[0] || null;
            const cachedPhone = String(
                cached?.customer_phone_normalized || ''
            ).replace(/\D/g, '').slice(-10);
            const cacheAge = cached?.billing_synced_at
                ? Date.now() - new Date(cached.billing_synced_at).getTime()
                : Infinity;
            const cacheIsFresh =
                Number.isFinite(cacheAge) &&
                cacheAge >= 0 &&
                cacheAge <= 15 * 60 * 1000;
            const cacheHasBilling =
                cached?.invoice_total !== null &&
                cached?.invoice_total !== undefined;
            const cacheBelongsToCaller =
                callerDigits.length === 10 &&
                cachedPhone === callerDigits;

            if (cacheIsFresh && cacheHasBilling && cacheBelongsToCaller) {
                console.log('Fast billing cache hit:', {
                    bookingId: internalBookingId,
                    bookingNumber: cached.booking_number,
                    cacheAgeMs: cacheAge
                });

                toolResult = {
                    success: true,
                    ok: true,
                    action: 'billing',
                    booking_id: internalBookingId,
                    booking_number: cached.booking_number,
                    read_only: true,
                    source: 'postgresql_cache',
                    card_on_file: cached.card_on_file,
                    card_status_verified:
                        cached.card_status_verified === true,
                    invoice_id: cached.invoice_id,
                    invoice_status: cached.invoice_status,
                    payment_status: cached.payment_status,
                    invoice_total: cached.invoice_total,
                    amount_paid: cached.amount_paid,
                    balance_due: cached.balance_due,
                    changed: false
                };
            } else {
                const result = await runOctopusBillingLookup({
                    bookingId: internalBookingId
                });

                const bookingPhones = Array.isArray(result.customer_phone_candidates)
                    ? result.customer_phone_candidates
                    : [];

                if (!callerDigits || !bookingPhones.includes(callerDigits)) {
                    throw new Error(
                        'That booking could not be verified as belonging to this caller.'
                    );
                }

                const moneyValue = value => {
                    if (value === null || value === undefined || value === '') {
                        return null;
                    }
                    const number = Number(String(value).replace(/[$,]/g, ''));
                    return Number.isFinite(number) ? number : null;
                };
                const bookingNumber = cached?.booking_number ||
                    (/^BOK/i.test(String(toolArguments.bookingId || ''))
                        ? `BOK-${String(toolArguments.bookingId).replace(/\D/g, '')}`
                        : null);

                // A successful live lookup must still be returned to Emma if
                // PostgreSQL is unavailable or the cache row cannot be saved.
                await db.query(
                    `
                    INSERT INTO public.booking_tracking (
                        booking_number,
                        tracking_token,
                        status,
                        octopus_booking_id,
                        octopus_booking_url,
                        customer_phone_normalized,
                        invoice_id,
                        invoice_status,
                        payment_status,
                        invoice_total,
                        amount_paid,
                        balance_due,
                        card_on_file,
                        card_status_verified,
                        billing_synced_at,
                        billing_sync_error,
                        updated_at
                    )
                    VALUES (
                        COALESCE($1, 'INTERNAL-' || $2),
                        'billing-' || $2,
                        'UNKNOWN',
                        $2,
                        'https://admin.octopuspro.com/booking/view/' || $2,
                        $3, $4, $5, $6, $7, $8, $9, $10, $11,
                        NOW(), NULL, NOW()
                    )
                    ON CONFLICT (booking_number)
                    DO UPDATE SET
                        octopus_booking_id = EXCLUDED.octopus_booking_id,
                        octopus_booking_url = EXCLUDED.octopus_booking_url,
                        customer_phone_normalized = EXCLUDED.customer_phone_normalized,
                        invoice_id = EXCLUDED.invoice_id,
                        invoice_status = EXCLUDED.invoice_status,
                        payment_status = EXCLUDED.payment_status,
                        invoice_total = EXCLUDED.invoice_total,
                        amount_paid = EXCLUDED.amount_paid,
                        balance_due = EXCLUDED.balance_due,
                        card_on_file = EXCLUDED.card_on_file,
                        card_status_verified = EXCLUDED.card_status_verified,
                        billing_synced_at = NOW(),
                        billing_sync_error = NULL,
                        updated_at = NOW()
                    `,
                    [
                        bookingNumber,
                        String(internalBookingId),
                        callerDigits,
                        result.invoice_id || null,
                        result.invoice_status || null,
                        result.payment_status || null,
                        moneyValue(result.invoice_total),
                        moneyValue(result.amount_paid),
                        moneyValue(result.balance_due),
                        result.card_on_file,
                        result.card_status_verified === true
                    ]
                ).catch(cacheWriteError => {
                    console.error(
                        'Billing cache write failed; returning verified live result:',
                        cacheWriteError
                    );
                });

                toolResult = {
                    success: result.ok === true,
                    source: 'octopus_live_refreshed_cache',
                    ...result
                };
            }
        } catch (error) {
            console.error('Octopus billing lookup failed:', error);
            toolResult = {
                success: false,
                read_only: true,
                error: error.message || 'Unable to verify billing information.',
                customer_message:
                    'I could not verify the billing information in OctopusPro right now. No payment or account changes were made.'
            };
        }

        if (openAiWs.readyState === WebSocket.OPEN) {
            openAiWs.send(JSON.stringify({
                type: 'conversation.item.create',
                item: {
                    type: 'function_call_output',
                    call_id: response.call_id,
                    output: JSON.stringify(toolResult)
                }
            }));
            openAiWs.send(JSON.stringify({ type: 'response.create' }));
        }

        return true;
    }

    async function handleCancelBookingTool({
        response,
        openAiWs,
        WebSocket,
        customerBookings = []
    }) {
        if (
            response.type !==
                'response.function_call_arguments.done' ||
            response.name !==
                'cancel_octopus_booking'
        ) {
            return false;
        }

        let toolArguments = {};

        try {
            toolArguments = JSON.parse(
                response.arguments || '{}'
            );
        } catch (error) {
            console.error(
                'Could not parse cancellation tool arguments:',
                error
            );
        }

        let toolResult;
        const suppliedBookingId =
            toolArguments.bookingId;

        if (!String(suppliedBookingId || '').match(/\d/)) {
            toolResult = {
                success: false,
                outcome: 'invalid_booking_id',
                error:
                    'A valid BOK number or Octopus booking ID is required.'
            };
        } else if (
            toolArguments.customerConfirmed !== true
        ) {
            toolResult = {
                success: false,
                outcome: 'confirmation_required',
                error:
                    'The customer must explicitly confirm cancellation first.'
            };
        } else if (
            toolArguments.cancellationScope !==
            'single_visit'
        ) {
            toolResult = {
                success: false,
                outcome: 'staff_review_required',
                error:
                    'Entire recurring series cancellation requires staff review.'
            };
        } else {
            try {
                const internalBookingId =
                    await resolveInternalBookingId(
                        suppliedBookingId,
                        customerBookings
                    );

                const result =
                    await runOctopusCancellation({
                        bookingId: internalBookingId,
                        cancellationReason:
                            toolArguments.cancellationReason ||
                            'Other'
                    });

                toolResult = {
                    success:
                        result.ok === true &&
                        result.verified_cancelled_in_octopus === true,
                    supplied_booking_id:
                        String(suppliedBookingId),
                    internal_booking_id:
                        internalBookingId,
                    ...result
                };
            } catch (error) {
                console.error(
                    'Octopus cancellation failed:',
                    error
                );

                toolResult = {
                    success: false,
                    outcome: 'automation_error',
                    error:
                        error.message ||
                        'Unable to cancel the booking.',
                    customer_message:
                        'I could not complete that cancellation in OctopusPro. I have not cancelled the appointment.'
                };
            }
        }

        if (openAiWs.readyState === WebSocket.OPEN) {
            openAiWs.send(
                JSON.stringify({
                    type: 'conversation.item.create',
                    item: {
                        type: 'function_call_output',
                        call_id: response.call_id,
                        output: JSON.stringify(toolResult)
                    }
                })
            );

            openAiWs.send(
                JSON.stringify({
                    type: 'response.create'
                })
            );
        }

        return true;
    }

    async function handleRescheduleBookingTool({
        response,
        openAiWs,
        WebSocket,
        customerBookings = []
    }) {
        if (
            response.type !==
                'response.function_call_arguments.done' ||
            response.name !==
                'reschedule_octopus_booking'
        ) {
            return false;
        }

        let toolArguments = {};

        try {
            toolArguments = JSON.parse(
                response.arguments || '{}'
            );
        } catch (error) {
            console.error(
                'Could not parse rescheduling tool arguments:',
                error
            );
        }

        const suppliedBookingId =
            toolArguments.bookingId;
        const requestedDate = String(
            toolArguments.requestedDate || ''
        ).trim();
        const requestedStartTime = String(
            toolArguments.requestedStartTime || ''
        ).trim();
        let toolResult;

        if (!String(suppliedBookingId || '').match(/\d/)) {
            toolResult = {
                success: false,
                outcome: 'invalid_booking_id',
                error:
                    'A valid BOK number or Octopus booking ID is required.'
            };
        } else if (!/^\d{4}-\d{2}-\d{2}$/.test(requestedDate)) {
            toolResult = {
                success: false,
                outcome: 'invalid_requested_date',
                error:
                    'The requested date must use YYYY-MM-DD format.'
            };
        } else if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(requestedStartTime)) {
            toolResult = {
                success: false,
                outcome: 'invalid_requested_time',
                error:
                    'The requested start time must use 24-hour HH:MM format.'
            };
        } else if (toolArguments.customerConfirmed !== true) {
            toolResult = {
                success: false,
                outcome: 'confirmation_required',
                error:
                    'The customer must explicitly confirm the new date and time first.'
            };
        } else if (
            toolArguments.rescheduleScope !==
            'single_visit'
        ) {
            toolResult = {
                success: false,
                outcome: 'staff_review_required',
                error:
                    'Entire recurring series rescheduling requires staff review.'
            };
        } else {
            try {
                const internalBookingId =
                    await resolveInternalBookingId(
                        suppliedBookingId,
                        customerBookings
                    );

                const result =
                    await runOctopusReschedule({
                        bookingId: internalBookingId,
                        requestedDate,
                        requestedStartTime
                    });

                toolResult = {
                    success:
                        result.ok === true &&
                        result.verified_rescheduled_in_octopus === true,
                    supplied_booking_id:
                        String(suppliedBookingId),
                    internal_booking_id:
                        internalBookingId,
                    ...result
                };
            } catch (error) {
                console.error(
                    'Octopus rescheduling failed:',
                    error
                );

                toolResult = {
                    success: false,
                    outcome: 'automation_error',
                    error:
                        error.message ||
                        'Unable to reschedule the booking.',
                    customer_message:
                        'I could not complete that reschedule in OctopusPro. The appointment has not been changed.'
                };
            }
        }

        if (openAiWs.readyState === WebSocket.OPEN) {
            openAiWs.send(
                JSON.stringify({
                    type: 'conversation.item.create',
                    item: {
                        type: 'function_call_output',
                        call_id: response.call_id,
                        output: JSON.stringify(toolResult)
                    }
                })
            );

            openAiWs.send(
                JSON.stringify({
                    type: 'response.create'
                })
            );
        }

        return true;
    }

    return {
        handleKnowledgeTool,
        handleTechnicianStatusTool,
        handleBillingLookupTool,
        handleCancelBookingTool,
        handleRescheduleBookingTool
    };
}
