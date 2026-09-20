import test from "node:test";
import assert from "node:assert/strict";
import {
  createWithLisaFastBooking,
  lookupAddressWithLisaFastBooking,
  searchWithLisaFastBooking
} from "../playwright/fast-booking-client.js";

test("uses Lisa's single-pass fast path and forces unassigned creation", async () => {
  const requests = [];
  const fetchImpl = async (_url, options) => {
    const request = JSON.parse(options.body);
    requests.push(request);
    const body = {
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

  assert.equal(requests.length, 1);
  assert.equal(requests[0].action, "create_fast");
  assert.equal(requests[0].customerConfirmed, true);
  assert.equal(requests[0].fieldworkerName, "Unassigned Tasks Manager");
  assert.equal(result.bookingNumber, "BOK-12345");
  assert.equal(result.fieldworkerAssignment, "Unassigned Tasks Manager");
});

test("fails closed when Fast Booking does not verify a BOK", async () => {
  const fetchImpl = async () => {
    return new Response(
      JSON.stringify({ success: true, bookingId: "12345", bookingNumber: null }),
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

test("search uses the live Fast Booking Octopus lookup", async () => {
  let request;
  const fetchImpl = async (_url, options) => {
    request = JSON.parse(options.body);
    return new Response(JSON.stringify({ success: true, found: true }), { status: 200 });
  };

  const result = await searchWithLisaFastBooking(
    { customerName: "Ada", limit: 25 },
    { fetchImpl, url: "https://example.test/lisa/booking-action", secret: "x" }
  );

  assert.equal(request.action, "lookup");
  assert.equal(request.customerName, "Ada");
  assert.equal(result.found, true);
});

test("address lookup uses Octopus native address resolution", async () => {
  let request;
  const fetchImpl = async (_url, options) => {
    request = JSON.parse(options.body);
    return new Response(
      JSON.stringify({ success: true, outcome: "address_selected" }),
      { status: 200 }
    );
  };

  const result = await lookupAddressWithLisaFastBooking(
    { fullAddress: "123 Main St, Detroit, MI 48201" },
    { fetchImpl, url: "https://example.test/lisa/booking-action", secret: "x" }
  );

  assert.equal(request.action, "lookup_address");
  assert.equal(request.fullAddress, "123 Main St, Detroit, MI 48201");
  assert.equal(result.outcome, "address_selected");
});

test("address lookup preserves Octopus suggestions when no safe match exists", async () => {
  const fetchImpl = async () => new Response(
    JSON.stringify({
      success: false,
      outcome: "address_no_match",
      suggestions: ["123 Main St, Detroit, MI 48201"]
    }),
    { status: 200 }
  );

  const result = await lookupAddressWithLisaFastBooking(
    { fullAddress: "123 Main" },
    { fetchImpl, url: "https://example.test/lisa/booking-action", secret: "x" }
  );

  assert.equal(result.success, false);
  assert.equal(result.outcome, "address_no_match");
  assert.deepEqual(result.suggestions, ["123 Main St, Detroit, MI 48201"]);
});
