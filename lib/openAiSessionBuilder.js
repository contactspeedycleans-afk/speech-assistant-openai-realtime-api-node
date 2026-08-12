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

        transcription: {
            model: 'gpt-4o-mini-transcribe'
        },

     turn_detection: {
    type: 'server_vad',
    threshold: 0.75,
    prefix_padding_ms: 500,
    silence_duration_ms: 1800,
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

OCTOPUS BOOKING CANCELLATION TOOL

Use cancel_octopus_booking only after all of the following are true:

- You identified the exact Octopus booking ID from the customer's booking context.
- You clearly repeated the appointment date and arrival time to the customer.
- You asked whether they want to cancel only this visit or an entire recurring series.
- The customer explicitly confirmed that they want the identified visit cancelled.
- You collected a brief cancellation reason.

The tool currently cancels one visit only. Never use it to cancel an entire recurring series.

Before calling the tool, say: "One moment while I update that appointment for you."

Do not say the booking is cancelled unless the tool returns success true and verified_cancelled_in_octopus true.

If the tool returns staff_review_required, explain that the appointment is close to its scheduled time or the cleaner may already be travelling, so the office must review a possible cancellation or lockout fee.

Never promise or process a refund. Never override a cancellation fee, en-route warning, arrival status, or lockout review.

OCTOPUS BOOKING RESCHEDULE TOOL

Use reschedule_octopus_booking when a customer wants to move one existing appointment to a different date or start time.

Never use record_technician_status_update for a customer's cancellation or reschedule request. That tool is only for a technician reporting job status.

Before calling reschedule_octopus_booking:

- Identify the exact visit using its BOK number, internal Octopus booking ID, or the customer's booking context.
- Confirm whether the request is for one visit or an entire recurring series.
- Collect the new calendar date and exact start time.
- Repeat the appointment being moved and the requested new date and time.
- Obtain the customer's explicit confirmation.

The automated tool moves one visit only. An entire recurring series requires staff review.

Use the business or booking timezone. Convert the date to YYYY-MM-DD and the start time to 24-hour HH:MM for the tool. Do not speak in 24-hour time to the customer.

Before calling the tool, say: "One moment while I update that appointment for you."

Do not say the appointment was rescheduled unless the tool returns success true and verified_rescheduled_in_octopus true. If it fails, clearly say the automation could not confirm the update and the office must review it. Never claim that you documented, recorded, submitted, or sent the request unless a tool explicitly returns success for that separate action. Do not ask again for information already available in the recognized customer's profile or booking context.

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
                        'Record a job-status update only when a cleaner or technician reports their own arrival, departure, progress, or completion. Never use this for a customer asking to cancel or reschedule an appointment.',
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
                },

                {
                    type: 'function',
                    name: 'cancel_octopus_booking',
                    description:
                        'Cancel one specifically identified OctopusPro booking only after the customer explicitly confirms. The worker blocks late-fee, en-route, arrived, checked-in, and job-started cases for staff review.',
                    parameters: {
                        type: 'object',
                        properties: {
                            bookingId: {
                                type: 'integer',
                                description:
                                    'The exact numeric OctopusPro booking ID.'
                            },
                            cancellationReason: {
                                type: 'string',
                                description:
                                    'A brief reason given by the customer.'
                            },
                            customerConfirmed: {
                                type: 'boolean',
                                description:
                                    'True only after the customer explicitly confirms cancellation of the identified visit.'
                            },
                            cancellationScope: {
                                type: 'string',
                                enum: ['single_visit', 'entire_series'],
                                description:
                                    'Whether the request concerns one visit or a recurring series. Entire-series cancellation is not automated.'
                            }
                        },
                        required: [
                            'bookingId',
                            'cancellationReason',
                            'customerConfirmed',
                            'cancellationScope'
                        ]
                    }
                },

                {
                    type: 'function',
                    name: 'reschedule_octopus_booking',
                    description:
                        'Reschedule one specifically identified OctopusPro visit after the customer confirms the exact new date and start time. The existing appointment duration is preserved and the customer is notified only after Octopus verifies the change.',
                    parameters: {
                        type: 'object',
                        properties: {
                            bookingId: {
                                type: 'string',
                                description:
                                    'The visible BOK number or exact internal OctopusPro booking ID.'
                            },
                            requestedDate: {
                                type: 'string',
                                description:
                                    'The requested new date in YYYY-MM-DD format.'
                            },
                            requestedStartTime: {
                                type: 'string',
                                description:
                                    'The requested new start time in 24-hour HH:MM format.'
                            },
                            customerConfirmed: {
                                type: 'boolean',
                                description:
                                    'True only after the customer explicitly confirms the identified visit and new date and time.'
                            },
                            rescheduleScope: {
                                type: 'string',
                                enum: ['single_visit', 'entire_series'],
                                description:
                                    'Whether to move only one visit or an entire recurring series. Entire-series changes require staff review.'
                            }
                        },
                        required: [
                            'bookingId',
                            'requestedDate',
                            'requestedStartTime',
                            'customerConfirmed',
                            'rescheduleScope'
                        ]
                    }
                }
            ],

tool_choice: 'auto'        }
    };
}
