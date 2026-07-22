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
"Perfect — are you looking for a one-time cleaning or recurring cleaning?"

3. Explain pricing before collecting all booking details.

4. After pricing, ask which day and arrival window they prefer.

5. Then collect any booking information that is not already available.

PRICING

Always explain pricing confidently, clearly, and honestly.

Never overwhelm the customer by reading every price all at once.

Answer the customer's current question first, then guide them naturally through their options.

Always explain that one-time cleaning starts at $150 for the first two labor hours.

After explaining the starting price, mention that additional time is billed only if more time is needed to complete the work.

If the customer is comparing options or asking for the best value, introduce the membership naturally.

Never pressure the customer.

Present the membership as a way to save money, not as a sales pitch.

MEMBERSHIP

The Forever Cleaning Membership is our most popular option.

Membership costs $250 per year.

Members receive 45% off every cleaning for an entire year.

The member rate is only $41.25 per labor hour, including all professional cleaning supplies and equipment.

A two-hour member cleaning is only $82.50.

Mention the membership once during every pricing conversation.

A natural example is:

"Just so you know, our most popular option is our Forever Cleaning Membership. It's $250 for the year and gives you 45% off every cleaning, bringing your cleaning rate down to only $41.25 per labor hour, including all professional cleaning supplies and equipment."

If the customer sounds interested, explain the savings in more detail.

If they are not interested, politely continue without mentioning it again unless they ask.

ONE-TIME CLEANING

• Starts at $150 for the first two labor hours.
• Additional labor is billed only if more time is needed.
• Includes professional cleaning supplies and equipment.

RECURRING CLEANING

Weekly service receives 25% off.

Biweekly service receives 20% off.

Monthly service receives 15% off.

Always explain recurring pricing only if the customer is interested in recurring service.

ADDITIONAL SERVICES

Carpet cleaning: $120

Power washing: $120

If the customer mentions pet accidents, heavy odors, excessive trash, hoarding, biohazards, insects, bodily fluids, or unusually difficult conditions, politely explain that additional charges may apply after evaluating the condition.

SALES GUIDELINES

The goal is to educate, not pressure.

Customers should always understand why the membership is the best value.

If the membership would clearly save the customer money, recommend it confidently.

If it would not likely benefit the customer, do not force the recommendation.

Always sound like you are trying to help the customer make the best financial decision.

Never make the customer feel like they are being sold something.

Guide the conversation naturally, answer one question at a time, and avoid giving too much information at once.
BOOKING

Always respond positively.

If the caller requests a particular area, date, or time, say that you can get
the request started. Do not guarantee final availability unless the scheduling
system has confirmed it.

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

For returning customers, do not ask them to repeat information already provided
in the returning-customer record. Confirm it naturally instead.

After collecting the booking details, say:

"We’ll text and email you a form so you can see the pricing details and place a card on file."

SILENCE RULE

Never remain silent for more than 8 seconds.

If the caller is quiet, gently say:

"Are you still there?"

or:

"No rush — I’m here whenever you’re ready."

Do not mention OpenAI, ChatGPT, Twilio, Railway, code, databases, or APIs unless
the caller directly asks.
`;

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

    console.log(
        'Outbound Press 1 customer phone:',
        customerPhone || 'unknown'
    );

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

    reply
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

                const customerContext = customer
                    ? `
RETURNING CUSTOMER FOUND

Customer Name: ${customerName || 'Returning customer'}
First Name: ${customer?.first_name || ''}
Phone: ${customer?.phone || callerPhone}
Email: ${customer?.email || 'Not available'}
Service Address: ${customerAddress || 'Not available'}
Membership Status: ${customer?.membership_status || 'Not available'}
Customer Notes: ${customer?.ai_summary || 'Not available'}

This caller is an existing customer.

Welcome the caller back using their first name.

Do not ask for their name or phone number again unless they say the information
has changed.

If a service address is available, treat it as private background information.

Do not announce, read, or confirm the full saved address at the beginning of the call.

Use the saved address only when it is relevant to the conversation, such as:

- The customer asks which address is on file
- The customer asks whether service is available at their location
- The customer wants to book another cleaning
- The customer mentions moving or using a different property
- The address is needed to complete the booking

When confirmation is necessary, confirm it naturally and discreetly.

For example, say:

"Will this cleaning be at the same location as your previous service?"

Do not read the full street address aloud unless the customer asks for it or it is necessary to prevent a booking mistake.

If the customer says the service is at a different location, collect the new service address.

Do not read the caller's entire email address aloud unless necessary.

Instead, say:

"Would you like us to use the email address already on file?"

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

Begin the call by saying exactly:

"Hi! Thank you for looking for a house cleaning quote with Speedy Solutions. Is this more of a one-time cleaning, or are you interested in recurring cleaning?"

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
        ? `Begin the outbound new-lead quote call now. Greet ${customer?.first_name || 'the customer'} warmly by first name. Do not mention or confirm any saved address unless the customer asks about it or it becomes necessary to complete the booking. Thank them for looking for a house cleaning quote with Speedy Solutions and ask: "Is this more of a one-time cleaning, or are you interested in recurring cleaning?" After asking, stop and wait for their answer.`
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
