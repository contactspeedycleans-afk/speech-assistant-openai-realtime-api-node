export function createTwilioRecording(twilioClient) {
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

    return {
        startCallRecording
    };
}
