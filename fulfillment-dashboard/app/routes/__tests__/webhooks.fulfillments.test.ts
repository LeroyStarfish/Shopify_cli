/**
 * Tests for the Shopify FULFILLMENTS_CREATE webhook handler.
 *
 * This handler's job is to index tracking numbers → Shopify Fulfillment GIDs
 * in the local DB so the Shippo webhook can look them up instantly later.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Module mocks — must be declared before any imports that use them ──────────

vi.mock("~/shopify.server", () => ({
  authenticate: {
    webhook: vi.fn(),
  },
}));

vi.mock("~/db.server", () => ({
  default: {
    trackingRecord: {
      upsert: vi.fn().mockResolvedValue({}),
    },
  },
}));

// ── Import after mocks ────────────────────────────────────────────────────────

import { action } from "../webhooks.fulfillments";
import db from "~/db.server";
import { authenticate } from "~/shopify.server";

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Build a minimal fake Request that Remix's action receives */
function makeRequest(body: object = {}) {
  return new Request("https://app.example.com/webhooks/fulfillments", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** Standard fulfilled order payload from Shopify's REST webhook format */
function makeFulfillmentPayload(overrides: Record<string, unknown> = {}) {
  return {
    id: 255858046,
    order_id: 450789469,
    status: "success",
    admin_graphql_api_id: "gid://shopify/Fulfillment/255858046",
    tracking_numbers: ["9400111899223397981282"],
    tracking_number: "9400111899223397981282",
    tracking_company: "USPS",
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("webhooks.fulfillments action", () => {
  const shop = "test-store.myshopify.com";

  beforeEach(() => {
    // Default: authenticate.webhook resolves with a valid fulfillments/create event
    vi.mocked(authenticate.webhook).mockResolvedValue({
      topic: "FULFILLMENTS_CREATE",
      shop,
      payload: makeFulfillmentPayload(),
      session: undefined as any,
      admin: undefined as any,
      adminSession: undefined as any,
    });
  });

  it("stores a TrackingRecord when a fulfillment with tracking is created", async () => {
    const response = await action({ request: makeRequest(), params: {}, context: {} });

    expect(response.status).toBe(200);
    expect(db.trackingRecord.upsert).toHaveBeenCalledOnce();
    expect(db.trackingRecord.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { trackingNumber: "9400111899223397981282" },
        create: expect.objectContaining({
          trackingNumber: "9400111899223397981282",
          shop,
          fulfillmentId: "gid://shopify/Fulfillment/255858046",
          orderId: "gid://shopify/Order/450789469",
        }),
      })
    );
  });

  it("stores all tracking numbers when the array contains multiple entries", async () => {
    vi.mocked(authenticate.webhook).mockResolvedValue({
      topic: "FULFILLMENTS_CREATE",
      shop,
      payload: makeFulfillmentPayload({
        tracking_numbers: ["TRACK001", "TRACK002", "TRACK003"],
      }),
      session: undefined as any,
      admin: undefined as any,
      adminSession: undefined as any,
    });

    await action({ request: makeRequest(), params: {}, context: {} });

    expect(db.trackingRecord.upsert).toHaveBeenCalledTimes(3);
    const calledWithNumbers = vi
      .mocked(db.trackingRecord.upsert)
      .mock.calls.map((call) => (call[0] as any).where.trackingNumber);
    expect(calledWithNumbers).toEqual(["TRACK001", "TRACK002", "TRACK003"]);
  });

  it("falls back to the scalar tracking_number when tracking_numbers array is absent", async () => {
    vi.mocked(authenticate.webhook).mockResolvedValue({
      topic: "FULFILLMENTS_CREATE",
      shop,
      payload: makeFulfillmentPayload({ tracking_numbers: undefined }),
      session: undefined as any,
      admin: undefined as any,
      adminSession: undefined as any,
    });

    await action({ request: makeRequest(), params: {}, context: {} });

    expect(db.trackingRecord.upsert).toHaveBeenCalledOnce();
    expect(db.trackingRecord.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { trackingNumber: "9400111899223397981282" } })
    );
  });

  it("falls back to the scalar tracking_number when tracking_numbers is an empty array", async () => {
    vi.mocked(authenticate.webhook).mockResolvedValue({
      topic: "FULFILLMENTS_CREATE",
      shop,
      payload: makeFulfillmentPayload({ tracking_numbers: [] }),
      session: undefined as any,
      admin: undefined as any,
      adminSession: undefined as any,
    });

    await action({ request: makeRequest(), params: {}, context: {} });

    expect(db.trackingRecord.upsert).toHaveBeenCalledOnce();
  });

  it("returns 200 and skips upsert when there is no tracking number", async () => {
    vi.mocked(authenticate.webhook).mockResolvedValue({
      topic: "FULFILLMENTS_CREATE",
      shop,
      payload: makeFulfillmentPayload({
        tracking_number: undefined,
        tracking_numbers: [],
      }),
      session: undefined as any,
      admin: undefined as any,
      adminSession: undefined as any,
    });

    const response = await action({ request: makeRequest(), params: {}, context: {} });

    expect(response.status).toBe(200);
    expect(db.trackingRecord.upsert).not.toHaveBeenCalled();
  });

  it("returns 200 and skips upsert when admin_graphql_api_id is missing", async () => {
    vi.mocked(authenticate.webhook).mockResolvedValue({
      topic: "FULFILLMENTS_CREATE",
      shop,
      payload: makeFulfillmentPayload({ admin_graphql_api_id: undefined }),
      session: undefined as any,
      admin: undefined as any,
      adminSession: undefined as any,
    });

    const response = await action({ request: makeRequest(), params: {}, context: {} });

    expect(response.status).toBe(200);
    expect(db.trackingRecord.upsert).not.toHaveBeenCalled();
  });

  it("is idempotent — a re-delivered webhook upserts without error", async () => {
    // Upsert should succeed on duplicate tracking numbers (update path)
    vi.mocked(db.trackingRecord.upsert).mockResolvedValue({} as any);

    const req1 = makeRequest();
    const req2 = makeRequest();
    const [r1, r2] = await Promise.all([
      action({ request: req1, params: {}, context: {} }),
      action({ request: req2, params: {}, context: {} }),
    ]);

    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(db.trackingRecord.upsert).toHaveBeenCalledTimes(2);
  });

  it("returns 400 when the webhook topic is unexpected", async () => {
    vi.mocked(authenticate.webhook).mockResolvedValue({
      topic: "ORDERS_CREATE",          // wrong topic
      shop,
      payload: makeFulfillmentPayload(),
      session: undefined as any,
      admin: undefined as any,
      adminSession: undefined as any,
    });

    const response = await action({ request: makeRequest(), params: {}, context: {} });

    expect(response.status).toBe(400);
    expect(db.trackingRecord.upsert).not.toHaveBeenCalled();
  });

  it("filters out blank strings from the tracking_numbers array", async () => {
    vi.mocked(authenticate.webhook).mockResolvedValue({
      topic: "FULFILLMENTS_CREATE",
      shop,
      payload: makeFulfillmentPayload({ tracking_numbers: ["  ", "VALID123", ""] }),
      session: undefined as any,
      admin: undefined as any,
      adminSession: undefined as any,
    });

    await action({ request: makeRequest(), params: {}, context: {} });

    // Only "VALID123" should be stored — blank strings must be skipped
    expect(db.trackingRecord.upsert).toHaveBeenCalledOnce();
    expect(db.trackingRecord.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { trackingNumber: "VALID123" } })
    );
  });
});
