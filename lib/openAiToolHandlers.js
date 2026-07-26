export function createOpenAiToolHandlers({
    searchCompanyKnowledge,
    recordTechnicianStatusUpdate
}) {
   async function handleKnowledgeTool({
    response,
    openAiWs,
    WebSocket
}) {
    console.log(
        'Knowledge handler received:',
        response.type,
        response.name
    );

    if (
        response.type !==
            'response.function_call_arguments.done' ||
        response.name !==
            'search_company_knowledge'
    ) {
        return false;
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

    return {
        handleKnowledgeTool,
        handleTechnicianStatusTool
    };
}
