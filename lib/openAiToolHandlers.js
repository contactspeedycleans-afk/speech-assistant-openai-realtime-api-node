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

    async function resolveInternalBookingId(rawBookingId) {
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

    async function handleCancelBookingTool({
        response,
        openAiWs,
        WebSocket
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
                        suppliedBookingId
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

    return {
        handleKnowledgeTool,
        handleTechnicianStatusTool,
        handleCancelBookingTool
    };
}
