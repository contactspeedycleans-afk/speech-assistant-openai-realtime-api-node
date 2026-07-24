import Fastify from 'fastify';
import WebSocket from 'ws';
import dotenv from 'dotenv';
import pg from 'pg';
import fastifyFormBody from '@fastify/formbody';
import fastifyWs from '@fastify/websocket';
import twilio from 'twilio';
import SYSTEM_MESSAGE from './prompts/systemMessage.js';
import { createCustomerLookup } from './lib/customerLookup.js';

dotenv.config();

const { OPENAI_API_KEY } = process.env;
const { Pool } = pg;

const twilioClient = twilio(
    process.env.TWILIO_ACCT_SID,
    process.env.TWILIO_AUTH_TOKEN
);

if (!OPENAI_API_KEY) {
    console.error('Missing OPENAI_API_KEY.');
    process.exit(1);
}

const db = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: {
        rejectUnauthorized: false
    }
});
const {
    findCustomerByPhone,
    findRecentCalls
} = createCustomerLookup(db);

console.log('DATABASE_URL exists:', !!process.env.DATABASE_URL);

db.query('SELECT NOW()')
    .then(() => {
        console.log('PostgreSQL connected successfully');
    })
    .catch((error) => {
        console.error('PostgreSQL connection error:', error);
    });

const fastify = Fastify();

fastify.register(fastifyFormBody);
fastify.register(fastifyWs);

const VOICE = 'marin';
const TEMPERATURE = 0.55;
const PORT = process.env.PORT || 8080;



const LOG_EVENT_TYPES = [
    'error',
    'response.done',
    'session.created',
    'session.updated'
];


async function findCustomerBookingCount(customerId) {
    if (!customerId) {
        return 0;
    }

    const result = await db.query(
        `
        SELECT COUNT(*)::int AS booking_count
        FROM public.bookings
        WHERE customer_id = $1
        `,
        [customerId]
    );

    return result.rows[0]?.booking_count || 0;
}
       async function findCustomerBookings(customerId) {
    if (!customerId) {
        return [];
    }

    const result = await db.query(
`
        SELECT
            octopus_booking_id,
            service_type,
            booking_date,
            arrival_window,
            status,
            labor_hours,
            technician_count,
            estimated_total,
            final_total,
            special_requests
        FROM public.bookings
        WHERE customer_id = $1
        ORDER BY booking_date DESC
        LIMIT 5
        `,
        [customerId]
    );

return result.rows;
}

async function recordTechnicianStatusUpdate({
    bookingNumber = '',
    technicianName = '',
    status = '',
    reportedTime = '',
    notes = '',
    callerPhone = ''
}) {
if (!status) {
    throw new Error(
        'Technician status is required.'
    );
}

const result = await db.query(
        `
        INSERT INTO public.technician_status_updates (
            booking_number,
            technician_name,
            status,
            reported_time,
            notes,
            caller_phone
        )
        VALUES ($1, $2, $3, $4, $5, $6)
        RETURNING
            id,
            created_at
        `,
        [
            bookingNumber || null,
            technicianName || null,
            status,
            reportedTime || null,
            notes || null,
            callerPhone || null
        ]
    );

    return result.rows[0];
}
           

async function searchCompanyKnowledge(query) {
    if (!query || !String(query).trim()) {
        return [];
    }

    console.log(
        'Searching company knowledge for:',
        query
    );

    const result = await db.query(
        `
        SELECT *
        FROM public.search_knowledge_base($1, 5)
        `,
        [String(query).trim()]
    );

    console.log(
        'Knowledge results found:',
        result.rows.length
    );

    return result.rows;
}

async function startCallRecording(callSid) {
    if (!callSid) {
        console.error(
            'Recording not started: CallSid is missing.'
        );
        return;
    }

    if (!process.env.TWILIO_RECORDING_CALLBACK_URL) {
        console.error(
            'Recording not started: callback URL is missing.'
        );
        return;
    }

    try {
        await twilioClient
            .calls(callSid)
            .recordings.create({
                recordingChannels: 'dual',
                recordingStatusCallback:
                    process.env.TWILIO_RECORDING_CALLBACK_URL,
                recordingStatusCallbackMethod: 'POST'
            });

        console.log(
            'Twilio recording started:',
            callSid
        );
    } catch (error) {
        console.error(
            'Unable to start Twilio recording:',
            error
        );
    }
}

fastify.all('/incoming-call', async (request, reply) => {
    const callerPhone =
        request.body?.From ||
        request.query?.From ||
        '';
    const twilioNumber =
    request.body?.To ||
    request.query?.To ||
    '';
    const callSid =
        request.body?.CallSid ||
        request.query?.CallSid ||
        '';

    console.log('Incoming caller phone:', callerPhone || 'unknown');

    const twimlResponse = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Connect>
      <Stream url="wss://daring-cat-production-9995.up.railway.app/media-stream">
   <Parameter
    name="callerPhone"
    value="${callerPhone}"
/>
<Parameter
    name="twilioNumber"
    value="${twilioNumber}"
/>
<Parameter
    name="callMode"
    value="INBOUND_LEAD"
/>
</Stream>
    </Connect>
</Response>`;

    reply
        .type('text/xml')
        .send(twimlResponse);
});
function escapeXml(value = '') {
    return String(value)
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&apos;');
}

fastify.post('/outbound-call', async (request, reply) => {
    const {
        phone,
        customer_name = '',
        instructions = '',
        sheet_row_number = ''
    } = request.body || {};

    if (!phone) {
        return reply.code(400).send({
            success: false,
            error: 'Phone number is required.'
        });
    }

    if (!instructions) {
        return reply.code(400).send({
            success: false,
            error: 'Instructions are required.'
        });
    }

    if (!process.env.TWILIO_PHONE_NUMBER) {
        return reply.code(500).send({
            success: false,
            error: 'TWILIO_PHONE_NUMBER is missing.'
        });
    }

    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Connect>
        <Stream url="wss://daring-cat-production-9995.up.railway.app/media-stream">
            <Parameter
                name="callerPhone"
                value="${escapeXml(phone)}"
            />
            <Parameter
                name="callMode"
                value="OUTBOUND_CUSTOM"
            />
            <Parameter
                name="customerName"
                value="${escapeXml(customer_name)}"
            />
            <Parameter
                name="customInstructions"
                value="${escapeXml(instructions)}"
            />
            <Parameter
                name="sheetRowNumber"
                value="${escapeXml(sheet_row_number)}"
            />
        </Stream>
    </Connect>
</Response>`;

    try {
        const call = await twilioClient.calls.create({
            to: phone,
            from: process.env.TWILIO_PHONE_NUMBER,
            twiml
        });

        console.log('Custom outbound call started:', {
            callSid: call.sid,
            phone,
            customerName: customer_name,
            sheetRowNumber: sheet_row_number
        });

        return reply.send({
            success: true,
            call_sid: call.sid,
            status: call.status,
            phone,
            sheet_row_number
        });
    } catch (error) {
        console.error(
            'Custom outbound call failed:',
            error
        );

        return reply.code(500).send({
            success: false,
            error:
                error?.message ||
                'Unable to start outbound call.'
        });
    }
});
fastify.all('/outbound-press1', async (request, reply) => {
    const customerPhone =
        request.body?.To ||
        request.query?.To ||
        request.body?.From ||
        request.query?.From ||
        '';

    const answeredBy =
        request.body?.AnsweredBy ||
        request.query?.AnsweredBy ||
        'unknown';

    console.log(
        'Outbound Press 1 customer phone:',
        customerPhone || 'unknown'
    );

    console.log(
        'Twilio answered by:',
        answeredBy
    );

    const isVoicemail =
        answeredBy === 'machine_start' ||
        answeredBy === 'machine_end_beep' ||
        answeredBy === 'machine_end_silence' ||
        answeredBy === 'machine_end_other' ||
        answeredBy === 'fax';

    if (isVoicemail) {
        const voicemailResponse = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Say>
        Hi, this is Emma calling from Speedy Solutions about the house cleaning quote you requested.
        We would love to help you get your cleaning scheduled.
        Please call us back at 517-777-8712, or simply reply to the text message we send you.
        We look forward to speaking with you. Have a wonderful day.
    </Say>
    <Hangup/>
</Response>`;

        return reply
            .type('text/xml')
            .send(voicemailResponse);
    }

    const twimlResponse = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Connect>
        <Stream url="wss://daring-cat-production-9995.up.railway.app/media-stream">
            <Parameter
                name="callerPhone"
                value="${customerPhone}"
            />
            <Parameter
                name="callMode"
                value="OUTBOUND_PRESS_1"
            />
        </Stream>
    </Connect>
</Response>`;

    return reply
        .type('text/xml')
        .send(twimlResponse);
});

fastify.register(async (websocketServer) => {
    websocketServer.get(
        '/media-stream',
        { websocket: true },
        (connection, request) => {
            console.log('Twilio client connected');

let streamSid = null;
let latestMediaTimestamp = 0;
let callerPhone = '';
let twilioNumber = '';
let callMode = 'INBOUND_LEAD';

let outboundCustomerName = '';
let customInstructions = '';
let sheetRowNumber = '';

let customer = null;
let recentCalls = [];
let customerBookings = [];
let customerBookingCount = 0;
let openAiConnected = false;
let sessionStarted = false;

            const openAiWs = new WebSocket(
                `wss://api.openai.com/v1/realtime?model=gpt-realtime&temperature=${TEMPERATURE}`,
                {
                    headers: {
                        Authorization: `Bearer ${OPENAI_API_KEY}`
                    }
                }
            );

            const initializeSession = () => {
                if (
                    !openAiConnected ||
                    !streamSid ||
                    sessionStarted
                ) {
                    return;
                }

                sessionStarted = true;

                const customerName = [
                    customer?.first_name,
                    customer?.last_name
                ]
                    .filter(Boolean)
                    .join(' ')
                    .trim();

                const customerAddress = [
                    customer?.address,
                    customer?.city,
                    customer?.state,
                    customer?.zip
                ]
                    .filter(Boolean)
                    .join(', ')
                    .trim();
const isAngiLead =
    customer?.ai_summary
        ?.toLowerCase()
        .includes('lead source: angi') || false;

const customerContext = customer
    ? isAngiLead
        ? `
NEW ANGI LEAD FOUND

Customer Name: ${customerName || 'New lead'}
First Name: ${customer?.first_name || ''}
Phone: ${customer?.phone || callerPhone}
Email: ${customer?.email || 'Not available'}
Service Address: ${customerAddress || 'Not available'}

Lead Information:
${customer?.ai_summary || 'Not available'}

This person is a new sales lead, not a returning customer.

Do not say "welcome back."

Use the lead information naturally as private background context.

Do not read the full customer notes aloud.

Do not mention:
- Lead ID
- Match type
- Lead source
- Internal notes
- Full email address
- Full street address

If the requested service or frequency is already known, do not ask for it again.

Only ask for information that is missing or needs to be changed.
`
        : `
RETURNING CUSTOMER FOUND

Customer Name: ${customerName || 'Returning customer'}
First Name: ${customer?.first_name || ''}
Phone: ${customer?.phone || callerPhone}
Email: ${customer?.email || 'Not available'}
Service Address: ${customerAddress || 'Not available'}
Membership Status: ${customer?.membership_status || 'Not available'}
Customer Notes: ${customer?.ai_summary || 'Not available'}

This caller is an existing customer.

Welcome the caller back naturally using their first name.

Do not ask for their name or phone number again unless the information has changed.

Do not announce or read the full saved address at the beginning of the call.

Only ask for information that is missing or needs to be updated.
`
    : `
NEW CALLER

No matching customer was found for this phone number.

Use the normal Speedy Solutions greeting.

Collect the caller's full name, phone number, email address, service address,
and other required booking information.
`;
const recentCallContext =
    recentCalls.length > 0
        ? `
RECENT CUSTOMER CALL HISTORY

${recentCalls
    .map((call, index) => {
        return `
Call ${index + 1}
Date: ${call.started_at || 'Unknown'}
Sentiment: ${call.sentiment || 'Unknown'}
Summary: ${call.summary || 'No summary available'}
`;
    })
    .join('\n')}

Use this history only as private background context.

Do not read the call history aloud.

Do not mention that calls were recorded or stored.

Only reference a previous conversation when it naturally helps the customer.
`
        : `
NO RECENT CALL HISTORY FOUND
`;
const bookingContext =
    customerBookings.length > 0
        ? `
CUSTOMER BOOKING HISTORY

${customerBookings
    .map((booking, index) => {
        return `
Booking ${index + 1}
Date: ${booking.booking_date || 'Unknown'}
Service: ${booking.service_type || 'Unknown'}
Status: ${booking.status || 'Unknown'}
Arrival Window: ${booking.arrival_window || 'Unknown'}
Labor Hours: ${booking.labor_hours || 'Unknown'}
Technician Count: ${booking.technician_count || 'Unknown'}
Final Total: ${booking.final_total || 'Unknown'}
Special Requests: ${booking.special_requests || 'None'}
`;
    })
    .join('\n')}

This customer has previous booking history.

Use the booking history only as private background context.

Do not read all booking details aloud.

Do not mention totals, internal booking IDs, or private notes unless the customer asks and it is appropriate.

Use the most recent booking to understand whether the customer previously completed, cancelled, or scheduled a service.
`
        : `
NO PREVIOUS BOOKING HISTORY

This customer has no bookings stored in the booking database.

Treat them as a first-time cleaning customer unless other customer information clearly says otherwise.
`;
const callModeContext =
    callMode === 'OUTBOUND_CUSTOM'
        ? `
CALL MODE: CUSTOM OUTBOUND OFFICE CALL

Customer Name:
${outboundCustomerName}

Instructions:
${customInstructions}

You are making an outbound office call.

Follow the instructions exactly.

Do NOT use the normal inbound greeting.

Do NOT make up information.

Be friendly, conversational and professional.

If the customer asks unrelated questions, answer naturally and then return to the purpose of the call.
`
    : callMode === 'OUTBOUND_PRESS_1'
        ? `
CALL MODE: OUTBOUND NEW LEAD QUOTE

This is an outbound call to a new lead who requested a house cleaning quote.

Do not use the standard inbound receptionist greeting.

If customer information or lead notes are available, use them naturally.

If the requested service is already known, do not ask again.

Instead, greet the customer by first name, briefly acknowledge the service they requested, and ask the next logical question.

If the requested service is NOT known, begin by asking whether they are looking for one-time or recurring cleaning.

Ask only this question first and then wait for the customer to answer.
`
        : `
CALL MODE: INBOUND LEAD

This is a normal inbound call.

Use the standard greeting:

"Thank you for calling Speedy Solutions. This is Emma. How can we help you today?"
`;
                const sessionUpdate = {
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
                        'A short search phrase describing the company information needed, such as membership, carpet cleaning, arrival windows, or supplies.'
                }
            },
            required: ['query']
        }
    },
    {
        type: 'function',
        name: 'record_technician_status_update',
        description:
            'Record a technician update such as starting a job, finishing a job, lockout, customer unavailable, break, delay, or other field status.',
        parameters: {
            type: 'object',
            properties: {
                bookingNumber: {
                    type: 'string',
                    description:
                        'Booking number such as BOK-25983.'
                },
                technicianName: {
                    type: 'string',
                    description:
                        'Name of the cleaner or technician.'
                },
                status: {
                    type: 'string',
                    description:
                        'The reported status, such as started, finished, lockout, customer_unavailable, break, delayed, or note.'
                },
                reportedTime: {
                    type: 'string',
                    description:
                        'The local time reported by the technician, such as 10:17 AM.'
                },
                notes: {
                    type: 'string',
                    description:
                        'Any additional details about the technician update.'
                }
            },
            required: ['status']
        }
    }
],

tool_choice: 'auto'                 }
                };

                console.log(
                    'Starting OpenAI session for:',
                    customerName || 'new caller'
                );

                console.log(
                    'Customer address provided to Emma:',
                    customerAddress || 'not available'
                );

                openAiWs.send(
                    JSON.stringify(sessionUpdate)
                );

                openAiWs.send(
                    JSON.stringify({
                        type: 'conversation.item.create',
                        item: {
                            type: 'message',
                            role: 'user',
                            content: [
                                {type: 'input_text',
                                   text:
   callMode === 'OUTBOUND_CUSTOM'
    ? `Begin the outbound office call now.

Customer name:
${outboundCustomerName}

Instructions:
${customInstructions}

Follow these instructions exactly.

Begin speaking naturally.`
    : callMode === 'OUTBOUND_PRESS_1'
    ? customer
     ? `Begin the outbound quote call now.

The customer has already requested a cleaning quote.

Use all available customer information and notes as background context.

If you already know the requested cleaning service, acknowledge it naturally without reading the notes aloud.

Do not mention internal information such as Lead ID, Match Type, Lead Source, customer notes, or the full address.

Greet ${customer?.first_name || 'the customer'} warmly by first name, ask the single most appropriate next question, and then wait for the customer's response.`
        : `Begin the outbound new-lead quote call now. Say: "Hi! Thank you for looking for a house cleaning quote with Speedy Solutions. Is this more of a one-time cleaning, or are you interested in recurring cleaning?" After asking, stop and wait for the customer's answer.`
    : customer
        ? `Begin the inbound call now. Welcome ${customer?.first_name || 'the customer'} back warmly by first name. Do not mention or confirm any saved address unless the customer brings it up or it becomes necessary to complete the booking.`
        : `Begin the inbound call now using the standard Speedy Solutions greeting.`
                                }
                            ]
                        }
                    })
                );

                openAiWs.send(
                    JSON.stringify({
                        type: 'response.create'
                    })
                );
            };

            openAiWs.on('open', () => {
                console.log(
                    'Connected to OpenAI Realtime API'
                );

                openAiConnected = true;
                initializeSession();
            });

openAiWs.on('message', async (data) => {
try {
const response = JSON.parse(
    data.toString()
);

                    if (
                        LOG_EVENT_TYPES.includes(
                            response.type
                        )
                    ) {
                        console.log(
                            `Received event: ${response.type}`,
                            response
                        );
                    }
console.log(
    'OpenAI Event:',
    response.type
);

if (
    typeof response.type === 'string' &&
    response.type.includes('function')
) {
    console.log(
        'Function Event:',
        JSON.stringify(response, null, 2)
    );
}
    // Instantly stop Twilio audio when the customer interrupts
                    if (
                        response.type === 'input_audio_buffer.speech_started' &&
                        connection.readyState === WebSocket.OPEN
                    ) {
                        connection.send(
                            JSON.stringify({
                                event: 'clear',
                                streamSid: streamSid
                            })
                        );
                        console.log('Customer interrupted - clearing Twilio audio buffer.');
                    }

                    // Send normal audio back to Twilio
                    if (
                        response.type === 'response.output_audio.delta' &&
                        response.delta &&
                        connection.readyState === WebSocket.OPEN
                    ) {
                        connection.send(
                            JSON.stringify({
                                event: 'media',
                                streamSid,
                                media: {
                                    payload: response.delta
                                }
                            })
                        );
                    }
                        
    
if (
    response.type ===
        'response.function_call_arguments.done' &&
    response.name ===
        'search_company_knowledge'
) {
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
}
    if (
    response.type === 'response.function_call_arguments.done' &&
    response.name === 'record_technician_status_update'
) {
    let toolArguments = {};

    try {
        toolArguments = JSON.parse(response.arguments || '{}');
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
}
                } catch (error) {
                    console.error(
                        'Error processing OpenAI message:',
                        error
                    );
                }
            });

            openAiWs.on('error', (error) => {
                console.error(
                    'OpenAI WebSocket error:',
                    error
                );
            });

            openAiWs.on('close', (code, reason) => {
                console.log(
                    'OpenAI WebSocket closed.',
                    'Code:',
                    code,
                    'Reason:',
                    reason?.toString() || 'none'
                );
            });

            connection.on('message', async (message) => {
                try {
                    const data = JSON.parse(
                        message.toString()
                    );

                    switch (data.event) {
                        case 'start': {
                            streamSid =
                                data.start?.streamSid ||
                                data.streamSid ||
                                null;
const callSid = data.start?.callSid || null;

    if (callSid) {
        startCallRecording(callSid);
    }
                            
const customParameters =
    data.start?.customParameters || {};

callerPhone =
    customParameters.callerPhone || '';

twilioNumber =
    customParameters.twilioNumber || '';

callMode =
    customParameters.callMode ||
    'INBOUND_LEAD';

console.log(
    'Twilio number called:',
    twilioNumber
);

outboundCustomerName =
    customParameters.customerName || '';

customInstructions =
    customParameters.customInstructions || '';

sheetRowNumber =
    customParameters.sheetRowNumber || '';
console.log(
    'Outbound customer name:',
    outboundCustomerName || 'not provided'
);

console.log(
    'Custom outbound instructions:',
    customInstructions || 'not provided'
);

console.log(
    'Outbound sheet row:',
    sheetRowNumber || 'not provided'
);
console.log(
    'Emma call mode:',
    callMode
);

console.log(
    'Incoming stream started:',
    streamSid
);

console.log(
    'Caller phone from stream:',
    callerPhone || 'unknown'
);

latestMediaTimestamp = 0;


                            try {
customer =
    await findCustomerByPhone(
        callerPhone
    );

recentCalls =
    await findRecentCalls(
        callerPhone
    );

if (customer) {
    customerBookings =
        await findCustomerBookings(
            customer.id
        );
    customerBookingCount =
        await findCustomerBookingCount(
            customer.id
        );
    console.log(
        'Bookings found:',
        customerBookings.length
    );


                                    console.log(
                                        'Returning customer found:',
                                        {
                                            id: customer.id,
                                            first_name:
                                                customer.first_name,
                                            last_name:
                                                customer.last_name,
                                            phone:
                                                customer.phone,
                                            email:
                                                customer.email,
                                            address:
                                                customer.address,
                                            city:
                                                customer.city,
                                            state:
                                                customer.state,
                                            zip:
                                                customer.zip
                                        }
                                    );
                                } else {
                                    console.log(
                                        'No customer found for:',
                                        callerPhone
                                    );
                                }
                            } catch (error) {
                                console.error(
                                    'Customer lookup failed:',
                                    error
                                );

                                customer = null;
                            }

                            initializeSession();
                            break;
                        }

                        case 'media': {
                            latestMediaTimestamp =
                                Number(
                                    data.media?.timestamp || 0
                                );

                            if (
                                openAiWs.readyState ===
                                WebSocket.OPEN
                            ) {
                                openAiWs.send(
                                    JSON.stringify({
                                        type: 'input_audio_buffer.append',
                                        audio:
                                            data.media.payload
                                    })
                                );
                            }

                            break;
                        }

                        case 'stop': {
                            console.log(
                                'Twilio stream stopped.',
                                'Stream SID:',
                                data.streamSid ||
                                    streamSid ||
                                    'unknown'
                            );

                            break;
                        }

                        default:
                            break;
                    }
                } catch (error) {
                    console.error(
                        'Error parsing Twilio message:',
                        error
                    );
                }
            });

            connection.on('error', (error) => {
                console.error(
                    'Twilio WebSocket error:',
                    error
                );
            });

            connection.on('close', (code, reason) => {
                console.log(
                    'Twilio WebSocket closed.',
                    'Code:',
                    code,
                    'Reason:',
                    reason?.toString() || 'none'
                );

                if (
                    openAiWs.readyState ===
                        WebSocket.OPEN ||
                    openAiWs.readyState ===
                        WebSocket.CONNECTING
                ) {
                    openAiWs.close();
                }
            });
        }
    );
});

fastify.listen(
    {
        port: PORT,
        host: '0.0.0.0'
    },
    (error) => {
        if (error) {
            console.error(error);
            process.exit(1);
        }

        console.log(
            `Server is listening on port ${PORT}`
        );
    }
);
