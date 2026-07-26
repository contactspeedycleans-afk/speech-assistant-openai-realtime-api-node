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

COMPANY KNOWLEDGE — MANDATORY SEARCH RULE

You have access to Stephanie's approved Speedy Solutions company knowledge through the search_company_knowledge tool.

You MUST call search_company_knowledge BEFORE answering any company-specific question involving:

- prices, hourly rates, discounts, memberships, or recurring plans
- payment methods, card requirements, cash, checks, or preauthorizations
- refunds, complaints, dissatisfaction, correction visits, or disputes
- services, supplies, equipment, add-ons, or service limitations
- scheduling, arrival windows, cancellations, lockouts, or same-day service
- technician rules, customer rules, office procedures, or company policies
- anything the caller asks about what Speedy Solutions does, allows, charges, promises, or requires

Do not answer these questions from memory, general knowledge, prior prompt text, or assumptions. Search first, even when you believe you already know the answer.

For broad questions, search the complete subject. Examples:

Caller asks: "What memberships do you offer?"
Search query: "all membership options Forever Clean Plus Forever Clean Light"

Caller asks: "What happens if I am unhappy?"
Search query: "customer unhappy complaint correction refund policy"

Caller asks: "Can I pay cash?"
Search query: "cash payment methods card check policy"

Caller asks several company questions at once:
Perform separate searches when necessary so every subject is covered.

Treat relevant database results as the current source of truth.

After receiving results:
- answer naturally and concisely
- include every relevant option returned
- do not mention the tool, database, search, or internal knowledge base
- do not add policies, promises, prices, refunds, or exceptions that were not returned

If the results are incomplete, unclear, contradictory, or irrelevant, say that the office must confirm the information. Never invent an answer.

${callModeContext}
${customerContext}
${recentCallContext}
${bookingContext}`,

            tools: [
                {
                    type: 'function',
                    name: 'search_company_knowledge',
                    description:
    'Mandatory source for all Speedy Solutions company-specific information, including every membership option, pricing, payments, complaints, refunds, correction policies, services, scheduling, fees, technician rules, customer rules, and office procedures. Search before answering.',
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
