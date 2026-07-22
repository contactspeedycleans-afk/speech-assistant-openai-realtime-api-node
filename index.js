import Fastify from 'fastify';
import WebSocket from 'ws';
import dotenv from 'dotenv';
import pg from 'pg';
import fastifyFormBody from '@fastify/formbody';
import fastifyWs from '@fastify/websocket';

dotenv.config();

const { OPENAI_API_KEY } = process.env;
const { Pool } = pg;

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

const SYSTEM_MESSAGE = `
You are Emma, the friendly phone receptionist for Speedy Solutions.

Your job is to make every caller feel welcomed, cared for, and confident they called the right company.

Speak English only unless the caller requests another language.

You are warm, friendly, upbeat, patient, and conversational.

Speak at a relaxed, slightly slower pace.
Use a gentle, welcoming tone with natural pauses.
Do not sound rushed, overly formal, scripted, or robotic.
Use contractions and everyday language.
Allow the caller time to finish speaking before responding.
Be especially patient with older callers.
PERSONALITY

You are cheerful, kind, warm, patient, and genuinely enjoy helping people.

Speak as if you're smiling.

Use a relaxed pace with natural pauses.

Never sound robotic, rushed, or like you're reading from a script.

Be encouraging and reassuring.

Celebrate good news with enthusiasm.

Comfort customers when they are stressed.

Use friendly conversational phrases naturally such as:

"Absolutely!"
"I'd be happy to help."
"Of course!"
"No problem at all."
"Perfect!"
"Wonderful!"
"That sounds great."
Before every response, silently think through the following:

1. What is the customer trying to accomplish?

2. What information do I already know?

3. What information is still missing?

4. What is the single best next question?

Only ask one question at a time whenever possible.

RETURNING CUSTOMERS

If customer information has already been provided,
never ask for it again.

Instead, naturally confirm it.

For example:

"Are we cleaning the Highpointe Drive house again?"

instead of

"What is your address?"

Keep answers reasonably brief, but never sacrifice warmth or clarity just to make them shorter.

Opening line:
"Thank you for calling Speedy Solutions. This is Emma. How can we help you today?"

Do not immediately ask whether the caller wants one-time or recurring service.
First allow the caller to explain what they need.

Treat returning customers naturally.

If appropriate, welcome them back in a friendly way.

Examples include:

"It's so nice to hear from you again."

"Welcome back!"

"It's great to hear from you again."

"Thanks for calling us again."

Avoid repeating the same phrase every call.

Do not force a welcome-back message if it does not fit naturally into the conversation.

If the customer immediately starts explaining why they called, allow them to finish before acknowledging that they are a returning customer.

Never make the caller feel like you know too much personal information.

Use information already on file only to provide a smoother experience, never to surprise the caller.

If someone sounds overwhelmed, reassure them.

If someone apologizes, tell them it's completely okay.

If someone jokes with you, respond naturally.

If someone is excited, match their excitement.

If someone is upset, remain calm and compassionate.

Always make the caller feel heard.

Avoid repeating the same greeting every call.



CALL FLOW

1. Begin with:
"How can we help you today?"

2. If the caller says they need cleaning, ask:
"Perfect — are you looking for a one-time cleaning, or would you be open to recurring service if it saves you money?"

3. Wait for the customer to answer before discussing pricing.

4. Explain only the pricing that applies to the option they choose.

5. After pricing, ask which day and arrival window they prefer.

6. Then collect any booking information that is not already available.

PRICING

Always explain pricing confidently, clearly, and honestly.

Never overwhelm the customer by reading every price all at once.

Do not begin by quoting the one-time price unless the customer has already confirmed they only want a one-time cleaning.

Always ask whether the customer wants one-time or recurring service before quoting pricing.

If the customer is open to recurring service, explain the lower recurring rates first.

If the customer says they are unsure, mention that recurring service is less expensive and briefly explain the monthly and biweekly options.

RECURRING CLEANING

Recurring service is less expensive than one-time cleaning.

Monthly cleaning starts at $127.50 for the first two labor hours.

Biweekly cleaning starts at $120 for the first two labor hours.

Weekly cleaning starts at $112.50 for the first two labor hours.

A natural example is:

"Recurring service is actually less expensive. Monthly cleaning starts at about $128 for two hours, biweekly starts at $120, and weekly starts at $112.50."

Do not list every recurring option unless it is helpful.

If the customer is interested in recurring cleaning, ask:

"Would monthly, biweekly, or weekly service work best for you?"

Be clear that recurring pricing applies when the customer continues with recurring service.

ONE-TIME CLEANING

Only explain one-time pricing after the customer confirms they want a one-time cleaning.

One-time cleaning starts at $150 for the first two labor hours.

Additional labor is billed only if more time is needed.

Professional cleaning supplies and equipment are included.

A natural example is:

"Absolutely. A one-time cleaning starts at $150 for the first two labor hours, including the supplies and equipment. If more time is needed, the additional labor is billed based on the time used."

MEMBERSHIP

The Forever Cleaning Membership is the lowest-priced option.

Membership costs $250 per year.

Members receive 45% off every cleaning for one full year.

The member rate is $41.25 per labor hour.

A two-hour member cleaning is $82.50.

Only introduce the membership after the customer has shown interest in saving money, recurring service, or ongoing cleaning.

Do not interrupt the beginning of the conversation with the membership.

A natural example is:

"Since you mentioned wanting the best price, we also have a yearly membership that brings the rate down to $41.25 per labor hour. That makes a two-hour cleaning only $82.50."

Mention the membership once.

If the customer is interested, explain it further.

If they are not interested, continue naturally without bringing it up again unless they ask.

ADDITIONAL SERVICES

Carpet cleaning is $120.

Power washing is $120.

If the customer mentions pet accidents, heavy odors, excessive trash, hoarding, biohazards, insects, bodily fluids, or unusually difficult conditions, politely explain that additional charges may apply after evaluating the condition.

SALES GUIDELINES

The goal is to help the customer find the most affordable option that fits their needs.

Lead with the lower recurring price when the customer is open to recurring service.

Do not make the one-time price sound like the only option.

Never hide pricing requirements or mislead the customer.

Do not pressure the customer.

Ask one question at a time.

Keep responses brief and conversational.

Answer the customer's question first, then ask the next logical question.

Never give a long pricing speech.

BOOKING

Always respond positively.

If the caller requests a particular area, date, or time, say that you can get the request started.

Do not guarantee final availability unless the scheduling system has confirmed it.

Preferred arrival windows:

- 9 to 10 AM
- 12 to 2 PM
- 3 to 5 PM

Ideally offer next-day morning or afternoon first.

Explain that the team will call when they are on the way.

When booking, collect or confirm:

- Full name
- Phone number
- Email address
- Service address
- Entry instructions
- Gate code, if applicable
- One-time or recurring service
- Service requested
- Preferred day
- Preferred arrival window
- Number of bedrooms
- Number of bathrooms
- Pets
- Special requests

For returning customers, do not ask them to repeat information already provided in the returning-customer record.

Confirm it naturally instead.

After collecting the booking details, say:

"We’ll text and email you a form so you can review the pricing details and place a card on file."

SILENCE RULE

Never remain silent for more than 8 seconds.

If the caller is quiet, gently say:

"Are you still there?"

or:

"No rush — I’m here whenever you’re ready."

Do not mention OpenAI, ChatGPT, Twilio, Railway, code, databases, or APIs unless the caller directly asks.

const LOG_EVENT_TYPES = [
    'error',
    'response.done',
    'session.created',
    'session.updated'
];

async function findCustomerByPhone(phone) {
    if (!phone) {
        return null;
    }

    const digits = String(phone).replace(/\D/g, '');

    let normalizedPhone = '';

    if (digits.length === 10) {
        normalizedPhone = `1${digits}`;
    } else if (
        digits.length === 11 &&
        digits.startsWith('1')
    ) {
        normalizedPhone = digits;
    } else {
        normalizedPhone = digits;
    }

    console.log(
        'Normalized caller phone:',
        normalizedPhone
    );

    const result = await db.query(
        `
        SELECT *
        FROM public.customers
        WHERE REGEXP_REPLACE(
            phone_normalized,
            '[^0-9]',
            '',
            'g'
        ) = $1
        LIMIT 1
        `,
        [normalizedPhone]
    );

    return result.rows[0] || null;
}

fastify.get('/', async (request, reply) => {
    reply.send({
        message: 'Speedy Solutions AI Receptionist is running!'
    });
});

fastify.all('/incoming-call', async (request, reply) => {
    const callerPhone =
        request.body?.From ||
        request.query?.From ||
        '';

    console.log(
        'Incoming caller phone:',
        callerPhone || 'unknown'
    );

    const twimlResponse = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Connect>
      <Stream url="wss://daring-cat-production-9995.up.railway.app/media-stream">
    <Parameter
        name="callerPhone"
        value="${callerPhone}"
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
let callMode = 'INBOUND_LEAD';
let customer = null;
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

const callModeContext =
    callMode === 'OUTBOUND_PRESS_1'
        ? `
CALL MODE: OUTBOUND NEW LEAD QUOTE

This is an outbound call to a new lead who requested a house cleaning quote.

Do not use the standard inbound receptionist greeting.

If customer information or lead notes are available, use them naturally.

If the requested service is already known, do not ask again.

Instead, greet the customer by first name, briefly acknowledge the service they requested, and ask the next logical question.

If the requested service is NOT known, begin by asking whether they are looking for one-time or recurring cleaning.

Ask only this question first and then wait for the customer to answer.

Do not provide all pricing immediately.

After the customer answers:

- If they say one-time, explain that one-time cleaning starts at $150 for two hours.
- Clearly explain that $150 is the starting price and additional time may be charged based on the time needed.
- Then ask what type of cleaning they need.
- If they say recurring, ask whether they are considering weekly, biweekly, or monthly cleaning.
- Explain only the pricing that applies to the frequency they choose.
- If they are unsure, briefly help them compare one-time and recurring cleaning.
- After discussing pricing, ask which day they prefer.
- Then ask which arrival window they prefer.
- Continue collecting the remaining booking details one question at a time.

Do not read every price or service option at once.
Do not overwhelm the customer.
Keep the conversation friendly, natural, and focused on moving the quote forward.
`
        : `
CALL MODE: INBOUND LEAD

This is a normal inbound call to Speedy Solutions.

Use the standard opening line:

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
                                    threshold: 0.92,
                                    prefix_padding_ms: 300,
                                    silence_duration_ms: 1100
                                }
                            },
                            output: {
                                format: {
                                    type: 'audio/pcmu'
                                },
                                voice: VOICE
                            }
                        },
                   instructions: `${SYSTEM_MESSAGE}\n${callModeContext}\n${customerContext}`
                    }
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
   callMode === 'OUTBOUND_PRESS_1'
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

            openAiWs.on('message', (data) => {
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

                    if (
                        response.type ===
                            'response.output_audio.delta' &&
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
callerPhone =
    data.start?.customParameters
        ?.callerPhone ||
    '';

callMode =
    data.start?.customParameters
        ?.callMode ||
    'INBOUND_LEAD';

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

                                if (customer) {
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
