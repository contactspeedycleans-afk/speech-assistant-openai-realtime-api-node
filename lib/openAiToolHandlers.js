import { spawn } from 'node:child_process';

export function createOpenAiToolHandlers({
    searchCompanyKnowledge,
    recordTechnicianStatusUpdate
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
                query:
                    toolArguments.query || '',
                results: knowledgeResults
            });
        } catch (error) {
            console.error(
                'Company knowledge search failed:',
                error
            );

            toolOutput = JSON.stringify({
                query:
                    toolArguments.query || '',
                results: [],
                error:
                    'The company knowledge search was temporarily unavailable.'
            });
        }

        if (
            openAiWs.readyState ===
            WebSocket.OPEN
        ) {
            openAiWs.send(
                JSON.stringify({
                    type:
                        'conversation.item.create',
                    item: {
                        type:
                            'function_call_output',
                        call_id:
                            response.call_id,
                        output:
                            toolOutput
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
                createdAt:
                    savedUpdate.created_at
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

        if (
            openAiWs.readyState ===
            WebSocket.OPEN
        ) {
            openAiWs.send(
                JSON.stringify({
                    type:
                        'conversation.item.create',
                    item: {
                        type:
                            'function_call_output',
                        call_id:
                            response.call_id,
                        output:
                            toolOutput
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
        const bookingId = Number(
            toolArguments.bookingId
        );

        if (
            !Number.isInteger(bookingId) ||
            bookingId <= 0
        ) {
            toolResult = {
                success: false,
                outcome: 'invalid_booking_id',
                error:
                    'A valid numeric Octopus booking ID is required.'
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
                const result =
                    await runOctopusCancellation({
                        bookingId,
                        cancellationReason:
                            toolArguments.cancellationReason ||
                            'Other'
                    });

                toolResult = {
                    success:
                        result.ok === true &&
                        result.verified_cancelled_in_octopus === true,
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
                        'Unable to cancel the booking.'
                };
            }
        }

        if (
            openAiWs.readyState ===
            WebSocket.OPEN
        ) {
            openAiWs.send(
                JSON.stringify({
                    type:
                        'conversation.item.create',
                    item: {
                        type:
                            'function_call_output',
                        call_id:
                            response.call_id,
                        output:
                            JSON.stringify(toolResult)
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
