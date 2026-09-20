const DEFAULT_FAST_BOOKING_URL =
  "https://lisa-fast-booking-test-production.up.railway.app/lisa/booking-action";

function required(value, name) {
  const normalized = String(value || "").trim();
  if (!normalized) throw new Error(`${name} is not configured`);
  return normalized;
}

async function postBookingAction(
  url,
  secret,
  payload,
  fetchImpl,
  { allowUnsuccessful = false } = {}
) {
  const response = await fetchImpl(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-lisa-secret": secret
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(180000)
  });

  const text = await response.text();
  let result;
  try {
    result = JSON.parse(text);
  } catch {
    throw new Error(
      `Fast Booking returned HTTP ${response.status} with invalid JSON`
    );
  }

  if (!response.ok || (!allowUnsuccessful && result?.success === false)) {
    throw new Error(
      result?.error ||
        result?.message ||
        `Fast Booking returned HTTP ${response.status}`
    );
  }

  return result;
}

function connectionOptions({
  fetchImpl = fetch,
  url = process.env.LISA_FAST_BOOKING_ACTION_URL || DEFAULT_FAST_BOOKING_URL,
  secret = process.env.LISA_FAST_BOOKING_SECRET || process.env.LISA_ACTION_SECRET
} = {}) {
  return {
    fetchImpl,
    endpoint: required(url, "LISA_FAST_BOOKING_ACTION_URL"),
    actionSecret: required(secret, "LISA_FAST_BOOKING_SECRET")
  };
}

export async function searchWithLisaFastBooking(payload, options = {}) {
  const { fetchImpl, endpoint, actionSecret } = connectionOptions(options);
  return postBookingAction(
    endpoint,
    actionSecret,
    { ...payload, action: "lookup" },
    fetchImpl
  );
}

export async function lookupAddressWithLisaFastBooking(payload, options = {}) {
  const { fetchImpl, endpoint, actionSecret } = connectionOptions(options);
  return postBookingAction(
    endpoint,
    actionSecret,
    { ...payload, action: "lookup_address" },
    fetchImpl,
    { allowUnsuccessful: true }
  );
}

export async function createWithLisaFastBooking(
  payload,
  {
    fetchImpl = fetch,
    url = process.env.LISA_FAST_BOOKING_ACTION_URL || DEFAULT_FAST_BOOKING_URL,
    secret = process.env.LISA_FAST_BOOKING_SECRET || process.env.LISA_ACTION_SECRET
  } = {}
) {
  const { endpoint, actionSecret } = connectionOptions({ fetchImpl, url, secret });

  // The admin tool runs after the complete booking has been confirmed, so use
  // Fast Booking's single-pass action instead of another draft/finalize round trip.
  const confirmedPayload = {
    ...payload,
    action: "create_fast",
    customerConfirmed: true,
    fieldworkerName: "Unassigned Tasks Manager",
    source: "OCTOPUS_ADMIN_BRIDGE_FAST",
    recurringFrequency: payload.recurringFrequency || "one_time",
    frequency: payload.frequency || "one_time"
  };

  const result = await postBookingAction(
    endpoint,
    actionSecret,
    confirmedPayload,
    fetchImpl
  );

  const bookingId = result?.bookingId || result?.booking_id || null;
  const bookingNumber = result?.bookingNumber || result?.booking_number || null;
  if (
    result?.success !== true ||
    !bookingId ||
    !/^BOK-/i.test(String(bookingNumber || ""))
  ) {
    throw new Error(
      result?.error || "Fast Booking did not return a verified Octopus BOK"
    );
  }

  return {
    ...result,
    success: true,
    verified_created_in_octopus: true,
    bookingId,
    bookingNumber,
    createdVia: "lisa_fast_booking",
    fieldworkerAssignment: "Unassigned Tasks Manager"
  };
}
