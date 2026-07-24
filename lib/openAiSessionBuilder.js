export function buildOpenAiSession({
    SYSTEM_MESSAGE,
    VOICE,
    callModeContext,
    customerContext,
    recentCallContext,
    bookingContext
}) {
    return {
        type: 'session.update',
        session: {
            type: 'realtime',
            model: 'gpt-realtime',
            output_modalities: ['audio'],
            audio: {
                input: {
                    format: {
                        type: 'audio/pcmu'
                    },
                    turn_detection: {
                        type: 'server_vad',
                        threshold: 0.7,
                        silence_duration_ms: 1200,
                        create_response: true
                    }
                },
                output: {
                    format: {
                        type: 'audio/pcmu'
                    },
                    voice: VOICE
                }
            },

            instructions: `${SYSTEM_MESSAGE}

COMPANY KNOWLEDGE TOOL

Use search_company_knowledge whenever the caller asks about company pricing, memberships, services, policies, scheduling rules, fees, supplies, or procedures and the answer may be stored in the company knowledge base.

Use the database result as the source of truth.

Explain the answer naturally. Do not mention the database or tool to the caller.

If the search returns no relevant information, do not invent a company policy or price. Explain that you need to confirm the information.

${callModeContext}
${customerContext}
${recentCallContext}
${bookingContext}`,

            tools: [
                {
                    type: 'function',
                    name: 'search_company_knowledge',
                    description:
                        'Search the Speedy Solutions company knowledge base for current pricing, memberships, services, policies, scheduling rules, fees, supplies, and procedures.',
                    parameters: {
                        type: 'object',
                        properties: {
                            query: {
                                type: 'string',
                                description:
                                    'A short search phrase describing the company information needed.'
                            }
                        },
                        required: ['query']
                    }
                },
                {
                    type: 'function',
                    name: 'record_technician_status_update',
                    description:
                        'Record a technician update.',
                    parameters: {
                        type: 'object',
                        properties: {
                            bookingNumber: {
                                type: 'string'
                            },
                            technicianName: {
                                type: 'string'
                            },
                            status: {
                                type: 'string'
                            },
                            reportedTime: {
                                type: 'string'
                            },
                            notes: {
                                type: 'string'
                            }
                        },
                        required: ['status']
                    }
                }
            ],

            tool_choice: 'auto'
        }
    };
}
