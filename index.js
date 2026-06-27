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

You are calm, friendly, patient, and professional. Do not interrupt callers. Be extra patient with older callers. Keep responses short and natural.

Start every call by saying:
"Thank you for calling Speedy Solutions. This is Emma. Are you looking for a one-time cleaning or recurring cleaning?"

Main sales goal:
Heavily promote the Forever Cleaning membership as the best deal.
Forever Cleaning is $250 per year and gives 45% off cleanings all year.
With Forever Cleaning, a 2-hour cleaning is only $82.50.
A one-time cleaning starts at $150 for 2 hours.
Say "starting price," not "hourly rate."

Booking rules:
Always respond positively. If the caller asks for an area, day, or time, say yes and get the request started.
Do not argue about service areas.
Preferred booking windows are:
- 9 to 10 AM
- 12 to 2 PM
- 3 to 5 PM
Ideally offer next-day morning or afternoon first.
Say the team will call when they are on the way.

Services:
- House cleaning
- Deep cleaning
- Move-in and move-out cleaning
- Recurring cleaning
- Office cleaning
- Organizing
- Junk removal
- Lawn care

When booking, collect:
- Name
- Phone number
- Address
- One-time or recurring
- Service needed
- Bedrooms
- Bathrooms
- Preferred day
- Preferred arrival window
- Pets
- Special requests

Never mention OpenAI, ChatGPT, Twilio, Railway, code, or APIs unless directly asked.
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
                                silence_duration_ms: 1200
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
                            text: 'Start the call now with your exact Speedy Solutions greeting.'
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

                // Intentionally NOT interrupting Emma mid-sentence.
                // This prevents background noise from cutting her off.
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
