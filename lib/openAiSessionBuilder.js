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
    threshold: 0.68,
    prefix_padding_ms: 300,
    silence_duration_ms: 700,
    create_response: true,
    interrupt_response: true
},
noise_reduction: {
    type: 'near_field'
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

You have access to approved Speedy Solutions company information through the search_company_knowledge tool.

Use search_company_knowledge when the caller asks about:

- prices, rates, discounts, memberships, or recurring plans
- payment methods, cards, cash, checks, or preauthorizations
- complaints, dissatisfaction, refunds, corrections, or disputes
- services, supplies, equipment, add-ons, or service limitations
- scheduling, arrival windows, cancellations, or lockouts
- technician rules, customer rules, or office procedures
- any other Speedy Solutions policy or requirement

Company knowledge search results are the preferred source of truth.

When useful results are returned:

- answer the caller naturally and clearly
- do not mention the tool, search, database, or knowledge base
- do not read internal category names or database formatting aloud
- use only relevant information
- do not create additional prices, promises, refunds, or exceptions

If the search is not called or does not provide a complete answer, continue helping with approved information already contained in your instructions.

Do not immediately tell the caller that the office must call them back merely because a search was not performed.

Only escalate to the office when:

- the requested information is genuinely unavailable
- the situation requires management approval
- the caller requests an exception
- the available information is conflicting or unclear

Never invent a price, policy, refund, guarantee, or exception.

Examples of useful searches:

Membership question:
"Forever Clean Light Forever Clean Plus membership options pricing"

Payment question:
"accepted payment methods cash check card preauthorization"

Unhappy customer question:
"customer unhappy cleaning complaint correction resolution policy"

${callModeContext}
${customerContext}
${recentCallContext}
${bookingContext}`,

            tools: [
                {
                    type: 'function',
                    name: 'search_company_knowledge',
                    description:
                        'Search approved Speedy Solutions information about pricing, memberships, payments, complaints, services, scheduling, fees, supplies, technician rules, customer rules, and office procedures.',
                    parameters: {
                        type: 'object',
                        properties: {
                            query: {
                                type: 'string',
                                description:
                                    'A focused search phrase describing the Speedy Solutions information needed.'
                            }
                        },
                        required: ['query']
                    }
                },

                {
                    type: 'function',
                    name: 'record_technician_status_update',
                    description:
                        'Record a technician status update when a technician reports their job status.',
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

tool_choice: 'auto'        }
    };
}
