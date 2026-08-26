import Fastify from 'fastify';
import WebSocket from 'ws';
import dotenv from 'dotenv';
import pg from 'pg';
import fastifyFormBody from '@fastify/formbody';
import fastifyWs from '@fastify/websocket';
import twilio from 'twilio';
import SYSTEM_MESSAGE from './prompts/systemMessage.js';
import SMS_SYSTEM_MESSAGE from './prompts/smsSystemMessage.js';
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
import { runSmsReceptionist } from './lib/smsReceptionist.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);


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
    handleRescheduleBookingTool,
    cancelBookingAction,
    rescheduleBookingAction
} = createOpenAiToolHandlers({
    searchCompanyKnowledge,
    recordTechnicianStatusUpdate,
    db
});

const smsToolHandlers = {
    handleTechnicianStatusTool,
    handleBillingLookupTool,
    handleCancelBookingTool,
    handleRescheduleBookingTool
};


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
// ============================================================
// LISA ASYNC BOOKING JOBS
// ============================================================
// The Playwright booking can take multiple minutes. Railway/proxies may close
// a single long HTTP request before Octopus finishes. Lisa now submits the
// create request quickly, receives a requestId, and polls this in-memory job
// store for the verified BOK result.
const lisaBookingJobs = new Map();
const LISA_BOOKING_JOB_TTL_MS = 30 * 60 * 1000;

function cleanLisaBookingJobs() {
    const cutoff = Date.now() - LISA_BOOKING_JOB_TTL_MS;

    for (const [requestId, job] of lisaBookingJobs.entries()) {
        if ((job.updatedAt || job.createdAt || 0) < cutoff) {
            lisaBookingJobs.delete(requestId);
        }
    }
}

function newLisaBookingRequestId() {
    return `lisa-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function verifyLisaSecret(request) {
    const configuredSecret = String(
        process.env.LISA_ACTION_SECRET || ''
    ).trim();

    const suppliedSecret = String(
        request.headers['x-lisa-secret'] || ''
    ).trim();

    return Boolean(
        configuredSecret &&
        suppliedSecret &&
        suppliedSecret === configuredSecret
    );
}

function validateLisaCreateBody(body) {
    if (body.customerConfirmed !== true) {
        return {
            success: false,
            outcome: 'confirmation_required',
            error: 'The customer must explicitly confirm the complete booking first.'
        };
    }

    const required = [
        ['customerName', body.customerName],
        ['streetNumber', body.streetNumber],
        ['street', body.street || body.streetAddress],
        ['city', body.city || body.suburb],
        ['state', body.state],
        ['zip', body.zip || body.postcode],
        ['requestedDate', body.requestedDate],
        ['requestedStartTime', body.requestedStartTime]
    ];

    const missing = required
        .filter(([, value]) => !String(value || '').trim())
        .map(([name]) => name);

    if (missing.length) {
        return {
            success: false,
            outcome: 'missing_booking_fields',
            error: `Missing required booking fields: ${missing.join(', ')}`
        };
    }

    return null;
}

async function deliverLisaBookingSuccessWebhook(body, result) {
    const bookingId = result.bookingId || result.booking_id || null;
    const bookingNumber = result.bookingNumber || result.booking_number || null;

    const successWebhookUrl = String(
        process.env.LISA_BOOKING_SUCCESS_WEBHOOK_URL || ''
    ).trim();

    if (!successWebhookUrl) {
        console.log(
            'LISA_BOOKING_SUCCESS_WEBHOOK_URL not configured; skipping success notification.'
        );
        return;
    }

    const successPayload = {
        event: 'LISA_BOOKING_CREATED',
        verified_created_in_octopus: true,
        bookingNumber,
        bookingId,
        customerName: body.customerName || '',
        customerPhone: body.customerPhone || body.phone || '',
        customerEmail: body.customerEmail || body.email || '',
        serviceAddress:
            body.serviceAddress ||
            [
                body.streetNumber,
                body.street || body.streetAddress,
                body.city || body.suburb,
                body.state,
                body.zip || body.postcode
            ]
                .filter(Boolean)
                .join(', '),
        streetNumber: body.streetNumber || '',
        street: body.street || body.streetAddress || '',
        city: body.city || body.suburb || '',
        state: body.state || '',
        zip: body.zip || body.postcode || '',
        requestedDate: body.requestedDate || '',
        requestedStartTime: body.requestedStartTime || '',
        arrivalWindow: body.arrivalWindow || '',
        durationMinutes:
            body.durationMinutes ||
            (Number(body.durationHours || 0) * 60 || ''),
        quotedPrice: body.quotedPrice || body.price || '',
        serviceType: body.serviceType || body.serviceName || '',
        recurringFrequency: body.recurringFrequency || '',
        source: 'LISA_VOICE',
        createdAt: new Date().toISOString()
    };

    try {
        const hookResponse = await fetch(successWebhookUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(successPayload),
            signal: AbortSignal.timeout(15000)
        });

        if (!hookResponse.ok) {
            console.error(
                'Lisa booking success webhook returned HTTP',
                hookResponse.status
            );
        } else {
            console.log(
                'Lisa booking success webhook delivered:',
                bookingNumber
            );
        }
    } catch (hookError) {
        console.error(
            'Lisa booking success webhook failed:',
            hookError?.message || hookError
        );
    }
}

async function executeLisaCreateBooking(body) {
    const validationError = validateLisaCreateBody(body);
    if (validationError) {
        return validationError;
    }

    const { stdout, stderr } = await execFileAsync(
        process.execPath,
        ['playwright/octopus-create-booking.js'],
        {
            cwd: process.cwd(),
            env: {
                ...process.env,
                LISA_BOOKING_PAYLOAD: JSON.stringify(body)
            },
            // Longer than Lisa's previous HTTP request. This is now safe because
            // it runs in the background instead of holding open the submit POST.
            timeout: 300000,
            maxBuffer: 10 * 1024 * 1024
        }
    );

    if (stderr) {
        console.log('Lisa direct booking stderr:', stderr);
    }

    console.log('Lisa direct booking stdout:', stdout);

    const marker = stdout
        .split(/\r?\n/)
        .find((line) => line.startsWith('LISA_BOOKING_RESULT='));

    if (!marker) {
        return {
            success: false,
            verified_created_in_octopus: false,
            outcome: 'playwright_booking_failed',
            error: 'Octopus booking automation did not return a verified BOK.'
        };
    }

    const result = JSON.parse(
        marker.substring('LISA_BOOKING_RESULT='.length)
    );

    const bookingId = result.bookingId || result.booking_id || null;
    const bookingNumber = result.bookingNumber || result.booking_number || null;
    const verified =
        result.success === true &&
        Boolean(bookingId && bookingNumber) &&
        String(bookingNumber).toUpperCase().startsWith('BOK-');

    if (!verified) {
        return {
            ...result,
            success: false,
            verified_created_in_octopus: false,
            bookingId,
            bookingNumber,
            outcome: result.outcome || 'verification_failed',
            error:
                result.error ||
                'OctopusPro did not return both a verified booking ID and BOK number.'
        };
    }

    const verifiedResult = {
        ...result,
        success: true,
        verified_created_in_octopus: true,
        bookingId,
        bookingNumber,
        outcome: 'created'
    };

    await deliverLisaBookingSuccessWebhook(body, verifiedResult);

    return verifiedResult;
}

async function runLisaBookingJob(requestId, body) {
    const job = lisaBookingJobs.get(requestId);
    if (!job) return;

    try {
        const result = await executeLisaCreateBooking(body);

        lisaBookingJobs.set(requestId, {
            ...job,
            status: result.success === true ? 'created' : 'failed',
            result,
            updatedAt: Date.now()
        });

        console.log(
            'Lisa async booking job finished:',
            requestId,
            result.bookingNumber || result.outcome || 'no-result'
        );
    } catch (error) {
        console.error(
            'Lisa async booking job failed:',
            requestId,
            error
        );

        lisaBookingJobs.set(requestId, {
            ...job,
            status: 'failed',
            result: {
                success: false,
                verified_created_in_octopus: false,
                outcome: 'automation_error',
                error: error?.message || 'Booking action failed.'
            },
            updatedAt: Date.now()
        });
    }
}

fastify.post(
    '/lisa/booking-action',
    async (request, reply) => {
        if (!verifyLisaSecret(request)) {
            return reply
                .code(401)
                .send({
                    success: false,
                    outcome: 'unauthorized',
                    error: 'Unauthorized.'
                });
        }

        const body =
            request.body && typeof request.body === 'object'
                ? request.body
                : {};

        const action = String(body.action || '')
            .trim()
            .toLowerCase();

        console.log('Lisa booking action request:', {
            action,
            bookingId: body.bookingId || null,
            asyncMode: body.asyncMode === true
        });

        try {
            if (action === 'cancel') {
                const result = await cancelBookingAction({
                    bookingId: body.bookingId,
                    cancellationReason: body.cancellationReason || 'Other',
                    customerConfirmed: body.customerConfirmed === true,
                    cancellationScope: body.cancellationScope || 'single_visit',
                    customerBookings: Array.isArray(body.customerBookings)
                        ? body.customerBookings
                        : []
                });

                return reply.send(result);
            }

            if (action === 'reschedule') {
                const result = await rescheduleBookingAction({
                    bookingId: body.bookingId,
                    requestedDate: body.requestedDate,
                    requestedStartTime: body.requestedStartTime,
                    customerConfirmed: body.customerConfirmed === true,
                    rescheduleScope: body.rescheduleScope || 'single_visit',
                    customerBookings: Array.isArray(body.customerBookings)
                        ? body.customerBookings
                        : []
                });

                return reply.send(result);
            }

            if (action === 'create') {
                const validationError = validateLisaCreateBody(body);
                if (validationError) {
                    return reply.send(validationError);
                }

                // New production-safe path used by Lisa voice.
                if (body.asyncMode === true) {
                    cleanLisaBookingJobs();

                    const requestId = newLisaBookingRequestId();
                    const now = Date.now();

                    lisaBookingJobs.set(requestId, {
                        requestId,
                        status: 'processing',
                        createdAt: now,
                        updatedAt: now,
                        result: null
                    });

                    // Deliberately do NOT await Playwright here.
                    setImmediate(() => {
                        runLisaBookingJob(requestId, { ...body }).catch((error) => {
                            console.error(
                                'Unexpected Lisa background booking error:',
                                requestId,
                                error
                            );
                        });
                    });

                    console.log(
                        'Lisa async booking accepted:',
                        requestId
                    );

                    return reply
                        .code(202)
                        .send({
                            accepted: true,
                            success: false,
                            verified_created_in_octopus: false,
                            status: 'processing',
                            outcome: 'processing',
                            requestId
                        });
                }

                // Backward-compatible synchronous path for existing PowerShell tests.
                const result = await executeLisaCreateBooking(body);
                return reply.send(result);
            }

            return reply
                .code(400)
                .send({
                    success: false,
                    outcome: 'unsupported_action',
                    error: 'Supported actions are create, cancel, and reschedule.'
                });
        } catch (error) {
            console.error(
                'Lisa booking-action endpoint failed:',
                error
            );

            return reply
                .code(500)
                .send({
                    success: false,
                    outcome: 'automation_error',
                    error: error?.message || 'Booking action failed.'
                });
        }
    }
);

fastify.get(
    '/lisa/booking-status/:requestId',
    async (request, reply) => {
        if (!verifyLisaSecret(request)) {
            return reply
                .code(401)
                .send({
                    success: false,
                    outcome: 'unauthorized',
                    error: 'Unauthorized.'
                });
        }

        cleanLisaBookingJobs();

        const requestId = String(
            request.params?.requestId || ''
        ).trim();

        const job = lisaBookingJobs.get(requestId);

        if (!job) {
            return reply
                .code(404)
                .send({
                    success: false,
                    verified_created_in_octopus: false,
                    status: 'unknown',
                    outcome: 'request_not_found',
                    requestId,
                    error: 'Booking request was not found or has expired.'
                });
        }

        if (job.status === 'processing') {
            return reply.send({
                accepted: true,
                success: false,
                verified_created_in_octopus: false,
                status: 'processing',
                outcome: 'processing',
                requestId
            });
        }

        return reply.send({
            requestId,
            status: job.status,
            ...(job.result || {})
        });
    }
);

const VOICE = 'marin';
const TEMPERATURE = 0.55;
const PORT = process.env.PORT || 8080;
const AI_CALL_COMPLETED_WEBHOOK_URL =
    process.env.AI_CALL_COMPLETED_WEBHOOK_URL ||
    'https://hook.us2.make.com/qthdxcyfrr5shx59z5gfhkuoigblw2i4';
const NEXT_DAY_CONFIRMATION_WEBHOOK_URL =
    process.env.NEXT_DAY_CONFIRMATION_WEBHOOK_URL ||
    AI_CALL_COMPLETED_WEBHOOK_URL;

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

function getDetroitDateKey(offsetDays = 0) {
    const shifted = new Date(Date.now() + (Number(offsetDays) || 0) * 86400000);
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/Detroit',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
    }).formatToParts(shifted);
    const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    return `${values.month}/${values.day}/${values.year}`;
}

function normalizeUsDateKey(value = '') {
    const text = String(value || '').trim();
    const match = text.match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})/);
    if (!match) return '';
    return `${match[1].padStart(2, '0')}/${match[2].padStart(2, '0')}/${match[3]}`;
}

function getConfirmationTiming(callPurpose = '', bookingDate = '') {
    const purpose = String(callPurpose || '').trim().toUpperCase();

    if (purpose === 'SAME_DAY_CONFIRMATION') {
        return { isConfirmation: true, dayWord: 'today', mode: 'same_day' };
    }

    if (purpose === 'NEXT_DAY_CONFIRMATION') {
        return { isConfirmation: true, dayWord: 'tomorrow', mode: 'next_day' };
    }

    // Safety net: if Make ever sends the wrong/missing purpose, use the actual
    // booking date when it clearly matches today or tomorrow in Detroit.
    const bookingDateKey = normalizeUsDateKey(bookingDate);
    if (bookingDateKey && bookingDateKey === getDetroitDateKey(0)) {
        return { isConfirmation: true, dayWord: 'today', mode: 'same_day_date_fallback' };
    }
    if (bookingDateKey && bookingDateKey === getDetroitDateKey(1)) {
        return { isConfirmation: true, dayWord: 'tomorrow', mode: 'next_day_date_fallback' };
    }

    return { isConfirmation: false, dayWord: '', mode: '' };
}

function buildConfirmationVoicemailMessage({ callPurpose = '', customerName = '', bookingDate = '' } = {}) {
    const timing = getConfirmationTiming(callPurpose, bookingDate);
    if (!timing.isConfirmation) return '';

    const firstName = String(customerName || '').trim().split(/\s+/)[0] || '';
    return `Hi${firstName ? ` ${firstName}` : ''}, this is Emma with SpeedyCleans. I was calling to confirm your cleaning ${timing.dayWord}. Please reply to our text or call us back at 517-777-8712 to confirm or cancel. Thank you!`;
}

fastify.post('/outbound-call', async (request, reply) => {
    const body = request.body || {};
    const phone = body.phone || body.customer_phone || '';
    const customer_name =
        body.customer_name || body.customerName || body.name || '';
    const sheet_row_number =
        body.sheet_row_number || body.sheetRowNumber || '';
    const call_purpose =
        body.call_purpose || body.callPurpose || '';
    const customer_email =
        body.customer_email || body.customerEmail || '';

    // Keep Angi/lead booking fields structured for the entire call. Previously
    // these values were flattened into customInstructions and disappeared from
    // the completion webhook, leaving Make without a usable booking address.
    const leadBookingData = {
        leadSource: body.lead_source || body.leadSource || '',
        serviceType:
            body.service_type || body.serviceType || body.service || body.cleaning_type || '',
        recurringFrequency:
            body.recurring_frequency || body.recurringFrequency || body.frequency || '',
        address: body.address || body.service_address || body.serviceAddress || '',
        streetNumber: body.street_number || body.streetNumber || '',
        street: body.street || body.street_address || body.streetAddress || '',
        city: body.city || body.suburb || '',
        state: body.state || '',
        zip: body.zip || body.postcode || body.postal_code || '',
        requestedDate: body.requested_date || body.requestedDate || body.booking_date || body.bookingDate || '',
        requestedStartTime:
            body.requested_start_time || body.requestedStartTime || body.requested_time || '',
        arrivalWindow: body.arrival_window || body.arrivalWindow || '',
        durationMinutes: body.duration_minutes || body.durationMinutes || ''
    };

    const suppliedInstructions =
        body.instructions || body.customInstructions || '';
    const knownLeadDetails = [
        body.lead_source && `Lead source: ${body.lead_source}`,
        body.service && `Requested service: ${body.service}`,
        body.cleaning_type && `Cleaning type: ${body.cleaning_type}`,
        body.frequency && `Frequency: ${body.frequency}`,
        body.current_frequency && `Existing service frequency: ${body.current_frequency}`,
        body.membership_status && `Membership status: ${body.membership_status}`,
        body.booking_number && `Existing booking number: ${body.booking_number}`,
        body.booking_date && `Existing booking date: ${body.booking_date}`,
        body.arrival_window && `Existing arrival window: ${body.arrival_window}`,
        body.customer_status && `Customer status: ${body.customer_status}`,
        body.address && `Service address: ${body.address}`,
        body.city && `City: ${body.city}`,
        body.state && `State: ${body.state}`,
        body.zip && `ZIP: ${body.zip}`,
        body.requested_date && `Requested date: ${body.requested_date}`,
        body.requested_time && `Requested time: ${body.requested_time}`,
        body.notes && `Lead notes: ${body.notes}`
    ].filter(Boolean);
    const instructions = [suppliedInstructions, ...knownLeadDetails]
        .filter(Boolean)
        .join('\n');

    if (!phone) {
        return reply.code(400).send({
            success: false,
            error: 'Phone number is required.'
        });
    }

    if (!process.env.TWILIO_PHONE_NUMBER) {
        return reply.code(500).send({
            success: false,
            error: 'TWILIO_PHONE_NUMBER is missing.'
        });
    }

    try {
      const answerUrl = new URL(
    'https://lisa-production-53d5.up.railway.app/'
);
        answerUrl.searchParams.set('phone', phone);
        answerUrl.searchParams.set('customer_name', customer_name);
        answerUrl.searchParams.set('instructions', instructions);
        answerUrl.searchParams.set('sheet_row_number', sheet_row_number);
        answerUrl.searchParams.set('call_purpose', call_purpose);
        answerUrl.searchParams.set('customer_email', customer_email);
        answerUrl.searchParams.set('lead_source', leadBookingData.leadSource);
        answerUrl.searchParams.set('service_type', leadBookingData.serviceType);
        answerUrl.searchParams.set('recurring_frequency', leadBookingData.recurringFrequency);
        answerUrl.searchParams.set('address', leadBookingData.address);
        answerUrl.searchParams.set('street_number', leadBookingData.streetNumber);
        answerUrl.searchParams.set('street', leadBookingData.street);
        answerUrl.searchParams.set('city', leadBookingData.city);
        answerUrl.searchParams.set('state', leadBookingData.state);
        answerUrl.searchParams.set('zip', leadBookingData.zip);
        answerUrl.searchParams.set('requested_date', leadBookingData.requestedDate);
        answerUrl.searchParams.set('requested_start_time', leadBookingData.requestedStartTime);
        answerUrl.searchParams.set('arrival_window', leadBookingData.arrivalWindow);
        answerUrl.searchParams.set('duration_minutes', leadBookingData.durationMinutes);

        console.log('Outbound Twilio answer route prepared:', {
            origin: answerUrl.origin,
            pathname: answerUrl.pathname,
            phone,
            customerName: customer_name,
            sheetRowNumber: sheet_row_number,
            callPurpose: call_purpose
        });

        const call = await twilioClient.calls.create({
            to: phone,
            from: process.env.TWILIO_PHONE_NUMBER,
            url: answerUrl.toString(),
            method: 'POST',
            record: true,
            recordingChannels: 'dual',
            machineDetection: 'DetectMessageEnd',
            machineDetectionTimeout: 30,
            machineDetectionSpeechThreshold: 2400,
            machineDetectionSpeechEndThreshold: 1200,
            machineDetectionSilenceTimeout: 5000
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
            sheet_row_number,
            customer_name,
            call_purpose
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

fastify.post('/sms-message', async (request, reply) => {
    const configuredSecret = process.env.SMS_WEBHOOK_SECRET || '';
    const suppliedSecret = String(request.headers['x-emma-secret'] || '');

    if (configuredSecret && suppliedSecret !== configuredSecret) {
        return reply.code(401).send({ success: false, error: 'Unauthorized.' });
    }

    const body = request.body || {};
    const customerPhone = String(body.from || body.From || '').trim();
    const twilioNumber = String(body.to || body.To || '').trim();
    const customerMessage = String(body.message || body.Body || '').trim();
    const messageSid = String(body.message_sid || body.MessageSid || '').trim();

    if (!customerPhone || !twilioNumber || !customerMessage) {
        return reply.code(400).send({
            success: false,
            error: 'from, to, and message are required.'
        });
    }

    const optOutWords = new Set([
        'stop', 'stopall', 'unsubscribe', 'cancel', 'end', 'quit'
    ]);
    if (optOutWords.has(customerMessage.toLowerCase())) {
        return reply.send({
            success: true,
            shouldReply: false,
            optedOut: true,
            customerPhone,
            twilioNumber,
            messageSid
        });
    }

    await db.query(`
        CREATE TABLE IF NOT EXISTS emma_sms_messages (
            id BIGSERIAL PRIMARY KEY,
            customer_phone TEXT NOT NULL,
            twilio_number TEXT NOT NULL,
            direction TEXT NOT NULL,
            message TEXT NOT NULL,
            message_sid TEXT,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    `);

    await db.query(
        `INSERT INTO emma_sms_messages
            (customer_phone, twilio_number, direction, message, message_sid)
         VALUES ($1, $2, 'inbound', $3, $4)`,
        [customerPhone, twilioNumber, customerMessage, messageSid || null]
    );

    const smsCustomer = await findCustomerByPhone(customerPhone);
    const technicianResult = await db.query(
        `SELECT *
         FROM public.technicians
         WHERE RIGHT(REGEXP_REPLACE(COALESCE(phone_number, ''), '[^0-9]', '', 'g'), 10)
             = RIGHT(REGEXP_REPLACE($1, '[^0-9]', '', 'g'), 10)
         ORDER BY id DESC
         LIMIT 1`,
        [customerPhone]
    );
    const smsTechnician = technicianResult.rows[0] || null;
    const customerName = [
        smsCustomer?.first_name,
        smsCustomer?.last_name
    ].filter(Boolean).join(' ').trim();

    const historyResult = await db.query(
        `SELECT direction, message
         FROM emma_sms_messages
         WHERE customer_phone = $1 AND twilio_number = $2
         ORDER BY created_at DESC, id DESC
         LIMIT 20`,
        [customerPhone, twilioNumber]
    );

    const history = historyResult.rows.reverse().map((row) => ({
        role: row.direction === 'outbound' ? 'assistant' : 'user',
        content: row.message
    }));

    const customerBookings = smsCustomer
        ? await findCustomerBookings(smsCustomer.id, customerPhone)
        : await findCustomerBookings(null, customerPhone);

    const smsResult = await runSmsReceptionist({
        openAiApiKey: OPENAI_API_KEY,
        model: process.env.SMS_OPENAI_MODEL || 'gpt-4.1-mini',
        systemMessage: SMS_SYSTEM_MESSAGE,
        history,
        customer: smsCustomer,
        technician: smsTechnician,
        customerBookings,
        customerPhone,
        searchCompanyKnowledge,
        handlers: smsToolHandlers
    });
    const smsReply = String(smsResult.reply || '').trim();

    if (!smsReply) {
        throw new Error('Emma generated an empty SMS reply.');
    }

    await db.query(
        `INSERT INTO emma_sms_messages
            (customer_phone, twilio_number, direction, message)
         VALUES ($1, $2, 'outbound', $3)`,
        [customerPhone, twilioNumber, smsReply]
    );

    return reply.send({
        success: true,
        shouldReply: true,
        customerPhone,
        customerName,
        senderRole: smsResult.identity?.role || 'unknown',
        senderName: smsResult.identity?.name || customerName,
        twilioNumber,
        incomingMessage: customerMessage,
        reply: smsReply,
        messageSid,
        receivedAt: new Date().toISOString(),
        action: smsResult.action,
        actionSuccess: smsResult.actionResult?.success === true,
        actionResult: smsResult.actionResult,
        futureBookings: smsResult.futureBookings
    });
});

// Recovery endpoint used by the Make.com "missing AI summary" scenario.
// It never places a call. It only recovers an existing Twilio recording by
// Call SID, transcribes it, and returns structured fields for the Sheet CRM.
fastify.post('/recover-outbound-call', async (request, reply) => {
    const callSid = String(
        request.body?.call_sid || request.body?.callSid || ''
    ).trim();

    if (!/^CA[0-9a-f]{32}$/i.test(callSid)) {
        return reply.code(400).send({
            success: false,
            retryable: false,
            error: 'A valid Twilio Call SID is required.'
        });
    }

    try {
        const call = await twilioClient.calls(callSid).fetch();
        const terminalStatuses = new Set([
            'completed',
            'busy',
            'failed',
            'no-answer',
            'canceled'
        ]);

        if (!terminalStatuses.has(call.status)) {
            return reply.code(202).send({
                success: false,
                retryable: true,
                call_sid: callSid,
                status: call.status,
                error: 'Call is not finished yet.'
            });
        }

        const recordings = await twilioClient.recordings.list({
            callSid,
            limit: 10
        });
        const recording = recordings
            .filter((item) => item.status === 'completed')
            .sort(
                (a, b) =>
                    new Date(b.dateCreated || 0) -
                    new Date(a.dateCreated || 0)
            )[0];

        if (!recording) {
            const noRecordingFinalStatuses = new Set([
                'busy',
                'failed',
                'no-answer',
                'canceled'
            ]);
            const endedAt = call.endTime || call.dateUpdated || null;
            const endedAgeMs = endedAt
                ? Date.now() - new Date(endedAt).getTime()
                : 0;
            const recordingGraceExpired =
                call.status === 'completed' &&
                endedAgeMs >= 10 * 60 * 1000;

            if (
                noRecordingFinalStatuses.has(call.status) ||
                recordingGraceExpired
            ) {
                const outcome =
                    call.status === 'no-answer'
                        ? 'no_answer'
                        : call.status === 'completed'
                            ? 'completed_no_recording'
                            : call.status.replace('-', '_');
                const summary =
                    call.status === 'completed'
                        ? 'Call completed, but no Twilio recording became available after the recovery window.'
                        : `No conversation recording was created. Twilio final status: ${call.status}.`;

                return reply.send({
                    success: true,
                    retryable: false,
                    call_sid: callSid,
                    recording_sid: '',
                    recording_url: '',
                    status: call.status,
                    transcript: summary,
                    summary,
                    outcome,
                    offer_accepted: 'No',
                    scheduled: 'No',
                    callback_requested: 'No',
                    followup_needed:
                        call.status === 'completed' ? 'Yes' : 'No',
                    sentiment: 'Unclear',
                    next_action:
                        call.status === 'completed'
                            ? 'Review missing Twilio recording'
                            : 'No conversation occurred',
                    completed_at: new Date().toISOString()
                });
            }

            return reply.code(202).send({
                success: false,
                retryable: true,
                call_sid: callSid,
                status: call.status,
                error: 'Twilio recording is not ready yet.'
            });
        }

        const recordingUrl =
            `https://api.twilio.com/2010-04-01/Accounts/` +
            `${process.env.TWILIO_ACCT_SID}/Recordings/${recording.sid}.mp3`;
        const audioResponse = await fetch(recordingUrl, {
            headers: {
                Authorization:
                    `Basic ${Buffer.from(
                        `${process.env.TWILIO_ACCT_SID}:` +
                        process.env.TWILIO_AUTH_TOKEN
                    ).toString('base64')}`
            }
        });

        if (!audioResponse.ok) {
            throw new Error(
                `Twilio recording download failed (${audioResponse.status}).`
            );
        }

        const audioBytes = await audioResponse.arrayBuffer();
        const transcriptionForm = new FormData();
        transcriptionForm.append(
            'file',
            new Blob([audioBytes], { type: 'audio/mpeg' }),
            `${recording.sid}.mp3`
        );
        transcriptionForm.append('model', 'gpt-4o-mini-transcribe');
        transcriptionForm.append('response_format', 'json');

        const transcriptionResponse = await fetch(
            'https://api.openai.com/v1/audio/transcriptions',
            {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${OPENAI_API_KEY}`
                },
                body: transcriptionForm
            }
        );

        if (!transcriptionResponse.ok) {
            throw new Error(
                `OpenAI transcription failed (${transcriptionResponse.status}): ` +
                (await transcriptionResponse.text()).slice(0, 500)
            );
        }

        const transcription = await transcriptionResponse.json();
        const transcript = String(transcription.text || '').trim();

        if (!transcript) {
            return reply.code(202).send({
                success: false,
                retryable: true,
                call_sid: callSid,
                status: call.status,
                error: 'The recording produced an empty transcript.'
            });
        }

        const summaryResponse = await fetch(
            'https://api.openai.com/v1/chat/completions',
            {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${OPENAI_API_KEY}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    model: 'gpt-4.1-mini',
                    temperature: 0.1,
                    response_format: { type: 'json_object' },
                    messages: [
                        {
                            role: 'system',
                            content:
                                'Analyze a Speedy Solutions outbound call. ' +
                                'Return JSON only with keys summary, outcome, ' +
                                'offer_accepted, scheduled, callback_requested, ' +
                                'followup_needed, sentiment, next_action. ' +
                                'Boolean fields must be Yes, No, or Unclear. ' +
                                'Outcome should be completed, follow_up, voicemail, ' +
                                'no_answer, not_interested, or unclear. Keep the ' +
                                'summary factual and under 45 words.'
                        },
                        {
                            role: 'user',
                            content: transcript
                        }
                    ]
                })
            }
        );

        if (!summaryResponse.ok) {
            throw new Error(
                `OpenAI summary failed (${summaryResponse.status}): ` +
                (await summaryResponse.text()).slice(0, 500)
            );
        }

        const summaryPayload = await summaryResponse.json();
        const analysis = JSON.parse(
            summaryPayload.choices?.[0]?.message?.content || '{}'
        );

        return reply.send({
            success: true,
            retryable: false,
            call_sid: callSid,
            recording_sid: recording.sid,
            recording_url: recordingUrl,
            status: call.status,
            transcript,
            summary: analysis.summary || transcript.slice(0, 500),
            outcome: analysis.outcome || 'unclear',
            offer_accepted: analysis.offer_accepted || 'Unclear',
            scheduled: analysis.scheduled || 'Unclear',
            callback_requested: analysis.callback_requested || 'Unclear',
            followup_needed: analysis.followup_needed || 'Unclear',
            sentiment: analysis.sentiment || 'Neutral',
            next_action: analysis.next_action || 'Review call',
            completed_at: new Date().toISOString()
        });
    } catch (error) {
        console.error('Outbound recovery failed:', callSid, error);
        return reply.code(500).send({
            success: false,
            retryable: true,
            call_sid: callSid,
            error: error?.message || 'Unable to recover outbound call.'
        });
    }
});

fastify.all('/outbound-custom-answer', async (request, reply) => {
    const phone =
        request.query?.phone ||
        request.body?.phone ||
        request.body?.To ||
        '';
    const customerName =
        request.query?.customer_name ||
        request.body?.customer_name ||
        '';
    const instructions =
        request.query?.instructions ||
        request.body?.instructions ||
        '';
    const sheetRowNumber =
        request.query?.sheet_row_number ||
        request.body?.sheet_row_number ||
        '';
    const callPurpose =
        request.query?.call_purpose ||
        request.body?.call_purpose ||
        '';
    const customerEmail =
        request.query?.customer_email ||
        request.body?.customer_email ||
        '';
    const leadBookingData = {
        leadSource:
            request.query?.lead_source || request.body?.lead_source || '',
        serviceType:
            request.query?.service_type || request.body?.service_type || '',
        recurringFrequency:
            request.query?.recurring_frequency || request.body?.recurring_frequency || '',
        address:
            request.query?.address || request.body?.address || '',
        streetNumber:
            request.query?.street_number || request.body?.street_number || '',
        street:
            request.query?.street || request.body?.street || '',
        city:
            request.query?.city || request.body?.city || '',
        state:
            request.query?.state || request.body?.state || '',
        zip:
            request.query?.zip || request.body?.zip || '',
        requestedDate:
            request.query?.requested_date || request.body?.requested_date || '',
        requestedStartTime:
            request.query?.requested_start_time || request.body?.requested_start_time || '',
        arrivalWindow:
            request.query?.arrival_window || request.body?.arrival_window || '',
        durationMinutes:
            request.query?.duration_minutes || request.body?.duration_minutes || ''
    };
    const answeredBy = String(
        request.body?.AnsweredBy ||
        request.query?.AnsweredBy ||
        'unknown'
    ).toLowerCase();

    console.log('Custom outbound answer route reached:', {
        answeredBy,
        phone,
        customerName,
        sheetRowNumber,
        callPurpose,
        method: request.method
    });

    const isVoicemail =
        answeredBy.startsWith('machine') ||
        answeredBy === 'fax';

    if (isVoicemail) {
        console.log('Leaving outbound voicemail and ending call:', {
            phone,
            customerName,
            answeredBy
        });

        const confirmationVoicemailMessage = buildConfirmationVoicemailMessage({
            callPurpose,
            customerName,
            bookingDate: leadBookingData.requestedDate
        });
        const voicemailMessage = confirmationVoicemailMessage ||
            `Hi${customerName ? ` ${String(customerName).split(/\s+/)[0]}` : ''}, this is Emma with SpeedyCleans following up about your cleaning request. Our Forever Clean members can get cleaning sessions starting at just $82.50. If you're interested, please call us back at 517-777-8712 or reply to our text. We look forward to helping you!`;

        const voicemailResponse = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Say>${escapeXml(voicemailMessage)}</Say>
    <Hangup/>
</Response>`;

        return reply.type('text/xml').send(voicemailResponse);
    }

    const twimlResponse = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Connect>
        <Stream url="wss://emma-development-production.up.railway.app/media-stream">
            <Parameter name="callerPhone" value="${escapeXml(phone)}" />
            <Parameter name="callMode" value="OUTBOUND_CUSTOM" />
            <Parameter name="customerName" value="${escapeXml(customerName)}" />
            <Parameter name="customInstructions" value="${escapeXml(instructions)}" />
            <Parameter name="sheetRowNumber" value="${escapeXml(sheetRowNumber)}" />
            <Parameter name="callPurpose" value="${escapeXml(callPurpose)}" />
            <Parameter name="customerEmail" value="${escapeXml(customerEmail)}" />
            <Parameter name="leadSource" value="${escapeXml(leadBookingData.leadSource)}" />
            <Parameter name="serviceType" value="${escapeXml(leadBookingData.serviceType)}" />
            <Parameter name="recurringFrequency" value="${escapeXml(leadBookingData.recurringFrequency)}" />
            <Parameter name="customerAddress" value="${escapeXml(leadBookingData.address)}" />
            <Parameter name="streetNumber" value="${escapeXml(leadBookingData.streetNumber)}" />
            <Parameter name="street" value="${escapeXml(leadBookingData.street)}" />
            <Parameter name="city" value="${escapeXml(leadBookingData.city)}" />
            <Parameter name="state" value="${escapeXml(leadBookingData.state)}" />
            <Parameter name="zip" value="${escapeXml(leadBookingData.zip)}" />
            <Parameter name="requestedDate" value="${escapeXml(leadBookingData.requestedDate)}" />
            <Parameter name="requestedStartTime" value="${escapeXml(leadBookingData.requestedStartTime)}" />
            <Parameter name="arrivalWindow" value="${escapeXml(leadBookingData.arrivalWindow)}" />
            <Parameter name="durationMinutes" value="${escapeXml(leadBookingData.durationMinutes)}" />
        </Stream>
    </Connect>
</Response>`;

    return reply.type('text/xml').send(twimlResponse);
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
let voicemailTakeoverStarted = false;
let lastAssistantTranscript = '';
let completedAssistantTranscripts = [];
let completedCustomerTranscripts = [];
            let completionWebhookSent = false;
            let completionWebhookSending = false;


            
let outboundCustomerName = '';
let customInstructions = '';
let sheetRowNumber = '';
let callPurpose = '';
let outboundCustomerEmail = '';
let outboundLeadSource = '';
let outboundServiceType = '';
let outboundRecurringFrequency = '';
let outboundCustomerAddress = '';
let outboundStreetNumber = '';
let outboundStreet = '';
let outboundCity = '';
let outboundState = '';
let outboundZip = '';
let outboundRequestedDate = '';
let outboundRequestedStartTime = '';
let outboundArrivalWindow = '';
let outboundDurationMinutes = '';

let customer = null;
let recentCalls = [];
let customerBookings = [];
let customerBookingCount = 0;
let openAiConnected = false;
let sessionStarted = false;
let sessionContextReady = false;
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
                    !sessionContextReady ||
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
    outboundLead: {
        address: outboundCustomerAddress,
        streetNumber: outboundStreetNumber,
        street: outboundStreet,
        city: outboundCity,
        state: outboundState,
        zip: outboundZip
    },
    customInstructions,
    callerPhone
});
              const {
    customerName,
    customerAddress,
    customerContext,
    recentCallContext,
    bookingContext,
    callModeContext,
    memoryFirstContext
} = sessionContext;

const sessionUpdate = buildOpenAiSession({
    SYSTEM_MESSAGE,
    VOICE,
    callMode,
    callModeContext,
    customerContext,
    recentCallContext,
    bookingContext,
    memoryFirstContext
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
3. Refer naturally to the known requested service or lead notes when available.
4. Ask only the single next missing question and stop to listen.

EXISTING-CUSTOMER OVERRIDE:
- If CUSTOMER DATABASE CONTEXT or BOOKING HISTORY shows an existing customer or booking, treat this as an account-service callÃ¢â‚¬â€not a new quote.
- Open with the specific reason for the call and the known appointment or recurring service details.
- Never ask one-time versus recurring when their existing frequency or appointment is already known.
- Never quote $150, pitch a first cleaning, or restart sales intake unless the customer explicitly asks to price or book a separate new cleaning.
- For an existing recurring client, refer to their saved recurring service as their current plan. Do not sell it back to them as though they are a new lead.
- If the purpose is confirming, rescheduling, cancelling, billing, follow-up, or checking an existing visit, stay entirely on that purpose.
- Ask only what is required to complete the stated purpose, using all saved customer, call, and booking facts first.

- Never quote a price before frequency is known.
- If frequency is unknown, ask whether they want one-time or recurring service and stop.
- If the requested service is a one-time cleaning, say: "One-time cleaning starts at $150 for the first two hours with one cleaner."
- If the requested service is recurring cleaning, give only the price for the requested frequency.
- If service type is unclear after frequency is known, ask one short clarification question and stop.
- Never use the $150 one-time price as a generic cleaning quote or comparison for a recurring lead.
- Weekly starts at $112.50, biweekly starts at $120, and monthly starts at $127.50.
- Any mention of recurring service is a mandatory Forever Clean trigger. Explain the $250 annual membership, 45% discount, and typical $82.50 two-hour cleaning, plus the applicable non-member recurring price, before scheduling.
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

"Wonderful. YouÃ¢â‚¬â„¢re all set. Thank you for choosing Speedy Solutions. We look forward to helping you."

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

If they choose recurring, you must mention Forever Clean before scheduling: the membership is $250 per year, gives 45% off cleaning for a full year, and makes a typical two-hour cleaning $82.50. Also give the matching non-member rate: weekly $112.50, every two weeks $120, or monthly $127.50 for two hours.

If they choose one-time, normally mention the Forever Clean try-before-you-buy option once: they may try the $150 two-hour cleaning, upgrade before the end of that session if they love it, or simply keep it as a one-time cleaning.

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

After giving the applicable starting price, mention Forever Clean once on most cleaning sales calls, including one-time inquiries. Explain that it gives 45% off cleaning for one full year and that a one-time customer can upgrade before the end of the first session or keep the visit one-time. Then move confidently to their preferred date and arrival window.

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


       : (customer || customerBookings.length > 0)
        ? `Begin the inbound returning-customer call now.

Say:

"Thank you for calling SpeedyCleans. This is Emma. How can I help you today?"

HUMAN-TRANSFER POLICY Ã¢â‚¬â€ FOLLOW EXACTLY:

- Do not transfer the caller to a receptionist, manager, owner, dispatcher, technician, office worker, or any specifically requested person.
- Do not claim that you are transferring the call.
- Do not place the caller on hold for a person.
- You are Emma, SpeedyCleans' 24/7 AI receptionist and primary inbound call takerâ€”not a basic bot, phone menu, or transfer operator.
- You can handle real work, including quotes, scheduling, service questions, appointment updates, billing questions, customer requests, complaints, and technician messages.
- Make one confident attempt to explain the advantage of immediate AI assistance. If the caller still wants a human, stop persuading and take a complete callback message.

If the caller asks for a receptionist, representative, human, manager, owner, office staff, or transfer, say:

"I'm Emma, SpeedyCleans' 24/7 AI receptionist. This isn't a basic bot or a transfer lineâ€”I'm built to actually handle things right here, including quotes, scheduling, service questions, appointment updates, billing questions, and customer requests. I'm continuously upgraded with our latest information and tools, so I can often help faster than waiting for a traditional receptionist. Tell me what you need, and let's take care of it now."

Then ask:

"What can I help you with today?"

If the caller still requests a human, refuses AI assistance, or sounds frustrated, do not continue debating. Say:

"Absolutely. There isn't a live human transfer on this line, but I can take a complete message right now and a human team member will call you back as soon as possible. I'll make sure they have the details so you don't have to start over. May I start with your name?"

In callback message mode, collect or confirm one item at a time:
- Their name
- Their callback number
- The exact reason for the call
- The exact question, requested action, or outcome they need
- Any relevant service address, appointment date, or booking number
- Any urgency, deadline, or preferred callback time

Use saved customer information instead of making them repeat it. Read back the important details once and ask whether anything else should be included.

When complete, say: "Perfect. I have your message and callback number. A human team member will call you back as soon as possible."

Never promise an exact callback time. Never claim a human is currently available, that the caller is in a live queue, or that a transfer is occurring.
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
"Perfect. Our best value is Forever Clean. It's $250 for the year and gives you 45% off cleaning for a full year, bringing a typical two-hour cleaning down to just $82.50. Without a membership, monthly cleaning starts at $127.50 for two hours. Forever Clean is our best deal by far."

Customer:
"Biweekly."

Emma:
"Perfect. Our best value is Forever Clean. It's $250 for the year and gives you 45% off cleaning for a full year, bringing a typical two-hour cleaning down to just $82.50. Without a membership, every-two-week cleaning starts at $120 for two hours, and she brings all professional cleaning supplies and equipment."

Customer:
"Weekly."

Emma:
"Great. Our best value is Forever Clean. It's $250 for the year and gives you 45% off cleaning for a full year, bringing a typical two-hour cleaning down to just $82.50. Without a membership, weekly cleaning starts at $112.50 for two hours, and she brings all professional cleaning supplies and equipment."

After giving the applicable price, immediately continue with scheduling.

Do NOT explain the weekly, biweekly, and monthly options unless the customer asks.

Only compare multiple recurring plans if the customer says something like:

Ã¢â‚¬Â¢ "What are my options?"
Ã¢â‚¬Â¢ "How much are they?"
Ã¢â‚¬Â¢ "What's cheaper?"

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

Mention Forever Clean naturally once during most genuine cleaning sales and quote calls, including one-time cleaning inquiries.

For a one-time customer, present the $150 two-hour cleaning as a try-before-you-buy option: they can upgrade to Forever Clean before the session ends if they love it, or keep the visit as a one-time cleaning.

Say:

"Our best rate is through Forever Clean. The membership is $250 for the year and gives you 45% off cleaning for a full year. A typical two-hour cleaning drops from $150 to $82.50, and you can use the membership at any address, any time, with no minimum or maximum number of cleanings."

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

"Perfect! Our best value is Forever Clean. It's $250 for the year and gives you 45% off cleaning for a full year, bringing a typical two-hour cleaning down to just $82.50. Without a membership, monthly cleaning starts at $127.50 for two hours, and she brings all professional cleaning supplies and equipment. Did you have an ideal day and time for your cleaning, or were you looking for service right away?"

If they say biweekly, every two weeks, or every other week, say:

"Perfect! Our best value is Forever Clean. It's $250 for the year and gives you 45% off cleaning for a full year, bringing a typical two-hour cleaning down to just $82.50. Without a membership, every-two-week cleaning starts at $120 for two hours, and she brings all professional cleaning supplies and equipment. Did you have an ideal day and time for your cleaning, or were you looking for service right away?"

If they say weekly, say:

"Great! Our best value is Forever Clean. It's $250 for the year and gives you 45% off cleaning for a full year, bringing a typical two-hour cleaning down to just $82.50. Without a membership, weekly cleaning starts at $112.50 for two hours, and she brings all professional cleaning supplies and equipment. Did you have an ideal day and time for your cleaning, or were you looking for service right away?"
If they only say recurring, ask:

"Absolutely. Our best recurring value is Forever Clean. It's $250 for the year and gives you 45% off cleaning for a full year, bringing a typical two-hour cleaning down to just $82.50. Without a membership, two-hour recurring cleaning starts at $112.50 weekly, $120 every two weeks, or $127.50 monthly. Which schedule sounds best for you?"

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
                'No customer speech detected. Starting outbound greeting immediately.'
            );
        }
    }, 75);
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
    }, 1500);
};

const soundsLikeVoicemailSystem = (transcript) => {
    if (!callMode.startsWith('OUTBOUND')) {
        return false;
    }

    const text = String(transcript || '').toLowerCase();
    const strongPhrases = [
        'please leave a message',
        'leave your message',
        'leave a message after',
        'record your message',
        'after the tone',
        'after the beep',
        'at the tone',
        'has been forwarded to voicemail',
        'your call has been forwarded',
        'cannot take your call',
        "can't take your call",
        'is not available',
        'the person you are calling',
        'google voice subscriber',
        'voice mailbox',
        'press the pound key',
        'when you are finished recording'
    ];

    if (strongPhrases.some((phrase) => text.includes(phrase))) {
        return true;
    }

    return (
        (text.includes('mailbox') &&
            (text.includes('message') ||
                text.includes('tone') ||
                text.includes('full'))) ||
        (text.includes('you have reached') &&
            (text.includes('voicemail') || text.includes('mailbox')))
    );
};

const takeOverVoicemailCall = async (transcript) => {
    if (
        voicemailTakeoverStarted ||
        !callSid ||
        !callMode.startsWith('OUTBOUND')
    ) {
        return;
    }

    voicemailTakeoverStarted = true;
    console.log(
        'Voicemail system detected from incoming audio. Taking over call:',
        callSid,
        transcript
    );

    try {
        if (openAiWs.readyState === WebSocket.OPEN) {
            openAiWs.send(JSON.stringify({ type: 'response.cancel' }));
        }

        const confirmationVoicemailMessage = buildConfirmationVoicemailMessage({
            callPurpose,
            customerName: outboundCustomerName,
            bookingDate: outboundRequestedDate
        });
        const fallbackVoicemailMessage = 'Hi, this is Emma with Speedy Solutions calling about your Angi request. Please call us back at 5 1 7, 7 7 7, 8 7 1 2. Thank you.';
        const voicemailTwiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Say voice="alice">${escapeXml(confirmationVoicemailMessage || fallbackVoicemailMessage)}</Say>
    <Hangup/>
</Response>`;

        await twilioClient.calls(callSid).update({
            twiml: voicemailTwiml
        });

        console.log('Short voicemail started; OpenAI stream stopped:', callSid);
        await sendOutboundCompletion('voicemail');
    } catch (error) {
        console.error('Voicemail takeover failed:', error);
        voicemailTakeoverStarted = false;
        scheduleVoicemailHangup();
    }
};

const classifyOutboundCall = ({ status, customerText, assistantText }) => {
    const customer = String(customerText || '').toLowerCase();
    const assistant = String(assistantText || '').toLowerCase();
    const combined = `${customer}\n${assistant}`;

    if (status === 'voicemail') return 'voicemail';
    if (!customer.trim()) return 'failed';

    if (/not interested|stop calling|remove me|do not call|don't call/.test(customer)) {
        return 'not_interested';
    }

    if (/call me (back )?(later|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday)|need to think|think about it|talk to my|check with my/.test(customer)) {
        return 'follow_up';
    }

    const customerAccepted =
        /yes|that works|sounds good|go ahead|book it|schedule it|let's do it|lets do it/.test(customer);
    const assistantConfirmed =
        /you(?:'re| are) (?:booked|scheduled|all set)|appointment (?:is|has been) (?:booked|scheduled|confirmed)|i have you scheduled/.test(assistant);

    if (customerAccepted && assistantConfirmed) return 'booked';
    if (/follow.?up|call back|callback/.test(combined)) return 'follow_up';
    return 'completed';
};

const scoreOutboundCall = ({ customerText, assistantText, outcome }) => {
    const customer = String(customerText || '');
    const assistant = String(assistantText || '');
    const lowerAssistant = assistant.toLowerCase();
    const flags = [];
    let score = 100;

    if (!customer.trim()) {
        score -= 50;
        flags.push('no_customer_conversation');
    }

    const schedulingQuestions =
        lowerAssistant.match(/what day|what date|what time|day and time/g) || [];
    if (schedulingQuestions.length > 1) {
        score -= 20;
        flags.push('repeated_scheduling_question');
    }

    const identityQuestions =
        lowerAssistant.match(/full name|email address|phone number/g) || [];
    if (identityQuestions.length > 2) {
        score -= 15;
        flags.push('repeated_identity_question');
    }

    if (outcome === 'completed' && !/what day|which day|arrival window|schedule|book/.test(lowerAssistant)) {
        score -= 10;
        flags.push('no_booking_close_detected');
    }

    return {
        score: Math.max(0, score),
        flags
    };
};

        const sendOutboundCompletion = async (status = 'completed') => {
    if (
        completionWebhookSent ||
        completionWebhookSending ||
        !callMode.startsWith('OUTBOUND') ||
        !sheetRowNumber
    ) {
        return;
    }

    completionWebhookSending = true;

    try {
      const customerTranscript =
        completedCustomerTranscripts.join('\n');
      const assistantTranscript =
        completedAssistantTranscripts.join('\n');
      const transcript =
`CUSTOMER:
${customerTranscript}

EMMA:
${assistantTranscript}`;

      const outcome = classifyOutboundCall({
          status,
          customerText: customerTranscript,
          assistantText: assistantTranscript
      });
      const quality = scoreOutboundCall({
          customerText: customerTranscript,
          assistantText: assistantTranscript,
          outcome
      });

      const lowerCustomer = customerTranscript.toLowerCase();
      const lowerAssistantForResult = assistantTranscript.toLowerCase();
      const confirmationTiming = getConfirmationTiming(callPurpose, outboundRequestedDate);
      const confirmationResult = confirmationTiming.isConfirmation
          ? {
              answered: customerTranscript.trim().length > 0,
              confirmationStatus: /\b(cancel|cancelled|canceled|do not want|don't want|cannot make|can't make)\b/.test(lowerCustomer)
                  ? 'cancel_requested'
                  : /\b(yes|yeah|yep|correct|confirm|confirmed|still works|that works|sounds good|okay|ok)\b/.test(lowerCustomer)
                      ? 'confirmed'
                      : customerTranscript.trim().length > 0
                          ? 'unclear'
                          : 'no_answer',
              securePhonePaymentRequested: /\b(card|credit card|debit card|pay by phone|over the phone)\b/.test(lowerCustomer),
              formDeliveryRequested: /\b(text|email|link|form)\b/.test(lowerCustomer),
              cancellationVerified: /\b(cancelled|canceled)\b/.test(lowerAssistantForResult) &&
                  !/\b(could not|couldn't|unable|not cancelled|not canceled|staff review|office.*review)\b/.test(lowerAssistantForResult)
          }
          : null;

const completionPayload = {
    callSid,
    sheetRowNumber,
    status,
    transcript,
    summary: transcript,
    outcome,
    qualityScore: quality.score,
    qualityFlags: quality.flags,
    customerTranscript,
    assistantTranscript,
    callPurpose,
    customerPhone: callerPhone,
    customerEmail: outboundCustomerEmail,
    customerName: outboundCustomerName || [customer?.first_name, customer?.last_name].filter(Boolean).join(' '),
    leadSource: outboundLeadSource,
    serviceType: outboundServiceType,
    recurringFrequency: outboundRecurringFrequency,
    address: outboundCustomerAddress || customer?.address || '',
    streetNumber: outboundStreetNumber || customer?.street_number || '',
    street: outboundStreet || customer?.street || customer?.street_address || '',
    city: outboundCity || customer?.city || customer?.suburb || '',
    state: outboundState || customer?.state || '',
    zip: outboundZip || customer?.zip || customer?.postcode || '',
    requestedDate: outboundRequestedDate,
    requestedStartTime: outboundRequestedStartTime,
    arrivalWindow: outboundArrivalWindow,
    durationMinutes: outboundDurationMinutes,
    ...(confirmationResult || {})
};

const retryDelaysMs = [0, 1500, 3000, 6000, 12000, 24000];
let lastWebhookError = null;

for (let attempt = 0; attempt < retryDelaysMs.length; attempt += 1) {
    const delayMs = retryDelaysMs[attempt];
    if (delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
    }

    try {
        const completionWebhookUrl = confirmationTiming.isConfirmation
            ? NEXT_DAY_CONFIRMATION_WEBHOOK_URL
            : AI_CALL_COMPLETED_WEBHOOK_URL;
        const webhookResponse = await fetch(
            completionWebhookUrl,
            {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(completionPayload),
                signal: AbortSignal.timeout(15000)
            }
        );

        if (!webhookResponse.ok) {
            throw new Error(
                `Completion webhook returned HTTP ${webhookResponse.status}.`
            );
        }

        completionWebhookSent = true;
        lastWebhookError = null;

        console.log(
            'Outbound completion webhook delivered:',
            sheetRowNumber,
            `attempt ${attempt + 1}`
        );
        break;
    } catch (error) {
        lastWebhookError = error;
        console.error(
            'Outbound completion webhook attempt failed:',
            sheetRowNumber,
            `attempt ${attempt + 1}`,
            error?.message || error
        );
    }
}

if (!completionWebhookSent) {
    throw lastWebhookError || new Error(
        'Completion webhook failed after all retry attempts.'
    );
}

        console.log(
            'Outbound completion webhook sent:',
            sheetRowNumber,
            outcome,
            quality.score,
            quality.flags
        );
    } catch (error) {
        console.error(
            'Outbound completion webhook failed:',
            error
        );
    } finally {
        completionWebhookSending = false;
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

        if (soundsLikeVoicemailSystem(customerTranscript)) {
            await takeOverVoicemailCall(customerTranscript);
            return;
        }
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
    'have a great day',
    'talk soon',
    'talk to you soon',
    'goodbye',
    'bye for now'
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
                        
const toolsThatMayTakeTime = new Set([
    'search_company_knowledge',
    'record_technician_status_update',
    'lookup_octopus_billing',
    'cancel_octopus_booking',
    'reschedule_octopus_booking'
]);

const shouldUseHoldMusic =
    response.type === 'response.function_call_arguments.done' &&
    toolsThatMayTakeTime.has(response.name);

if (shouldUseHoldMusic) startHoldMusic();

try {
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
                    callerPhone,
                    customerBookings
                });

            if (!billingHandled) {
                const cancellationHandled =
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
            }
        }
    }
} finally {
    if (shouldUseHoldMusic) stopHoldMusic();
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
callPurpose = customParameters.callPurpose || '';
outboundCustomerEmail = customParameters.customerEmail || '';
outboundLeadSource = customParameters.leadSource || '';
outboundServiceType = customParameters.serviceType || '';
outboundRecurringFrequency = customParameters.recurringFrequency || '';
outboundCustomerAddress = customParameters.customerAddress || '';
outboundStreetNumber = customParameters.streetNumber || '';
outboundStreet = customParameters.street || '';
outboundCity = customParameters.city || '';
outboundState = customParameters.state || '';
outboundZip = customParameters.zip || '';
outboundRequestedDate = customParameters.requestedDate || '';
outboundRequestedStartTime = customParameters.requestedStartTime || '';
outboundArrivalWindow = customParameters.arrivalWindow || '';
outboundDurationMinutes = customParameters.durationMinutes || '';
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

customerBookings =
    await findCustomerBookings(
        customer?.id || null,
        callerPhone
    );
customerBookingCount = customerBookings.length;

console.log(
    'Future bookings found:',
    customerBookingCount
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
                                customerBookings = [];
                                customerBookingCount = 0;
                            }

                            sessionContextReady = true;
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
