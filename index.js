import Fastify from 'fastify';
import WebSocket from 'ws';
import dotenv from 'dotenv';
import pg from 'pg';
import fastifyFormBody from '@fastify/formbody';
import fastifyWs from '@fastify/websocket';
import twilio from 'twilio';
import SYSTEM_MESSAGE from './prompts/systemMessage.js';
import { createCustomerLookup } from './lib/customerLookup.js';
import { createBookingLookup } from './lib/bookingLookup.js';
import { createTechnicianStatus } from './lib/technicianStatus.js';
import { createKnowledgeSearch } from './lib/knowledgeSearch.js';
import { createKnowledgeTest } from './lib/knowledgeTest.js';
import { createTwilioRecording } from './lib/twilioRecording.js';
import { createOpenAiToolHandlers } from './lib/openAiToolHandlers.js';
import { buildSessionContext } from './lib/sessionContextBuilder.js';
import { buildOpenAiSession } from './lib/openAiSessionBuilder.js';
import { createTechnicianSearch } from './lib/technicianSearch.js';


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
    searchTechnicians
} = createTechnicianSearch(db);
const {
    findCustomerByPhone,
    findRecentCalls
} = createCustomerLookup(db);

const {
    findCustomerBookingCount,
    findCustomerBookings
} = createBookingLookup(db);

const {
    recordTechnicianStatusUpdate
} = createTechnicianStatus(db);
const {
    searchCompanyKnowledge
} = createKnowledgeSearch(db);
const {
    testKnowledge
} = createKnowledgeTest({
    searchCompanyKnowledge
});
const {
    startCallRecording
} = createTwilioRecording(twilioClient);
const {
    handleKnowledgeTool,
    handleTechnicianStatusTool
} = createOpenAiToolHandlers({
    searchCompanyKnowledge,
    recordTechnicianStatusUpdate
});


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
    'response.done'
];


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
<Stream url="wss://emma-development-production.up.railway.app/media-stream">   <Parameter
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
<Stream url="wss://emma-development-production.up.railway.app/media-stream">            <Parameter
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
<Stream url="wss://emma-development-production.up.railway.app/media-stream">            <Parameter
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
const sessionContext = buildSessionContext({
    customer,
    recentCalls,
    customerBookings,
    callMode,
    outboundCustomerName,
    customInstructions,
    callerPhone
});
              const {
    customerName,
    customerAddress,
    customerContext,
    recentCallContext,
    bookingContext,
    callModeContext
} = sessionContext;

          const sessionUpdate = buildOpenAiSession({
    SYSTEM_MESSAGE,
    VOICE,
    callModeContext,
    customerContext,
    recentCallContext,
    bookingContext
});

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

            : `Begin the outbound new-lead quote call now.

Say:

"Hi! Thank you for looking for a house cleaning quote with SpeedyCleans. Is this more of a one-time cleaning, or are you interested in recurring cleaning?"

After asking, stop and wait for the customer's answer.`

        : customer && customerBookingCount > 0
        ? `Begin the inbound returning-customer call now.

Say:

"Thank you for calling SpeedyCleans. This is Emma. How can I help you today?"

Do not greet the caller by their saved name.
Do not announce that you recognize them.
Do not say welcome back.
Use saved customer information privately as background context.

This is an existing customer who has previously booked service.

FAST-TRACK RULES FOR RETURNING CUSTOMERS:

- Do not automatically repeat general pricing.
- Do not make them listen to the full new-customer quote.
- Listen to what they need first.
- If they want another cleaning, move directly toward scheduling.
- Use their saved name, phone number, email address, and service address privately.
- Do not ask for information that is already available.
- Ask only whether the service address is the same if confirmation is necessary.
- Ask what service they need and what date or arrival window they prefer.
- If they mention a pricing question, answer only the specific pricing question they asked.
- If their information has changed, collect only the changed information.
- Keep the call quick, friendly, and efficient.

For a returning customer requesting another cleaning, say naturally:

"Absolutely! What type of cleaning do you need, and what day were you hoping to schedule?"

Then stop and wait for their answer.

Do not promise that a date is confirmed unless the booking has actually been completed.

When the request is complete, ask:

"Is there anything else I can help you with today?"

If they say no, say:

"Perfect! Thank you for calling SpeedyCleans. Have a great day!"

Give one friendly closing and do not repeatedly say goodbye.`
                                                                          
      : `Begin the inbound new-customer call now.

say:

"Thank you for calling SpeedyCleans. This is Emma. How can I help you today?"

This caller is not an existing customer.

Allow them to briefly explain what they need.

If they are looking for cleaning service or a quote, first ask:

"Absolutely! Are you looking for a one-time cleaning or recurring cleaning?"

Wait for their answer.

Explain the appropriate pricing.

After they understand the pricing and would like to continue, collect their information ONE QUESTION AT A TIME.

Ask:

"What is your full name?"

Wait for the answer.

Then ask:

"What is the best phone number?"

Wait for the answer.

Then ask:

"What is the full service address?"

Wait for the answer.

Then ask:

"What is the best email address?"

Wait for the answer.

Do not ask for multiple pieces of information in one question.

Do not interrupt while the caller is answering.

If the caller already volunteered information earlier, do not ask for it again.

Do NOT ask about pets.

Do NOT ask how many bedrooms or bathrooms they have.

After collecting the contact information, ask what date they would like their cleaning.

Then continue naturally to schedule the appointment.

When everything is complete, ask:

"Is there anything else I can help you with today?"

If they say no, say:

"Perfect! Thank you for calling SpeedyCleans. Have a great day!"`
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
        `Received event: ${response.type}`
    );
}
const noisyEvents = [
    'response.output_audio.delta',
    'response.output_audio_transcript.delta',
    'input_audio_buffer.speech_started',
    'input_audio_buffer.speech_stopped'
];

if (!noisyEvents.includes(response.type)) {
    console.log(
        'OpenAI Event:',
        response.type
    );
}

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
                        
const knowledgeHandled =
    await handleKnowledgeTool({
        response,
        openAiWs,
        WebSocket
    });

if (!knowledgeHandled) {
    await handleTechnicianStatusTool({
        response,
        openAiWs,
        WebSocket,
        callerPhone
    });
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

fastify.get('/dev/test-technicians', async (request, reply) => {
    try {
        const results = await searchTechnicians({
            city: request.query?.city || '',
            state: request.query?.state || '',
            areaCode: request.query?.areaCode || '',
            hasSupplies: request.query?.hasSupplies || '',
            willingToTravel: request.query?.willingToTravel || '',
            weekends: request.query?.weekends || '',
            limit: request.query?.limit || 10
        });

        return reply.send({
            success: true,
            count: results.length,
            technicians: results
        });
    } catch (error) {
        console.error('DEV technician search failed:', error);

        return reply.code(500).send({
            success: false,
            error: error?.message || 'Technician search failed'
        });
    }
});
fastify.get('/dev/test-knowledge', testKnowledge);
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
