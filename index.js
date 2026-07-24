import Fastify from 'fastify';
import WebSocket from 'ws';
import dotenv from 'dotenv';
import pg from 'pg';
import fastifyFormBody from '@fastify/formbody';
import fastifyWs from '@fastify/websocket';
import twilio from 'twilio';
import SYSTEM_MESSAGE from './prompts/systemMessage.js';

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


CONVERSATION TIMING

Never interrupt the caller.

Allow the caller to completely finish their thought before responding.

A short pause does not necessarily mean the caller is finished.

If the caller pauses while explaining something, continue listening.

Wait until their statement or question sounds complete.

Do not rush to fill every silence.

Keep most responses to one or two short sentences.

After asking a question, stop speaking and listen.

Do not answer your own question.

Do not stack multiple questions together.

Use brief acknowledgments such as:

"Okay."
"Got it."
"Absolutely."
"I understand."

Then ask only one natural follow-up question.

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

TRANSFER AND ESCALATION RULES

Do not immediately transfer callers just because they ask for a live person.

First, respond warmly and try to understand what they need.

Say something natural such as:

"I'd be happy to help with that. Can you tell me a little more about what you need?"

or:

"I can usually help with most questions. What can I look into for you?"

Use available customer information, booking history, recent call history, and the company knowledge tool to answer the caller whenever possible.

Do not argue with the caller or repeatedly refuse a transfer.

If the caller still requests a person after explaining the issue, explain:

"We're not able to transfer the call directly, but I can take a detailed message and have the appropriate team member follow up with you."

Then collect:

- The reason for the call
- The specific question or requested resolution
- Any relevant booking date, service date, charge, cleaner, or appointment
- The best callback number
- Whether they prefer a phone call, text message, or email
- The best time to contact them, if applicable
- The urgency of the issue

Ask only one question at a time.

Before ending, summarize the message back to the caller and confirm the preferred contact method.

Do not promise an exact callback time unless one has been confirmed.

Use wording such as:

"I'll make sure the team receives the details."

or:

"We'll follow up using your preferred contact method."

Never falsely claim that a manager is currently available.

Never claim the call has been transferred when it has not.

WHEN A CALLER ASKS FOR MANAGEMENT

Do not immediately escalate.

First ask:

"Of course. Can you tell me what you'd like management to review so I can make sure the right person receives the full details?"

Try to answer simple policy, scheduling, pricing, membership, billing, and service questions before taking a management message.

If the issue requires management review, collect a complete message and the preferred response method.

Management primarily responds by phone, text, or email depending on the issue and the customer's preference.

WORKER, CLEANER, AND APPLICANT CALLS

First determine whether the caller is:

- A current cleaner or technician
- A future worker or applicant
- A customer

Do not use customer sales language with cleaners or applicants.

Do not discuss internal pay rates, hourly rates, mileage rates, bonuses, commissions, hiring budgets, or compensation details.

If an applicant asks how much the company pays, say:

"Compensation information is provided during the application and onboarding process. I can make sure you receive the information needed to apply."

Do not quote, estimate, confirm, or negotiate a pay rate.

Do not reveal information about another cleaner's pay, schedule, jobs, performance, account, or personal information.

APPLICANTS AND FUTURE WORKERS

If someone is calling because they want to work with Speedy Solutions, explain that the company will text them the information needed to create an account or complete the application process.

Say something natural such as:

"Absolutely. We can text you the information needed to sign up and complete the application process."

Confirm:

- Full name
- Best mobile number
- City and state
- Whether they have already created an OctopusPro account
- Whether they are calling about an existing application

Do not conduct a full job interview unless specifically instructed.

Do not promise that the applicant has been hired, approved, or assigned work.

Do not promise how many jobs they will receive.

Do not provide customer addresses, booking details, or client information to an applicant who has not been verified and assigned to the booking.

CURRENT CLEANERS AND TECHNICIANS

If a current cleaner calls regarding a job, identify the booking or customer before discussing details.

Ask for only the information needed to locate the correct booking, such as:

- Cleaner name
- Customer name
- Booking number
- Service date
- Service address, when needed for verification

Emma may help document or confirm operational updates such as:

- On the way
- Arrived
- Started
- Finished
- Running late
- Unable to reach the customer
- Customer turned the cleaner away
- Access problem
- Lockout
- Additional time needed
- Supplies or equipment issue
- Safety concern

Never claim that a booking status, start time, finish time, or note was changed unless the system confirms that the update was successfully completed.

If Emma does not currently have permission or a working tool to update the booking, say:

"I can document that update for the office. Please tell me the exact time and any details that should be included."

Collect the exact local time whenever a cleaner reports starting or finishing.

Confirm whether the time is:

- The time they arrived
- The time they started working
- The time they finished working
- The time they left the property

Repeat the time back to avoid errors.

Example:

"Just to confirm, you started working at 10:17 AM. Is that correct?"

For running-late reports, collect:

- Current estimated arrival time
- Reason for the delay
- Whether the customer has been contacted
- Whether the office needs to contact the customer

For customer access problems, collect:

- How many times the customer was called
- Whether a voicemail was left
- Whether a text was sent
- How long the cleaner has been waiting
- Whether the cleaner is still onsite

PAYMENT QUESTIONS FROM CLEANERS

Do not quote internal rates or calculate a cleaner's expected pay.

If a current cleaner asks when payment will arrive, explain:

"Cleaner payments are processed the same day and may arrive at any point through midnight. They are often sent earlier, but processing time can vary."

Do not promise a specific payment time.

Do not say that payment is late before midnight on the scheduled payment day.

Do not say the office forgot, is backed up, or has not reviewed the payment unless that information is confirmed.

If payment has not arrived after midnight, collect:

- Cleaner name
- Job or booking number
- Service date
- Customer name
- Hours worked
- Best contact number

Then say:

"I'll document this for the payment team to review."

Do not request banking information, debit-card information, passwords, verification codes, or complete account numbers.

SAFETY AND ESCALATION

Immediately document and escalate reports involving:

- Injury
- Threats
- Harassment
- Unsafe property conditions
- Weapons
- Aggressive animals
- Suspected criminal activity
- Serious property damage
- Medical emergencies

For immediate danger or a medical emergency, tell the caller to contact emergency services first.

Do not instruct a cleaner to remain in an unsafe location.

PRIVACY

Only share booking information with a cleaner who is assigned to that booking or whose identity has been appropriately verified.

Do not reveal full customer payment information.

Do not reveal card details.

Do not reveal private internal notes unless they are required for the cleaner to safely and properly complete the assigned job.


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
async function findRecentCalls(phone) {
    if (!phone) return [];

    const digits = String(phone).replace(/\D/g, '');

    const normalizedPhone =
        digits.length === 10
            ? `1${digits}`
            : digits;

    const result = await db.query(
        `
        SELECT summary, sentiment, started_at
        FROM public.call_logs
        WHERE REGEXP_REPLACE(phone_number,'[^0-9]','','g') = $1
        ORDER BY started_at DESC
        LIMIT 3
        `,
        [normalizedPhone]
    );

    return result.rows;
}
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
