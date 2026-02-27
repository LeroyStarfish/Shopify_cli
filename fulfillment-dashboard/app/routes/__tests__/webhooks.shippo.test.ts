/**
 * Tests for the Shippo track_updated webhook handler.
 *
 * Covers three layers:
 *   1. validateShippoSignature  — pure HMAC utility
 *   2. refineTransitStatus      — pure status-detail parser
 *   3. action                   — end-to-end handler with mocked DB + Shopify
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import crypto from "node:crypto";

// ── Module mocks ──────────────────────────────────────────────────────────────

vi.mock("~/shopify.server", () => ({
  unauthenticated: {
    admin: vi.fn(),
  },
}));

vi.mock("~/db.server", () => ({
  default: {
    trackingRecord: {
      findUnique: vi.fn(),
    },
  },
}));

// ── Imports after mocks ───────────────────────────────────────────────────────

import {
  validateShippoSignature,
  refineTransitStatus,
  SHIPPO_STATUS_MAP,
  action,
} from "../webhooks.shippo";
import db from "~/db.server";
import { unauthenticated } from "~/shopify.server";

// ── Test helpers ──────────────────────────────────────────────────────────────

const TEST_SECRET = "test-webhook-secret-abc123";
const FIXED_TIMESTAMP = "1700000000";

/**
 * Produces a valid Shippo HMAC-SHA256 signature header for the given body.
 * Format: `t=<timestamp>,v1=<hex-digest>`
 * Signed string: `<timestamp>.<rawBody>`
 */
function makeValidShippoHeader(rawBody: string, secret = TEST_SECRET): string {
  const sig = crypto
    .createHmac("sha256", secret)
    .update(`${FIXED_TIMESTAMP}.${rawBody}`)
    .digest("hex");
  return `t=${FIXED_TIMESTAMP},v1=${sig}`;
}

/** Build a `track_updated` Shippo webhook payload */
function makeShippoPayload(overrides: Record<string, unknown> = {}) {
  return {
    event_type: "track_updated",
    carrier: "usps",
    tracking_number: "9400111899223397981282",
    tracking_status: {
      status: "TRANSIT",
      status_details: "Your package is in transit.",
      object_updated: "2024-01-15T10:00:00Z",
    },
    ...overrides,
  };
}

/** Create a POST Request with a Shippo payload, optionally adding a sig header */
function makeShippoRequest(
  payload: object,
  opts: { signatureHeader?: string; env?: Record<string, string> } = {}
) {
  const rawBody = JSON.stringify(payload);
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.signatureHeader) {
    headers["shippo-auth-signature"] = opts.signatureHeader;
  }
  return new Request("https://app.example.com/webhooks/shippo", {
    method: "POST",
    headers,
    body: rawBody,
  });
}

/** Returns a mock `admin` object whose graphql() call resolves successfully */
function mockAdminGraphql(userErrors: any[] = []) {
  const graphql = vi.fn().mockResolvedValue({
    json: () =>
      Promise.resolve({
        data: {
          fulfillmentEventCreate: {
            fulfillmentEvent: { id: "gid://shopify/FulfillmentEvent/1", status: "IN_TRANSIT" },
            userErrors,
          },
        },
      }),
  });
  return { graphql };
}

// ─── validateShippoSignature ──────────────────────────────────────────────────

describe("validateShippoSignature", () => {
  const body = JSON.stringify({ event_type: "track_updated", tracking_number: "123" });

  it("returns true for a correctly signed payload", () => {
    const header = makeValidShippoHeader(body);
    expect(validateShippoSignature(body, header, TEST_SECRET)).toBe(true);
  });

  it("returns false when the signature is tampered with", () => {
    const header = makeValidShippoHeader(body);
    const tampered = header.replace(/v1=[a-f0-9]{4}/, "v1=0000");
    expect(validateShippoSignature(body, tampered, TEST_SECRET)).toBe(false);
  });

  it("returns false when the body has been altered after signing", () => {
    const header = makeValidShippoHeader(body);
    const alteredBody = body + " "; // whitespace appended
    expect(validateShippoSignature(alteredBody, header, TEST_SECRET)).toBe(false);
  });

  it("returns false when the secret is wrong", () => {
    const header = makeValidShippoHeader(body, "wrong-secret");
    expect(validateShippoSignature(body, header, TEST_SECRET)).toBe(false);
  });

  it("returns false when the header is empty", () => {
    expect(validateShippoSignature(body, "", TEST_SECRET)).toBe(false);
  });

  it("returns false when the timestamp field is missing", () => {
    const sig = crypto.createHmac("sha256", TEST_SECRET).update(body).digest("hex");
    expect(validateShippoSignature(body, `v1=${sig}`, TEST_SECRET)).toBe(false);
  });

  it("returns false when the v1 field is missing", () => {
    expect(validateShippoSignature(body, `t=${FIXED_TIMESTAMP}`, TEST_SECRET)).toBe(false);
  });

  it("returns false for a completely malformed header", () => {
    expect(validateShippoSignature(body, "not-a-valid-header", TEST_SECRET)).toBe(false);
  });
});

// ─── refineTransitStatus ──────────────────────────────────────────────────────

describe("refineTransitStatus", () => {
  it.each([
    ["Package is out for delivery today", "OUT_FOR_DELIVERY"],
    ["Out-for-delivery scan recorded", "OUT_FOR_DELIVERY"],
  ])("maps '%s' → OUT_FOR_DELIVERY", (detail, expected) => {
    expect(refineTransitStatus(detail)).toBe(expected);
  });

  it.each([
    ["Attempted delivery — no one home", "ATTEMPTED_DELIVERY"],
    ["Delivery attempt failed", "ATTEMPTED_DELIVERY"],
  ])("maps '%s' → ATTEMPTED_DELIVERY", (detail, expected) => {
    expect(refineTransitStatus(detail)).toBe(expected);
  });

  it.each([
    ["Package is ready for pickup at local post office", "READY_FOR_PICKUP"],
    ["Available for pickup at facility", "READY_FOR_PICKUP"],
  ])("maps '%s' → READY_FOR_PICKUP", (detail, expected) => {
    expect(refineTransitStatus(detail)).toBe(expected);
  });

  it.each([
    ["Carrier picked up the package", "CONFIRMED"],
    ["Package picked up by driver", "CONFIRMED"],
  ])("maps '%s' → CONFIRMED", (detail, expected) => {
    expect(refineTransitStatus(detail)).toBe(expected);
  });

  it("returns IN_TRANSIT for a generic transit message", () => {
    expect(refineTransitStatus("Shipment is on its way")).toBe("IN_TRANSIT");
  });

  it("returns IN_TRANSIT for an empty string", () => {
    expect(refineTransitStatus("")).toBe("IN_TRANSIT");
  });
});

// ─── SHIPPO_STATUS_MAP ────────────────────────────────────────────────────────

describe("SHIPPO_STATUS_MAP", () => {
  it("maps PRE_TRANSIT to LABEL_PURCHASED", () => {
    expect(SHIPPO_STATUS_MAP["PRE_TRANSIT"]).toBe("LABEL_PURCHASED");
  });
  it("maps TRANSIT to IN_TRANSIT", () => {
    expect(SHIPPO_STATUS_MAP["TRANSIT"]).toBe("IN_TRANSIT");
  });
  it("maps DELIVERED to DELIVERED", () => {
    expect(SHIPPO_STATUS_MAP["DELIVERED"]).toBe("DELIVERED");
  });
  it("maps RETURNED to FAILURE", () => {
    expect(SHIPPO_STATUS_MAP["RETURNED"]).toBe("FAILURE");
  });
  it("maps FAILURE to FAILURE", () => {
    expect(SHIPPO_STATUS_MAP["FAILURE"]).toBe("FAILURE");
  });
  it("maps UNKNOWN to null (should be ignored)", () => {
    expect(SHIPPO_STATUS_MAP["UNKNOWN"]).toBeNull();
  });
});

// ─── action ───────────────────────────────────────────────────────────────────

describe("webhooks.shippo action", () => {
  const shop = "test-store.myshopify.com";

  const trackingRecord = {
    trackingNumber: "9400111899223397981282",
    shop,
    fulfillmentId: "gid://shopify/Fulfillment/255858046",
    orderId: "gid://shopify/Order/450789469",
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  beforeEach(() => {
    // Default: tracking record exists in DB
    vi.mocked(db.trackingRecord.findUnique).mockResolvedValue(trackingRecord);

    // Default: Shopify API call succeeds
    vi.mocked(unauthenticated.admin).mockResolvedValue({
      admin: mockAdminGraphql() as any,
      session: {} as any,
    });

    // Clear env variable between tests
    delete process.env.SHIPPO_WEBHOOK_SECRET;
  });

  // ── Event-type filtering ──────────────────────────────────────────────────

  it("returns 200 and does nothing for non-track_updated events", async () => {
    const payload = { event_type: "transaction_created", tracking_number: "123" };
    const response = await action({
      request: makeShippoRequest(payload),
      params: {},
      context: {},
    });

    expect(response.status).toBe(200);
    expect(db.trackingRecord.findUnique).not.toHaveBeenCalled();
  });

  it("returns 200 and does nothing for UNKNOWN Shippo status", async () => {
    const payload = makeShippoPayload({
      tracking_status: { status: "UNKNOWN", status_details: "", object_updated: "2024-01-15T10:00:00Z" },
    });
    const response = await action({
      request: makeShippoRequest(payload),
      params: {},
      context: {},
    });

    expect(response.status).toBe(200);
    expect(db.trackingRecord.findUnique).not.toHaveBeenCalled();
  });

  it("returns 200 and does nothing when tracking_number is absent", async () => {
    const payload = makeShippoPayload({ tracking_number: undefined });
    const response = await action({
      request: makeShippoRequest(payload),
      params: {},
      context: {},
    });

    expect(response.status).toBe(200);
    expect(db.trackingRecord.findUnique).not.toHaveBeenCalled();
  });

  // ── Status mapping in action ──────────────────────────────────────────────

  it("creates a LABEL_PURCHASED event for PRE_TRANSIT status", async () => {
    const payload = makeShippoPayload({
      tracking_status: { status: "PRE_TRANSIT", status_details: "", object_updated: "2024-01-15T10:00:00Z" },
    });

    await action({ request: makeShippoRequest(payload), params: {}, context: {} });

    const { graphql } = vi.mocked(unauthenticated.admin).mock.results[0].value.admin;
    expect(graphql).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        variables: expect.objectContaining({
          fulfillmentEvent: expect.objectContaining({ status: "LABEL_PURCHASED" }),
        }),
      })
    );
  });

  it("creates an IN_TRANSIT event for TRANSIT status with generic details", async () => {
    const payload = makeShippoPayload({
      tracking_status: { status: "TRANSIT", status_details: "In transit", object_updated: "2024-01-15T10:00:00Z" },
    });

    await action({ request: makeShippoRequest(payload), params: {}, context: {} });

    const { graphql } = vi.mocked(unauthenticated.admin).mock.results[0].value.admin;
    expect(graphql).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        variables: expect.objectContaining({
          fulfillmentEvent: expect.objectContaining({ status: "IN_TRANSIT" }),
        }),
      })
    );
  });

  it("refines TRANSIT to OUT_FOR_DELIVERY when details indicate it", async () => {
    const payload = makeShippoPayload({
      tracking_status: {
        status: "TRANSIT",
        status_details: "Package is out for delivery",
        object_updated: "2024-01-16T08:00:00Z",
      },
    });

    await action({ request: makeShippoRequest(payload), params: {}, context: {} });

    const { graphql } = vi.mocked(unauthenticated.admin).mock.results[0].value.admin;
    expect(graphql).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        variables: expect.objectContaining({
          fulfillmentEvent: expect.objectContaining({ status: "OUT_FOR_DELIVERY" }),
        }),
      })
    );
  });

  it("creates a DELIVERED event for DELIVERED status", async () => {
    const payload = makeShippoPayload({
      tracking_status: { status: "DELIVERED", status_details: "Delivered", object_updated: "2024-01-17T14:00:00Z" },
    });

    await action({ request: makeShippoRequest(payload), params: {}, context: {} });

    const { graphql } = vi.mocked(unauthenticated.admin).mock.results[0].value.admin;
    expect(graphql).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        variables: expect.objectContaining({
          fulfillmentEvent: expect.objectContaining({ status: "DELIVERED" }),
        }),
      })
    );
  });

  it("creates a FAILURE event for RETURNED status", async () => {
    const payload = makeShippoPayload({
      tracking_status: { status: "RETURNED", status_details: "Return to sender", object_updated: "2024-01-18T09:00:00Z" },
    });

    await action({ request: makeShippoRequest(payload), params: {}, context: {} });

    const { graphql } = vi.mocked(unauthenticated.admin).mock.results[0].value.admin;
    expect(graphql).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        variables: expect.objectContaining({
          fulfillmentEvent: expect.objectContaining({ status: "FAILURE" }),
        }),
      })
    );
  });

  // ── DB lookup failure ─────────────────────────────────────────────────────

  it("returns 200 with a warning when no TrackingRecord is found for the number", async () => {
    vi.mocked(db.trackingRecord.findUnique).mockResolvedValue(null);

    const response = await action({
      request: makeShippoRequest(makeShippoPayload()),
      params: {},
      context: {},
    });

    expect(response.status).toBe(200);
    expect(unauthenticated.admin).not.toHaveBeenCalled();
  });

  // ── Shopify API errors ────────────────────────────────────────────────────

  it("returns 200 even when Shopify returns userErrors (logs but does not retry)", async () => {
    vi.mocked(unauthenticated.admin).mockResolvedValue({
      admin: mockAdminGraphql([{ field: "status", message: "Already exists" }]) as any,
      session: {} as any,
    });

    const response = await action({
      request: makeShippoRequest(makeShippoPayload()),
      params: {},
      context: {},
    });

    expect(response.status).toBe(200);
  });

  it("returns 200 even when the Shopify API call throws (prevents Shippo retry loop)", async () => {
    vi.mocked(unauthenticated.admin).mockRejectedValue(new Error("Network failure"));

    const response = await action({
      request: makeShippoRequest(makeShippoPayload()),
      params: {},
      context: {},
    });

    expect(response.status).toBe(200);
  });

  // ── HMAC signature validation ─────────────────────────────────────────────

  it("accepts unsigned requests when SHIPPO_WEBHOOK_SECRET is not set (dev mode)", async () => {
    const response = await action({
      request: makeShippoRequest(makeShippoPayload()), // no sig header
      params: {},
      context: {},
    });

    // Should process normally (secret not configured)
    expect(response.status).toBe(200);
    expect(unauthenticated.admin).toHaveBeenCalled();
  });

  it("returns 401 when SHIPPO_WEBHOOK_SECRET is set but signature header is missing", async () => {
    process.env.SHIPPO_WEBHOOK_SECRET = TEST_SECRET;

    const response = await action({
      request: makeShippoRequest(makeShippoPayload()), // no header
      params: {},
      context: {},
    });

    expect(response.status).toBe(401);
    expect(unauthenticated.admin).not.toHaveBeenCalled();
  });

  it("returns 401 when SHIPPO_WEBHOOK_SECRET is set and signature is invalid", async () => {
    process.env.SHIPPO_WEBHOOK_SECRET = TEST_SECRET;

    const response = await action({
      request: makeShippoRequest(makeShippoPayload(), {
        signatureHeader: "t=1700000000,v1=deadbeefdeadbeef",
      }),
      params: {},
      context: {},
    });

    expect(response.status).toBe(401);
  });

  it("accepts a request with a valid HMAC signature when SHIPPO_WEBHOOK_SECRET is set", async () => {
    process.env.SHIPPO_WEBHOOK_SECRET = TEST_SECRET;
    const payload = makeShippoPayload();
    const rawBody = JSON.stringify(payload);
    const sigHeader = makeValidShippoHeader(rawBody);

    const request = new Request("https://app.example.com/webhooks/shippo", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "shippo-auth-signature": sigHeader,
      },
      body: rawBody,
    });

    const response = await action({ request, params: {}, context: {} });

    expect(response.status).toBe(200);
    expect(unauthenticated.admin).toHaveBeenCalled();
  });

  it("passes the happenedAt timestamp and status_details message to Shopify", async () => {
    const payload = makeShippoPayload({
      tracking_status: {
        status: "TRANSIT",
        status_details: "Arrived at sorting facility",
        object_updated: "2024-01-15T10:30:00.000Z",
      },
    });

    await action({ request: makeShippoRequest(payload), params: {}, context: {} });

    const { graphql } = vi.mocked(unauthenticated.admin).mock.results[0].value.admin;
    expect(graphql).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        variables: expect.objectContaining({
          fulfillmentEvent: expect.objectContaining({
            happenedAt: "2024-01-15T10:30:00.000Z",
            message: "Arrived at sorting facility",
          }),
        }),
      })
    );
  });
});
