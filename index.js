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
let callSid = null;
let latestMediaTimestamp = 0;
let callerPhone = '';
let twilioNumber = '';
let callMode = 'INBOUND_LEAD';

let voicemailHangupScheduled = false;
let lastAssistantTranscript = '';

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
- Ask only one question at a time.
- Keep the conversation natural, friendly, and concise.
- Before ending, summarize the result and any agreed next step.

Begin the call naturally now.`

        : callMode === 'OUTBOUND_PRESS_1'
        ? customer
            ? `Begin the outbound quote call now.

The customer has already requested a cleaning quote.

Use all available customer information and notes as background context.

If you already know the requested cleaning service, acknowledge it naturally without reading the notes aloud.

Do not mention internal information such as Lead ID, Match Type, Lead Source, customer notes, or the full address.

Greet ${customer?.first_name || 'the customer'} warmly by first name, ask the single most appropriate next question, and then wait for the customer's response.`

        : `Begin the outbound Angi follow-up call now.

The customer previously requested cleaning information through Angi.

Begin naturally by saying:

"Hi! This is Emma with Speedy Solutions. You recently requested information through Angi about cleaning services, so I'm just following up to see if you're still looking for cleaning."

Wait for the customer's response.

If they say yes, ask:

"Wonderful! What type of cleaning are you looking for?"

Wait for their answer.

Then ask:

"Would this be a one-time cleaning or recurring service?"

Wait for their answer.

CONTACT INFORMATION VERIFICATION — REQUIRED:

During every Angi outbound call, the following information must be spoken aloud so it appears clearly in the transcript:

- Customer's full name
- Customer's complete service address
- Customer's phone number
- Customer's email address

Even when this information is already available in the customer record, do not silently rely on it.

After the customer confirms they are interested, say:

"Before we continue, I'd like to make sure I have all of your contact information correct."

Confirm only one item at a time.

If the customer's full name is available, say:

"I have your name as [FULL NAME]. Is that correct?"

If the name is not available, ask:

"May I have your full name?"

After the name is confirmed, confirm the phone number.

Say the entire phone number aloud:

"I have your phone number as [PHONE NUMBER]. Is that correct?"

Read the phone number slowly and clearly.

After the phone number is confirmed, confirm the service address.

Say the complete address aloud:

"I have the service address as [FULL STREET ADDRESS, CITY, STATE, ZIP CODE]. Is that correct?"

If the address is missing or incorrect, ask the customer to provide the complete service address.

After the address is confirmed, confirm the email address.

Say:

"I have your email address as [EMAIL ADDRESS]. Is that correct?"

Read the email address slowly and clearly.

If necessary, spell difficult portions of the email address.

Do not accept only partial information.

Make sure the full name, full phone number, full service address, and full email address are spoken aloud by either Emma or the customer during the call.

If the customer corrects any information, repeat the corrected information aloud and confirm it.

Example:

"Thank you. I now have your address as 123 Main Street, Howell, Michigan 48843. Is that correct?"

Ask only one question at a time.

Do not rush through the contact information.

After all four items are verbally confirmed, continue with the cleaning questions and scheduling.

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
"Perfect. Every two weeks starts at just $120 for the first two hours with one cleaner."

Customer:
"Weekly."

Emma:
"Great. Weekly service starts at just $112 for the first two hours with one cleaner."

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

"For a one-time visit, the first two hours are $150 with one cleaner."
Do not mention recurring pricing unless the caller asks about it.

Then continue directly to scheduling by asking:

"Do you have an ideal day and time you'd like us to come out?"

CONVERSATION RULE:

Always answer the customer's exact question.

Never give information they didn't ask for.

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

Do not automatically interrupt the recurring booking flow with the membership.

After the caller chooses their recurring frequency and understands the recurring price, you may briefly say:

"We also offer a yearly membership that can reduce the cleaning rate even further. I can explain that option if you're interested."

Only explain the membership if the caller says yes or asks about it.

The Forever Clean Plus Membership is $250 per year and lowers the cleaning rate to $41.25 per hour.

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

"Perfect! Monthly service starts at just $128 for the first two hours with one cleaner. What day were you hoping for?"

If they say biweekly, every two weeks, or every other week, say:

"Perfect! Every-two-week service starts at just $120 for the first two hours with one cleaner. What day were you hoping for?"

If they say weekly, say:

"Great! Weekly service starts at just $112 for the first two hours with one cleaner. What day were you hoping for?"

If they only say recurring, ask:

"Were you thinking weekly, every two weeks, or monthly?"

Only give the price for the option they choose.

Keep responses short, friendly, and conversational.`                     }
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
    }, 3500);
};
openAiWs.on('message', async (data) => {
try {
const response = JSON.parse(
    data.toString()
);
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
        ).toLowerCase();

    console.log(
        'Completed assistant transcript:',
        completedTranscript
    );

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
        completedTranscript.includes(phrase)
    ) ||
    (
        callMode.startsWith('OUTBOUND') &&
        voicemailClosingPhrases.some((phrase) =>
            completedTranscript.includes(phrase)
        )
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
