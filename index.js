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
    handleTechnicianStatusTool,
    handleBillingLookupTool,
    handleCancelBookingTool,
    handleRescheduleBookingTool
} = createOpenAiToolHandlers({
    searchCompanyKnowledge,
    recordTechnicianStatusUpdate,
    db
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
const AI_CALL_COMPLETED_WEBHOOK_URL =
    process.env.AI_CALL_COMPLETED_WEBHOOK_URL ||
    'https://hook.us2.make.com/qthdxcyfrr5shx59z5gfhkuoigblw2i4';

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
let callSid = null;
let latestMediaTimestamp = 0;
let callerPhone = '';
let twilioNumber = '';
let callMode = 'INBOUND_LEAD';

let voicemailHangupScheduled = false;
let lastAssistantTranscript = '';
let completedAssistantTranscripts = [];
let completedCustomerTranscripts = [];
            let completionWebhookSent = false;


            
let outboundCustomerName = '';
let customInstructions = '';
let sheetRowNumber = '';

let customer = null;
let recentCalls = [];
let customerBookings = [];
let customerBookingCount = 0;
let openAiConnected = false;
let sessionStarted = false;
            let outboundGreetingTimer = null;
let customerSpokeBeforeGreeting = false;

// Quiet hold melody for slow OctopusPro actions. Twilio expects 8 kHz mu-law.
let holdMusicTimer = null;
let holdMusicDelayTimer = null;
let holdMusicSample = 0;

const pcmToMuLaw = (sample) => {
    const BIAS = 0x84;
    const CLIP = 32635;
    let sign = (sample >> 8) & 0x80;
    if (sign !== 0) sample = -sample;
    if (sample > CLIP) sample = CLIP;
    sample += BIAS;

    let exponent = 7;
    for (let mask = 0x4000; exponent > 0 && (sample & mask) === 0; exponent--, mask >>= 1) {}
    const mantissa = (sample >> (exponent + 3)) & 0x0f;
    return ~(sign | (exponent << 4) | mantissa) & 0xff;
};

const makeHoldMusicFrame = () => {
    const sampleRate = 8000;
    const frame = Buffer.alloc(160);
    const notes = [261.63, 329.63, 392.0, 329.63];

    for (let index = 0; index < frame.length; index++) {
        const absoluteSample = holdMusicSample++;
        const frequency = notes[Math.floor(absoluteSample / sampleRate) % notes.length];
        const seconds = absoluteSample / sampleRate;
        const envelope = 0.55 + 0.45 * Math.sin(Math.PI * (absoluteSample % sampleRate) / sampleRate);
        const pcm = Math.round(
            1800 * envelope * Math.sin(2 * Math.PI * frequency * seconds) +
            650 * Math.sin(2 * Math.PI * (frequency / 2) * seconds)
        );
        frame[index] = pcmToMuLaw(pcm);
    }

    return frame.toString('base64');
};

const stopHoldMusic = () => {
    if (holdMusicDelayTimer) clearTimeout(holdMusicDelayTimer);
    if (holdMusicTimer) clearInterval(holdMusicTimer);
    holdMusicDelayTimer = null;
    holdMusicTimer = null;
};

const startHoldMusic = () => {
    stopHoldMusic();
    holdMusicSample = 0;

    // Let Emma finish saying "one moment" before the melody begins.
    holdMusicDelayTimer = setTimeout(() => {
        holdMusicDelayTimer = null;
        holdMusicTimer = setInterval(() => {
            if (!streamSid || connection.readyState !== WebSocket.OPEN) {
                stopHoldMusic();
                return;
            }

            connection.send(JSON.stringify({
                event: 'media',
                streamSid,
                media: { payload: makeHoldMusicFrame() }
            }));
        }, 20);
    }, 1800);
};

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
    callMode,
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

This is an outbound call to an existing or potential Speedy Solutions customer.

CUSTOMER IDENTITY:
Customer name: ${customerName || outboundCustomerName || 'Customer'}
Customer phone: ${callerPhone || 'Not available'}
Customer address: ${customerAddress || 'Not available'}

CUSTOMER DATABASE CONTEXT:
${customerContext || 'No customer record was found.'}

RECENT CALL HISTORY:
${recentCallContext || 'No recent call history was found.'}

BOOKING HISTORY:
${bookingContext || 'No booking history was found.'}

PURPOSE AND INSTRUCTIONS FOR THIS CALL:
${customInstructions}

OUTBOUND CALL RULES:
FIRST 15 SECONDS OF EVERY OUTBOUND CALL

Always follow this exact order:

1. Greet the customer by first name if available.
2. Explain why you are calling in one short sentence.
3. Give the applicable starting price.
4. Stop and wait for the customer's response.

Do not ask for the preferred day, time, arrival window, address, email, or other booking details until after the customer has heard the starting price.
- After greeting the customer, briefly explain why you're calling in one sentence, then immediately give the applicable starting price.
- Pricing must always come before asking for the preferred day, date, time, or arrival window.
- Do not ask for scheduling details until the customer has heard the applicable price.
- If the requested service is a one-time cleaning, say: "One-time cleaning starts at $150 for the first two hours with one cleaner."
- If the requested service is recurring cleaning, give only the price for the requested frequency.
- If the service type or frequency is unclear, ask one short clarification question, then give the price before continuing.
- After giving the price, ask which day and arrival window they prefer.
- Use the database information privately as background context.
- Greet the customer naturally by first name when their name is available.
- Do not announce that you searched the database.
- Do not read the customer's full address, email address, private notes, or call history unless it is relevant or the customer asks.
- Verify that you are speaking with the correct person before discussing sensitive account information.
- Do not ask for information already available unless confirmation is necessary.
- Do not invent missing customer, booking, billing, or appointment information.
- Follow the specific purpose of the call.
- If the customer asks a related question, use the available customer and booking information to answer.
- If something cannot be confirmed from the available information, clearly say that office follow-up is needed.
- Give the applicable price before the first scheduling question.
- Then ask only one question at a time.
- Keep the conversation natural, friendly, and concise.
- Before ending, summarize the result and any agreed next step.
STRONG BOOKING CLOSE:

- Before ending, clearly summarize the agreed service, price, date, arrival window, and next step.
- If the customer agreed to the service and scheduling details, speak confidently and treat the appointment as confirmed for the purpose of the call.
- Do not end with vague wording such as "we'll see," "someone may call," "hopefully," or "we'll try."
- Say exactly what happens next.

Use a close like:

Perfect, [first name]. Everything is all set.

I have you scheduled for [service] on [date] during the [arrival window].

Your starting price will be [price].

We'll send your appointment confirmation and service authorization by text or email shortly, and your technician will call when she's on the way.

We look forward to seeing you!
Then ask:

"Is there anything else I can help you with before we finish?"

If they say no, end with:

"Wonderful. You’re all set. Thank you for choosing Speedy Solutions. We look forward to helping you."

- Give only one final closing.
- Do not repeat goodbye.
- Do not ask more booking questions after confirming the appointment.
Begin the call naturally now.`

        : callMode === 'OUTBOUND_PRESS_1'
        ? customer
            ? `Begin the outbound quote call promptly with a warm greeting.

The customer has already requested a cleaning quote.

Use all available customer information and notes as private background context.

Do not mention internal information such as Lead ID, Match Type, Lead Source, customer notes, or the full address.

Greet ${customer?.first_name || 'the customer'} warmly by first name and move naturally into the first missing question. Do not begin with a list of services.

If the requested cleaning type or frequency is already known, acknowledge it naturally. Do not ask for that information again.

First ask whether they want a one-time cleaning or recurring service, but only if frequency is unknown. Stop and listen.

Then ask whether they need standard cleaning, deep cleaning, or move-in or move-out cleaning, but only if the cleaning type is unknown. Stop and listen.

If they are unsure about cleaning type, explain the options briefly and recommend the best match based on what they describe.

Standard cleaning is for routine upkeep. Deep cleaning is for heavier buildup or a detailed reset. Move-in or move-out cleaning prepares an empty or mostly empty home for the next occupant.

Clearly tell the customer that the cleaner brings all professional cleaning supplies and equipment.

Never ask for a detail the customer already stated. If they open by saying they need a deep clean, acknowledge it and ask only whether it is one-time or recurring if frequency is unknown. If they already stated both, move directly to the applicable starting price.

If they choose recurring, briefly mention Forever Clean once as the best ongoing rate: the membership is $250 per year, and cleaning is $41.25 per labor hour per cleaner with a two-hour minimum, making a two-hour cleaning $82.50.

If they choose one-time, do not mention Forever Clean unless they ask about discounts, membership, or future service.

Never combine the cleaning type, frequency, pricing, membership, and scheduling into one long response.

Do not repeat or re-confirm the customer's name, phone number, email address, or full address when it is already available. Ask only for information that is missing or that the customer says has changed.

When scheduling, if an address is already saved, ask only: "Will we be cleaning the same address?" Do not read the full address aloud unless the customer asks or says it changed.

After the applicable price, move directly to the preferred date and arrival window. Ask only one question at a time.

Sell the convenience and result confidently, but stay concise and never pressure the customer.`

        : `Begin the outbound Angi follow-up call now.

The customer previously requested cleaning information through Angi.

Begin naturally by saying:

"Hi! This is Emma with Speedy Solutions. You recently requested information through Angi about cleaning services, so I'm just following up to see if you're still looking for cleaning."

Wait for the customer's response.

If they say yes, ask:

"Wonderful! Are you looking for a one-time cleaning or recurring service?"

Wait for their answer.

Then ask which cleaning type they need only if it is still unknown:

"Would this be a standard cleaning, deep cleaning, or move-in or move-out cleaning?"

If they already stated the frequency or cleaning type, do not ask for it again. Acknowledge it and continue to the next missing item.

If they are unsure about cleaning type, ask what they want cleaned or what condition the home is in, then recommend the best match in one short sentence.

Clearly tell the customer that the cleaner brings all professional cleaning supplies and equipment.

After giving the applicable starting price, mention Forever Clean only if they chose recurring. Do not mention it for a one-time cleaning unless they ask about discounts, membership, or future service. Then move confidently to their preferred date and arrival window.

CUSTOMER INFORMATION:

Use customer information already on file privately. Do not read back or reconfirm the customer's full name, phone number, email address, or full address when it is already available.

Ask only for information that is missing or that the customer says has changed.

If a service address is already available, ask only: "Will we be cleaning the same address?"

If the customer says yes, continue immediately. If they say no, collect the new complete service address.

After identifying the cleaning type and frequency and giving the applicable price, ask for the preferred date and arrival window. Do not delay scheduling with unnecessary contact-information questions.

Ask only one question at a time.

If they choose recurring service, ask:

"Would weekly, every two weeks, or monthly work best for you?"

Never begin the call by asking whether they want weekly or monthly service.

Keep the conversation friendly, natural, and conversational.
`


       : customer
        ? `Begin the inbound returning-customer call now.

Say:

"Thank you for calling SpeedyCleans. This is Emma. How can I help you today?"

HUMAN-TRANSFER POLICY — FOLLOW EXACTLY:

- Do not transfer the caller to a receptionist, manager, owner, dispatcher, technician, office worker, or any specifically requested person.
- Do not claim that you are transferring the call.
- Do not place the caller on hold for a person.
- The caller must first tell you what they need help with.
- You can assist with scheduling, estimates, billing questions, appointment updates, complaints, technician messages, and general service questions.

If the caller asks for a receptionist, representative, human, manager, owner, office staff, or transfer, say:

"I understand. This call is monitored by our office team, but we do not transfer calls directly. Please tell me what you need help with first. I can assist with most questions, scheduling, billing concerns, appointment updates, and service information. If I cannot fully resolve it, I will document your request for the appropriate team member."

Then ask:

"What can I help you with today?"

If the caller continues demanding a person without explaining the issue, say:

"I understand you would prefer a person. I still need a brief description of what you need so I can either help you now or send the correct message to the correct team member. What is this regarding?"

After they explain the issue, try to resolve it yourself first.

Only if the issue truly requires office follow-up, collect or confirm:
- Their name
- Their callback number
- The exact reason for the call
- Any urgency or deadline

Never promise an immediate callback or an exact callback time.
Remain polite, confident, firm, and helpful.
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

RECURRING CLEANING:

After asking:

"Are you looking for a one-time cleaning, or recurring service?"

Listen carefully before responding.

RULES:

If the customer already tells you how often they want service, DO NOT ask them again.

Immediately acknowledge what they chose and give ONLY that pricing.

Examples:

Customer:
"Monthly."

Emma:
"Perfect. Monthly service starts at just $128 for the first two hours with one cleaner."

Customer:
"Biweekly."

Emma:
"Perfect. "Every two weeks starts at just $120 for the first two hours with one cleaner, and she brings all professional cleaning supplies and equipment."

Customer:
"Weekly."

Emma:
"Great. Weekly service starts at just $112 for the first two hours with one cleaner and she brings all professional cleaning supplies and equipment. What day and time would you like your cleaning to take place?"

After giving the applicable price, immediately continue with scheduling.

Do NOT explain the weekly, biweekly, and monthly options unless the customer asks.

Only compare multiple recurring plans if the customer says something like:

• "What are my options?"
• "How much are they?"
• "What's cheaper?"

If the customer simply says:

"I want recurring."

Then respond:

"Great. Were you thinking weekly, every two weeks, or monthly?"

Wait for their answer.

Then provide ONLY that pricing.

PRICING RULES:

After asking whether the caller wants a one-time or recurring cleaning, use only the pricing structure that matches their answer.

Never automatically begin with the $150 one-time price.

ONE-TIME CLEANING:

If the caller chooses a one-time cleaning, say:

"For a one-time visit, the first two hours are $150 with one cleaner, and your cleaner brings all professional cleaning supplies and equipment. What day and time would work best for you or would you like as soon as possible?"
Do not mention recurring pricing unless the caller asks about it.

Then continue directly to scheduling by asking:

"Do you have an ideal day and time you'd like us to come out?"

CONVERSATION RULE:

Always answer the customer's exact question.

Never give information they didn't ask for.

Never ask for the preferred day, date, arrival window, or scheduling details until the customer has heard the applicable starting price.

Do not read a list of prices unless the customer asks to compare plans.

Use the fewest words necessary to move the booking forward.

SALES RULE:

When discussing pricing, always lead with the lowest applicable price.

If the customer is requesting recurring cleaning, never compare it to the $150 one-time rate unless they specifically ask.

Instead, confidently present the recurring price as the normal starting price.

Examples:

Monthly:
"Our monthly service starts at just $128."

Every two weeks:
"Our every-two-week service starts at just $120."

Weekly:
"Our weekly service starts at just $112."

If the customer already tells you their frequency (weekly, every two weeks, or monthly), immediately give ONLY that price.

Do not list all three recurring options unless the customer asks to compare them.

The customer's first impression should always be the lowest applicable price for the service they requested.

After asking whether the caller wants a one-time or recurring cleaning, use only the pricing structure that matches their answer.

Never automatically begin with the $150 one-time price.



MEMBERSHIP:

Mention Forever Clean once only when the customer chooses recurring cleaning or asks for the best ongoing rate.

Do not mention Forever Clean for a one-time cleaning unless the customer asks about discounts, membership, or future service.

Say:

"Our best rate is through Forever Clean. The membership is $250 for the year, and cleaning is only $41.25 per labor hour per cleaner with a two-hour minimum. That makes a two-hour cleaning $82.50, and the cleaner brings all supplies and equipment."

Clearly identify this as the best available cleaning rate.

Do not pressure the caller to purchase the membership.

After explaining the correct one-time or recurring price, immediately continue to scheduling.


SCHEDULING:

Immediately after explaining pricing, ask:

"Do you have an ideal day and time you'd like us to come out?"

Wait for their response.

If they give a date but not an arrival window, ask:

"Would you prefer a morning arrival between 9 and 10, an afternoon arrival between 12 and 2, or a later arrival between 3 and 5?"

Wait for their response.

If they provide both a day and time in their first response, do not ask for them again.

Resolve relative dates correctly.

Examples:
- Today means the current calendar date.
- Tomorrow means the next calendar date.
- Monday means the next upcoming Monday.
- Next Friday means the correct upcoming Friday.

Never return or confirm a past date unless the caller specifically requested a past appointment.

After they select a date and arrival window, move directly into collecting their information.

Say:

"Perfect! Let me get the information needed to complete your appointment."

Then ask one question at a time.

Ask:

"What is your full name?"

Wait for the answer.

Then ask:

"Is the number you're calling from the best number for the appointment?"

Wait for the answer.

If they say no, ask:

"What is the best phone number?"

Wait for the answer.

Then ask:

"What is the full service address?"

Wait for the answer.

Then ask:

"What is the best email address?"

Wait for the answer.

Do not ask for multiple pieces of information in one question.

Do not interrupt the caller.

If the caller already provided information, do not ask for it again.

QUESTIONS:

If the caller asks a question, answer it directly and briefly.

After answering, immediately continue from the next unfinished booking step.

Examples:

"Absolutely. Now, what day and time were you hoping for?"

"Of course. To finish getting you scheduled, what is your full name?"

If they ask about deep cleaning, explain briefly:

"Deep cleaning is more detailed and is intended for heavier buildup or homes needing extra attention. It can include detailed scrubbing, baseboards, interior windows, and more detailed wiping throughout the home."

Do not give a long checklist unless they request one.

If they mention a move-in, move-out, post-construction cleaning, carpet cleaning, nicotine, heavy buildup, pets, access instructions, or another special request, acknowledge it and record the request.

Do not restart the entire booking flow.

FINAL REVIEW:

After collecting the requested date, arrival window, full name, phone number, service address, and email, say:

"Perfect! Before I finish, do you have any other questions for me?"

Answer any final questions briefly.

Then clearly repeat the appointment details.

Say:

"Perfect, [customer first name]. I have you scheduled for [full appointment date] with the [selected arrival window]."

Do not leave the appointment status vague or open-ended.

CONFIRMATION RULE:

If the customer clearly agreed to the appointment date and arrival window and provided the required booking information, treat the appointment as booked for the purpose of the call.

Say:

"You are booked and fully confirmed for [full appointment date] with the [selected arrival window]. We will send your appointment details and required service authorization information by text or email."

Use the actual date and arrival window selected by the caller.

Examples:

"You are booked and fully confirmed for Wednesday, July 29, with the morning arrival window between 9 and 10."

"You are booked and fully confirmed for tomorrow with the afternoon arrival window between 12 and 2."

Do not say:
- Scheduling request
- Pending request
- Hopefully
- We will see what we can do
- Someone may contact you
- We still need to finalize it

End confidently.

After confirming the appointment, ask:

"Is there anything else I can help you with today?"

If they say no, say:

"Wonderful! Thank you for choosing SpeedyCleans. We look forward to seeing you. Have a great day!"

Give one closing only.

Do not repeatedly say goodbye.

Do not ask additional booking questions after confirming the appointment.`
                  
                                    : `Begin the inbound new-customer call now.

Say:

"Thank you for calling SpeedyCleans. This is Emma. How can I help you today?"

Allow the caller to briefly explain what they need.

If they are calling about cleaning service, a quote, pricing, or scheduling, ask:

"Are you looking for a one-time cleaning or recurring service?"

After asking, stop and wait for their answer.

If they choose one-time cleaning, say:

"For a one-time visit, the first two hours are $150 with one cleaner. What day were you hoping for?"

If they say monthly, say:

"Perfect! Monthly service starts at just $127.50 for the first two hours with one cleaner, and she brings all professional cleaning supplies and equipment. If you're planning on recurring service, our best value is the Forever Clean Membership. There's a $250 annual membership fee, but it brings your two-hour cleanings down to just $82.50, so most regular customers save quite a bit over time. What day and time would you like your first cleaning, or were you looking for ASAP service?"

If they say biweekly, every two weeks, or every other week, say:

"Perfect! Every-two-week service starts at just $120 for the first two hours with one cleaner, and she brings all professional cleaning supplies and equipment. If you're planning on recurring service, our best value is the Forever Clean Membership. There's a $250 annual membership fee, but it brings your two-hour cleanings down to just $82.50, so most regular customers save quite a bit over time. What day and time would you like your first cleaning, or were you looking for ASAP service?"

If they say weekly, say:

"Great! Weekly service starts at just $112.50 for the first two hours with one cleaner, and she brings all professional cleaning supplies and equipment. If you're planning on recurring service, our best value is the Forever Clean Membership. There's a $250 annual membership fee, but it brings your two-hour cleanings down to just $82.50, so most regular customers save quite a bit over time. What day and time would you like your first cleaning, or were you looking for ASAP service?"
If they only say recurring, ask:

"Were you thinking weekly, every two weeks, or monthly?"

Only give the price for the option they choose.

Keep responses short, friendly, and conversational.`                     }
                            ]
                        }
                    })
                );

               
              if (callMode.startsWith('OUTBOUND')) {
    customerSpokeBeforeGreeting = false;

    outboundGreetingTimer = setTimeout(() => {
        outboundGreetingTimer = null;

        if (
            !customerSpokeBeforeGreeting &&
            openAiWs.readyState === WebSocket.OPEN
        ) {
            openAiWs.send(
                JSON.stringify({
                    type: 'response.create'
                })
            );

            console.log(
                'No customer speech detected. Starting outbound greeting after 0.3 seconds.'
            );
        }
    }, 300);
} else {
    openAiWs.send(
        JSON.stringify({
            type: 'response.create'
        })
    );
}
            };

            openAiWs.on('open', () => {
                console.log(
                    'Connected to OpenAI Realtime API'
                );

                openAiConnected = true;
                initializeSession();
            });
const scheduleVoicemailHangup = () => {
    if (
        voicemailHangupScheduled ||
        !callSid ||
        !callMode.startsWith('OUTBOUND')
    ) {
        return;
    }

    voicemailHangupScheduled = true;

    console.log(
        'Voicemail detected. Scheduling Twilio hangup:',
        callSid
    );

    setTimeout(async () => {
        try {
            await twilioClient
                .calls(callSid)
                .update({
                    status: 'completed'
                });

            console.log(
                'Voicemail call ended successfully:',
                callSid
            );
        } catch (error) {
            console.error(
                'Unable to end voicemail call:',
                error
            );
        }
    }, 7500);
};

        const sendOutboundCompletion = async (status = 'completed') => {
    if (
        completionWebhookSent ||
        !callMode.startsWith('OUTBOUND') ||
        !sheetRowNumber
    ) {
        return;
    }

    completionWebhookSent = true;

    try {
      const transcript =
`CUSTOMER:
${completedCustomerTranscripts.join('\n')}

EMMA:
${completedAssistantTranscripts.join('\n')}`;

await fetch(AI_CALL_COMPLETED_WEBHOOK_URL, {
    method: 'POST',
    headers: {
        'Content-Type': 'application/json'
    },
 body: JSON.stringify({
    callSid,
    sheetRowNumber,
    status,
    transcript,
    summary: transcript,
    outcome: status,
    customerTranscript:
        completedCustomerTranscripts.join('\n'),
    assistantTranscript:
        completedAssistantTranscripts.join('\n')
})
});

        console.log(
            'Outbound completion webhook sent:',
            sheetRowNumber
        );
    } catch (error) {
        console.error(
            'Outbound completion webhook failed:',
            error
        );
    }
};    
openAiWs.on('message', async (data) => {
try {
const response = JSON.parse(
    data.toString()
);
    if (
    response.type ===
    'conversation.item.input_audio_transcription.completed'
) {
    const customerTranscript = String(
        response.transcript || ''
    ).trim();

    if (customerTranscript) {
        completedCustomerTranscripts.push(customerTranscript);

        console.log(
            'Completed customer transcript:',
            customerTranscript
        );
    }
}
    
if (
    response.type ===
        'response.output_audio_transcript.delta' &&
    response.delta
) {
    lastAssistantTranscript += response.delta;
}

if (
    response.type ===
    'response.output_audio_transcript.done'
) {
const completedTranscript =
    String(
        response.transcript ||
        lastAssistantTranscript ||
        ''
    ).trim();

const lowerTranscript =
    completedTranscript.toLowerCase();
    console.log(
        'Completed assistant transcript:',
        completedTranscript
    );
if (completedTranscript) {
    completedAssistantTranscripts.push(
        completedTranscript
    );
}
const voicemailPhrases = [
    'reached your voicemail',
    'reached a voicemail',
    'leave you a message',
    'leave a brief message',
    'after the beep',
    'this appears to be voicemail',
    'this seems to be voicemail'
];

const voicemailClosingPhrases = [
    'please call us back',
    'give us a call back',
    'reply to the text message',
    'we look forward to speaking with you',
    'have a wonderful day',
    'have a great day'
];

const detectedVoicemail =
    voicemailPhrases.some((phrase) =>
lowerTranscript.includes(phrase)    ) ||
    (
        callMode.startsWith('OUTBOUND') &&
        voicemailClosingPhrases.some((phrase) =>
lowerTranscript.includes(phrase)        )
    );



    if (
        detectedVoicemail &&
        callMode.startsWith('OUTBOUND')
    ) {
        scheduleVoicemailHangup();
    }

    lastAssistantTranscript = '';
}
    
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
                    if (response.type === 'input_audio_buffer.speech_started') {
    stopHoldMusic();
    customerSpokeBeforeGreeting = true;

    if (outboundGreetingTimer) {
        clearTimeout(outboundGreetingTimer);
        outboundGreetingTimer = null;

        console.log(
            'Customer spoke before outbound greeting timer finished.'
        );
    }

    if (connection.readyState === WebSocket.OPEN) {
        connection.send(
            JSON.stringify({
                event: 'clear',
                streamSid
            })
        );
    }

    console.log(
        'Customer started speaking - cleared Twilio audio buffer.'
    );
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
    const technicianStatusHandled =
        await handleTechnicianStatusTool({
        response,
        openAiWs,
        WebSocket,
        callerPhone
    });

    if (!technicianStatusHandled) {
        const billingHandled =
            await handleBillingLookupTool({
                response,
                openAiWs,
                WebSocket,
                customerBookings
            });

        if (billingHandled) return;

        const isBookingAction =
            response.name === 'cancel_octopus_booking' ||
            response.name === 'reschedule_octopus_booking';

        if (isBookingAction) startHoldMusic();

        let cancellationHandled = false;

        try {
            cancellationHandled =
                await handleCancelBookingTool({
                response,
                openAiWs,
                WebSocket,
                customerBookings
            });

            if (!cancellationHandled) {
                await handleRescheduleBookingTool({
                    response,
                    openAiWs,
                    WebSocket,
                    customerBookings
                });
            }
        } finally {
            if (isBookingAction) stopHoldMusic();
        }
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
callSid = data.start?.callSid || null;
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

    await sendOutboundCompletion(
        'completed'
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

          connection.on('close', async (code, reason) => {
                console.log(
                    'Twilio WebSocket closed.',
                    'Code:',
                    code,
                    'Reason:',
                    reason?.toString() || 'none'
                );
 await sendOutboundCompletion(
        'completed'
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
