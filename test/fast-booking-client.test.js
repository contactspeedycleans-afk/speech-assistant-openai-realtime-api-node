import test from "node:test";
import assert from "node:assert/strict";
import { createWithLisaFastBooking } from "../playwright/fast-booking-client.js";

test("uses Lisa's draft/finalize path and forces unassigned creation", async () => {
  const requests = [];
  const fetchImpl = async (_url, options) => {
    const request = JSON.parse(options.body);
    requests.push(request);
    const body =
      requests.length === 1
        ? { success: true, draftId: "draft-1" }
        : {
            success: true,
            bookingId: "12345",
            bookingNumber: "BOK-12345"
          };
    return new Response(JSON.stringify(body), { status: 200 });
  };

  const result = await createWithLisaFastBooking(
    {
      customerName: "Test Customer",
      fieldworkerName: "Monica",
      specialNotes: "Test notes"
    },
    { fetchImpl, url: "https://example.test/lisa/booking-action", secret: "x" }
  );

  assert.equal(requests.length, 2);
  assert.equal(requests[0].action, "draft_fast");
  assert.equal(requests[0].fieldworkerName, "Unassigned Tasks Manager");
  assert.equal(requests[1].action, "finalize_fast");
  assert.equal(requests[1].draftId, "draft-1");
  assert.equal(result.bookingNumber, "BOK-12345");
  assert.equal(result.fieldworkerAssignment, "Unassigned Tasks Manager");
});

test("fails closed when Fast Booking does not verify a BOK", async () => {
  let call = 0;
  const fetchImpl = async () => {
    call += 1;
    return new Response(
      JSON.stringify(
        call === 1
          ? { success: true, draftId: "draft-2" }
          : { success: true, bookingId: "12345", bookingNumber: null }
      ),
      { status: 200 }
    );
  };

  await assert.rejects(
    createWithLisaFastBooking(
      { customerName: "Test Customer" },
      { fetchImpl, url: "https://example.test/lisa/booking-action", secret: "x" }
    ),
    /verified Octopus BOK/
  );
});

