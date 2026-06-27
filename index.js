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

You must speak English only. Never switch languages unless the caller specifically asks you to.

You answer like a calm, patient, professional front desk receptionist for a cleaning company.

Very important conversation rules:
- Do not interrupt the caller.
- Be patient with older callers.
- Allow callers extra time to finish speaking.
- If the caller pauses, wait before responding.
- Speak slowly, clearly, warmly, and naturally.
- Keep answers short, but not rushed.
- Do not sound robotic.
- Do not over-explain.
- Do not mention OpenAI, ChatGPT, Twilio, Railway, APIs, or technology unless directly asked.

Start the conversation by saying:
"Thank you for calling Speedy Solutions. This is Emma. How can I help you today?"

Speedy Solutions helps with:
- House cleaning
- Deep cleaning
- Move-in and move-out cleaning
- Recurring cleaning
- Office cleaning
- Organizing
- Junk removal
- Lawn care

If someone wants a quote or appointment, collect:
- Name
- Phone number
- Address
- Service needed
- Bedrooms
- Bathrooms
- Preferred date
- Preferred arrival time
- Pets
- Special requests

Do not promise exact pricing unless pricing is clearly provided.
Do not promise confirmed availability.
Say the office will review the request and follow up shortly.

If the caller is upset, be calm and reassuring.
If the caller asks something you do not know, say:
"Let me have the office review that and follow up with you shortly."

Your goal is to be helpful, patient, and professional.
`;

const VOICE = 'marin';
const TEMPERATURE = 0.55;
const PORT = process.env.PORT || 8080;

const LOG_EVENT_TYPES = [
    'error',
    'response.content.done',
    'rate_limits.updated',
    'response.done',
    'input_audio_buffer.committed',
    'input_audio_buffer.speech_stopped',
    'input_audio_buffer.speech_started',
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
        let lastAssistantItem = null;
        let markQueue = [];
        let responseStartTimestampTwilio = null;

        const openAiWs = new WebSocket(`wss://api.openai.com/v1/realtime?model=gpt-realtime&temperature=${TEMPERATURE}`, {
            headers: {
                Authorization: `Bearer ${OPENAI_API_KEY}`,
            }
        });

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
                                threshold: 0.95,
                                prefix_padding_ms: 700,
                                silence_duration_ms: 2200
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

            console.log('Sending session update:', JSON.stringify(sessionUpdate));
            openAiWs.send(JSON.stringify(sessionUpdate));

            const greeting = {
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
            };

            openAiWs.send(JSON.stringify(greeting));
            openAiWs.send(JSON.stringify({ type: 'response.create' }));
        };

        const handleSpeechStartedEvent = () => {
            // More patient interruption behavior:
            // Only clear Emma if the caller truly starts speaking while she is actively talking.
            if (markQueue.length > 2 && responseStartTimestampTwilio != null) {
                const elapsedTime = latestMediaTimestamp - responseStartTimestampTwilio;

                if (lastAssistantItem) {
                    const truncateEvent = {
                        type: 'conversation.item.truncate',
                        item_id: lastAssistantItem,
                        content_index: 0,
                        audio_end_ms: elapsedTime
                    };

                    openAiWs.send(JSON.stringify(truncateEvent));
                }

                connection.send(JSON.stringify({
                    event: 'clear',
                    streamSid: streamSid
                }));

                markQueue = [];
                lastAssistantItem = null;
                responseStartTimestampTwilio = null;
            }
        };

        const sendMark = (connection, streamSid) => {
            if (streamSid) {
                const markEvent = {
                    event: 'mark',
                    streamSid: streamSid,
                    mark: { name: 'responsePart' }
                };

                connection.send(JSON.stringify(markEvent));
                markQueue.push('responsePart');
            }
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
                    const audioDelta = {
                        event: 'media',
                        streamSid: streamSid,
                        media: { payload: response.delta }
                    };

                    connection.send(JSON.stringify(audioDelta));

                    if (!responseStartTimestampTwilio) {
                        responseStartTimestampTwilio = latestMediaTimestamp;
                    }

                    if (response.item_id) {
                        lastAssistantItem = response.item_id;
                    }

                    sendMark(connection, streamSid);
                }

                if (response.type === 'input_audio_buffer.speech_started') {
                    handleSpeechStartedEvent();
                }
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

                        responseStartTimestampTwilio = null;
                        latestMediaTimestamp = 0;
                        break;

                    case 'mark':
                        if (markQueue.length > 0) {
                            markQueue.shift();
                        }
                        break;

                    default:
                        console.log('Received non-media event:', data.event);
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

        openAiWs.on('close', () => {
            console.log('Disconnected from OpenAI Realtime API');
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
