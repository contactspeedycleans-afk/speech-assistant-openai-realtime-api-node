export function createTwilioRecording(twilioClient) {
    async function startCallRecording(callSid) {
        if (!callSid) {
            console.error(
                'Recording not started: CallSid is missing.'
            );
            return;
        }

        try {
            const recordingOptions = {
                recordingChannels: 'dual'
            };

            // A callback is useful for downstream processing, but it should
            // never be required just to record the call itself.
            if (process.env.TWILIO_RECORDING_CALLBACK_URL) {
                recordingOptions.recordingStatusCallback =
                    process.env.TWILIO_RECORDING_CALLBACK_URL;
                recordingOptions.recordingStatusCallbackMethod = 'POST';
            }

            await twilioClient
                .calls(callSid)
                .recordings.create(recordingOptions);

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

    return {
        startCallRecording
    };
}
