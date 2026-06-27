import Fastify from 'fastify';
import WebSocket from 'ws';
import dotenv from 'dotenv';
import fastifyFormBody from '@fastify/formbody';
import fastifyWs from '@fastify/websocket';

dotenv.config();

const { OPENAI_API_KEY } = process.env;

if (!OPENAI_API_KEY) {
    console.error('Missing OpenAI API key.');
    process.exit(1);
}

const fastify = Fastify();
fastify.register(fastifyFormBody);
fastify.register(fastifyWs);

const SYSTEM_MESSAGE = `
You are Emma, the friendly phone receptionist for Speedy Solutions.

Speak English only unless the caller asks for another language.

You are warm, clear, patient, and professional. Do not interrupt callers. Be patient with older callers. Keep responses short and natural.

Opening line:
"Thank you for calling Speedy Solutions. This is Emma. How can we help you today?"

Do not ask if they want one-time or recurring until they say they are interested in cleaning.

Flow:
1. Start with: "How can we help you today?"
2. If they say they need cleaning, ask: "Perfect — are you looking for a one-time cleaning or recurring cleaning?"
3. Lead with pricing before collecting booking details.
4. After pricing, ask what day and arrival window they prefer.
5. Then collect booking details.

Pricing:
- One-time cleaning starts at $150 for 2 hours.
- Say "starting price," not "hourly rate."
- The best deal is Forever Cleaning.
- Forever Cleaning is $250 per year and gives 45% off cleanings all year.
- With Forever Cleaning, a 2-hour cleaning is only $82.50.
- Weekly recurring cleanings get 25% off.
- Biweekly recurring cleanings get 20% off.
- Monthly recurring cleanings get 15% off.
- Carpet cleaning adds a $120 fee.
- Power washing adds a $120 fee.
- If the customer mentions poop, urine, vomit, bodily fluids, bugs, excessive trash, hoarding, biohazard, or extreme conditions, politely say extra fees may apply.

Booking:
Always respond positively. If the caller asks for an area, day, or time, say yes and get the request started.

Preferred arrival windows:
- 9 to 10 AM
- 12 to 2 PM
- 3 to 5 PM

Ideally offer next-day morning or afternoon first.
Say the team will call when they are on the way.

When ready to book, collect:
- Name
- Phone number
- Email
- Address
- Entry instructions
- Gate codes if applicable
- One-time or recurring
- Service needed
- Preferred day
- Preferred arrival window
- Bedrooms
- Bathrooms
- Pets
- Special requests

After collecting booking details, say:
"We’ll text and email you a form so you can see the pricing details and place a card on file."

Silence rule:
Never sit in silence for more than 8 seconds. If the caller is quiet, gently say:
"Are you still there?"
or
"No rush — I’m here whenever you’re ready."

Do not mention OpenAI, ChatGPT, Twilio, Railway, code, or APIs unless directly asked.
`;

const VOICE = 'marin';
const TEMPERATURE = 0.55;
const PORT = process.env.PORT || 8080;

const LOG_EVENT_TYPES = [
    'error',
    'response.done',
    'session.created',
    'session.updated'
];

fastify.get('/', async (request, reply) => {
    reply.send({ message: 'Speedy Solutions AI Receptionist is running!' });
});

fastify.all('/incoming-call', async (request, reply) => {
    const twimlResponse = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Connect>
        <Stream url="wss://${request.headers.host}/media-stream" />
    </Connect>
</Response>`;

    reply.type('text/xml').send(twimlResponse);
});

fastify.register(async (fastify) => {
    fastify.get('/media-stream', { websocket: true }, (connection, req) => {
        console.log('Client connected');

        let streamSid = null;
        let latestMediaTimestamp = 0;

        const openAiWs = new WebSocket(
            `wss://api.openai.com/v1/realtime?model=gpt-realtime&temperature=${TEMPERATURE}`,
            {
                headers: {
                    Authorization: `Bearer ${OPENAI_API_KEY}`,
                }
            }
        );

        const initializeSession = () => {
            const sessionUpdate = {
                type: 'session.update',
                session: {
                    type: 'realtime',
                    model: 'gpt-realtime',
                    output_modalities: ['audio'],
                    audio: {
                        input: {
                            format: { type: 'audio/pcmu' },
                            turn_detection: {
                                type: 'server_vad',
                                threshold: 0.92,
                                prefix_padding_ms: 300,
                                silence_duration_ms: 1100
                            }
                        },
                        output: {
                            format: { type: 'audio/pcmu' },
                            voice: VOICE
                        }
                    },
                    instructions: SYSTEM_MESSAGE
                }
            };

            openAiWs.send(JSON.stringify(sessionUpdate));

            openAiWs.send(JSON.stringify({
                type: 'conversation.item.create',
                item: {
                    type: 'message',
                    role: 'user',
                    content: [
                        {
                            type: 'input_text',
                            text: 'Start the call now with your exact Speedy Solutions opening line.'
                        }
                    ]
                }
            }));

            openAiWs.send(JSON.stringify({ type: 'response.create' }));
        };

        openAiWs.on('open', () => {
            console.log('Connected to OpenAI Realtime API');
            setTimeout(initializeSession, 100);
        });

        openAiWs.on('message', (data) => {
            try {
                const response = JSON.parse(data);

                if (LOG_EVENT_TYPES.includes(response.type)) {
                    console.log(`Received event: ${response.type}`, response);
                }

                if (response.type === 'response.output_audio.delta' && response.delta) {
                    connection.send(JSON.stringify({
                        event: 'media',
                        streamSid: streamSid,
                        media: { payload: response.delta }
                    }));
                }

                // No mid-sentence interruption. This prevents background noise from cutting Emma off.
            } catch (error) {
                console.error('Error processing OpenAI message:', error, 'Raw message:', data);
            }
        });

        connection.on('message', (message) => {
            try {
                const data = JSON.parse(message);

                switch (data.event) {
                    case 'media':
                        latestMediaTimestamp = data.media.timestamp;

                        if (openAiWs.readyState === WebSocket.OPEN) {
                            openAiWs.send(JSON.stringify({
                                type: 'input_audio_buffer.append',
                                audio: data.media.payload
                            }));
                        }
                        break;

                    case 'start':
                        streamSid = data.start.streamSid;
                        console.log('Incoming stream started', streamSid);
                        latestMediaTimestamp = 0;
                        break;

                    default:
                        break;
                }
            } catch (error) {
                console.error('Error parsing Twilio message:', error, 'Message:', message);
            }
        });

        connection.on('close', () => {
            if (openAiWs.readyState === WebSocket.OPEN) openAiWs.close();
            console.log('Client disconnected.');
        });

        openAiWs.on('error', (error) => {
            console.error('OpenAI WebSocket error:', error);
        });
    });
});

fastify.listen({ port: PORT, host: '0.0.0.0' }, (err) => {
    if (err) {
        console.error(err);
        process.exit(1);
    }

    console.log(`Server is listening on port ${PORT}`);
});
