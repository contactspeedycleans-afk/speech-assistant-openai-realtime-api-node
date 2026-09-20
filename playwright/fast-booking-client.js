const DEFAULT_FAST_BOOKING_URL =
  "https://lisa-fast-booking-test-production.up.railway.app/lisa/booking-action";

function required(value, name) {
  const normalized = String(value || "").trim();
  if (!normalized) throw new Error(`${name} is not configured`);
  return normalized;
}

async function postBookingAction(url, secret, payload, fetchImpl) {
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

  if (!response.ok || result?.success === false) {
    throw new Error(
      result?.error ||
        result?.message ||
        `Fast Booking returned HTTP ${response.status}`
    );
  }

  return result;
}

export async function createWithLisaFastBooking(
  payload,
  {
    fetchImpl = fetch,
    url = process.env.LISA_FAST_BOOKING_ACTION_URL || DEFAULT_FAST_BOOKING_URL,
    secret = process.env.LISA_FAST_BOOKING_SECRET || process.env.LISA_ACTION_SECRET
  } = {}
) {
  const endpoint = required(url, "LISA_FAST_BOOKING_ACTION_URL");
  const actionSecret = required(secret, "LISA_FAST_BOOKING_SECRET");

  // This is intentionally the same contract used by Lisa on live calls.
  // Fast Booking stages and saves with Octopus' unassigned placeholder; a
  // requested cleaner must be assigned after the verified BOK is created.
  const stagedPayload = {
    ...payload,
    action: "draft_fast",
    customerConfirmed: false,
    fieldworkerName: "Unassigned Tasks Manager",
    source: "OCTOPUS_ADMIN_BRIDGE_FAST",
    recurringFrequency: payload.recurringFrequency || "one_time",
    frequency: payload.frequency || "one_time"
  };

  const draft = await postBookingAction(
    endpoint,
    actionSecret,
    stagedPayload,
    fetchImpl
  );
  const draftId = String(draft?.draftId || "").trim();
  if (!draftId) throw new Error("Fast Booking did not return a draft ID");

  const result = await postBookingAction(
    endpoint,
    actionSecret,
    {
      action: "finalize_fast",
      draftId,
      customerConfirmed: true,
      specialNotes: payload.specialNotes || ".",
      accessInstructions: payload.accessInstructions || "."
    },
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

