import test from 'node:test';
import assert from 'node:assert/strict';
import { buildOpenAiSession } from '../lib/openAiSessionBuilder.js';

function session(callMode = 'INBOUND_LEAD') {
    return buildOpenAiSession({
        SYSTEM_MESSAGE: 'Base receptionist instructions.',
        VOICE: 'marin',
        callMode,
        callModeContext: '',
        customerContext: '',
        recentCallContext: '',
        bookingContext: ''
    });
}

test('detects quiet short telephone replies at the normal VAD threshold', () => {
    const update = session();
    assert.equal(update.session.audio.input.turn_detection.threshold, 0.5);
    assert.equal(update.session.audio.input.turn_detection.type, 'server_vad');
});

test('guides transcription toward short English appointment times', () => {
    const transcription = session().session.audio.input.transcription;
    assert.equal(transcription.language, 'en');
    assert.match(transcription.prompt, /10 AM/);
    assert.match(transcription.prompt, /short scheduling answers/i);
});

test('requires acknowledging and confirming short time answers', () => {
    const instructions = session().session.instructions;
    assert.match(instructions, /SHORT SCHEDULING ANSWERS/);
    assert.match(instructions, /Ten AM, correct\?/);
    assert.match(instructions, /Do not ask them to repeat the entire answer/);
});
