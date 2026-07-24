export function buildSessionContext({
    customer,
    recentCalls = [],
    customerBookings = [],
    callMode = 'INBOUND_LEAD',
    outboundCustomerName = '',
    customInstructions = '',
    callerPhone = ''
}) {
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

    return {
        customerName,
        customerAddress,
        customerContext,
        recentCallContext,
        bookingContext,
        callModeContext
    };
}
