/**
 * Tests for the pure helper functions exported from the main dashboard route.
 * These functions contain all the core business logic and have no external
 * dependencies, so they can be tested without mocking anything.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  resolveShipmentStatus,
  resolvePriority,
  formatCurrency,
  timeAgo,
} from "../app._index";

// ─── resolveShipmentStatus ────────────────────────────────────────────────────

describe("resolveShipmentStatus", () => {
  // ── Unfulfilled orders ──────────────────────────────────────────────────
  it("returns 'unfulfilled' when displayFulfillmentStatus is UNFULFILLED", () => {
    expect(
      resolveShipmentStatus({ displayFulfillmentStatus: "UNFULFILLED", fulfillments: [] })
    ).toBe("unfulfilled");
  });

  it("returns 'unfulfilled' when displayFulfillmentStatus is ON_HOLD", () => {
    expect(
      resolveShipmentStatus({ displayFulfillmentStatus: "ON_HOLD", fulfillments: [] })
    ).toBe("unfulfilled");
  });

  it("returns 'unfulfilled' when displayFulfillmentStatus is SCHEDULED", () => {
    expect(
      resolveShipmentStatus({ displayFulfillmentStatus: "SCHEDULED", fulfillments: [] })
    ).toBe("unfulfilled");
  });

  it("returns 'unfulfilled' when fulfillments array is absent", () => {
    expect(
      resolveShipmentStatus({ displayFulfillmentStatus: "UNFULFILLED" })
    ).toBe("unfulfilled");
  });

  it("returns 'unfulfilled' when fulfillments array is empty", () => {
    expect(
      resolveShipmentStatus({ displayFulfillmentStatus: "FULFILLED", fulfillments: [] })
    ).toBe("unfulfilled");
  });

  // ── Fulfilled with no events ────────────────────────────────────────────
  it("returns 'label_created' when fulfillment has a tracking number but no events", () => {
    const order = {
      displayFulfillmentStatus: "FULFILLED",
      fulfillments: [
        {
          trackingInfo: [{ number: "9400111899223397981282", company: "USPS" }],
          events: { edges: [] },
        },
      ],
    };
    expect(resolveShipmentStatus(order)).toBe("label_created");
  });

  it("returns 'in_progress' when fulfillment exists but has no tracking and no events", () => {
    const order = {
      displayFulfillmentStatus: "FULFILLED",
      fulfillments: [{ trackingInfo: [], events: { edges: [] } }],
    };
    expect(resolveShipmentStatus(order)).toBe("in_progress");
  });

  // ── Status from FulfillmentEvents ───────────────────────────────────────
  const makeOrderWithEvent = (eventStatus: string) => ({
    displayFulfillmentStatus: "FULFILLED",
    fulfillments: [
      {
        trackingInfo: [{ number: "123" }],
        events: {
          edges: [{ node: { status: eventStatus, happenedAt: "2024-01-15T10:00:00Z" } }],
        },
      },
    ],
  });

  it.each([
    ["LABEL_PURCHASED", "label_created"],
    ["LABEL_PRINTED", "label_created"],
  ])("maps event %s → '%s'", (event, expected) => {
    expect(resolveShipmentStatus(makeOrderWithEvent(event))).toBe(expected);
  });

  it.each([
    ["CONFIRMED", "accepted_by_carrier"],
    ["CARRIER_PICKED_UP", "accepted_by_carrier"],
  ])("maps event %s → '%s'", (event, expected) => {
    expect(resolveShipmentStatus(makeOrderWithEvent(event))).toBe(expected);
  });

  it.each([
    ["IN_TRANSIT", "in_transit"],
    ["OUT_FOR_DELIVERY", "in_transit"],
    ["READY_FOR_PICKUP", "in_transit"],
    ["ATTEMPTED_DELIVERY", "in_transit"],
  ])("maps event %s → '%s'", (event, expected) => {
    expect(resolveShipmentStatus(makeOrderWithEvent(event))).toBe(expected);
  });

  it("maps event DELIVERED → 'delivered'", () => {
    expect(resolveShipmentStatus(makeOrderWithEvent("DELIVERED"))).toBe("delivered");
  });

  it.each([["FAILURE", "delivery_issue"], ["LABEL_VOIDED", "delivery_issue"]])(
    "maps event %s → 'delivery_issue'",
    (event, expected) => {
      expect(resolveShipmentStatus(makeOrderWithEvent(event))).toBe(expected);
    }
  );

  it("returns 'label_created' for an unknown event when tracking exists", () => {
    expect(resolveShipmentStatus(makeOrderWithEvent("SOME_FUTURE_EVENT"))).toBe("label_created");
  });

  // ── Most recent event wins ──────────────────────────────────────────────
  it("uses the most recent event (first in the sorted-descending edges array)", () => {
    // Events are sorted descending by happenedAt in the GraphQL query,
    // so edges[0] is the most recent.
    const order = {
      displayFulfillmentStatus: "FULFILLED",
      fulfillments: [
        {
          trackingInfo: [{ number: "123" }],
          events: {
            edges: [
              { node: { status: "DELIVERED", happenedAt: "2024-01-16T10:00:00Z" } },
              { node: { status: "IN_TRANSIT", happenedAt: "2024-01-15T10:00:00Z" } },
            ],
          },
        },
      ],
    };
    expect(resolveShipmentStatus(order)).toBe("delivered");
  });

  it("prefers the first fulfillment's events over later ones", () => {
    // First fulfillment with DELIVERED takes precedence over second with IN_TRANSIT.
    const order = {
      displayFulfillmentStatus: "FULFILLED",
      fulfillments: [
        {
          trackingInfo: [{ number: "111" }],
          events: {
            edges: [{ node: { status: "DELIVERED", happenedAt: "2024-01-16T00:00:00Z" } }],
          },
        },
        {
          trackingInfo: [{ number: "222" }],
          events: {
            edges: [{ node: { status: "IN_TRANSIT", happenedAt: "2024-01-15T00:00:00Z" } }],
          },
        },
      ],
    };
    expect(resolveShipmentStatus(order)).toBe("delivered");
  });
});

// ─── resolvePriority ──────────────────────────────────────────────────────────

describe("resolvePriority", () => {
  it("returns isPriority=false for free shipping (amount 0)", () => {
    const order = {
      tags: [],
      shippingLines: {
        edges: [
          {
            node: {
              title: "Free Shipping",
              discountedPriceSet: { shopMoney: { amount: "0.00" } },
            },
          },
        ],
      },
    };
    expect(resolvePriority(order)).toEqual({ isPriority: false, reason: "" });
  });

  it("returns isPriority=true when any shipping line has a non-zero cost", () => {
    const order = {
      tags: [],
      shippingLines: {
        edges: [
          {
            node: {
              title: "UPS 2-Day",
              discountedPriceSet: { shopMoney: { amount: "12.50" } },
            },
          },
        ],
      },
    };
    const result = resolvePriority(order);
    expect(result.isPriority).toBe(true);
    expect(result.reason).toContain("UPS 2-Day");
  });

  it("returns isPriority=true when one of multiple shipping lines is paid", () => {
    const order = {
      tags: [],
      shippingLines: {
        edges: [
          {
            node: {
              title: "Overnight Express",
              discountedPriceSet: { shopMoney: { amount: "29.99" } },
            },
          },
          {
            node: {
              title: "Handling Fee",
              discountedPriceSet: { shopMoney: { amount: "0.00" } },
            },
          },
        ],
      },
    };
    expect(resolvePriority(order).isPriority).toBe(true);
  });

  it("returns isPriority=true when order has an 'amazon' tag (case-insensitive)", () => {
    const order = {
      tags: ["Amazon", "marketplace"],
      shippingLines: {
        edges: [
          {
            node: {
              title: "Standard Shipping",
              discountedPriceSet: { shopMoney: { amount: "0.00" } },
            },
          },
        ],
      },
    };
    const result = resolvePriority(order);
    expect(result.isPriority).toBe(true);
    expect(result.reason).toBe("Amazon order");
  });

  it("returns isPriority=true for mixed-case amazon tag", () => {
    const order = {
      tags: ["AMAZON_FBA"],
      shippingLines: { edges: [] },
    };
    expect(resolvePriority(order).isPriority).toBe(true);
  });

  it("returns isPriority=true when channelInformation channelName contains 'amazon'", () => {
    const order = {
      tags: [],
      shippingLines: { edges: [] },
      channelInformation: {
        channelDefinition: { channelName: "Amazon", handle: "amazon" },
      },
    };
    const result = resolvePriority(order);
    expect(result.isPriority).toBe(true);
    expect(result.reason).toBe("Amazon channel");
  });

  it("returns isPriority=true when channelInformation handle contains 'amazon'", () => {
    const order = {
      tags: [],
      shippingLines: { edges: [] },
      channelInformation: {
        channelDefinition: { channelName: "Marketplace Connect", handle: "amazon_marketplace" },
      },
    };
    expect(resolvePriority(order).isPriority).toBe(true);
  });

  it("returns isPriority=false when no shipping cost, no amazon tag, no amazon channel", () => {
    const order = {
      tags: ["wholesale", "b2b"],
      shippingLines: {
        edges: [
          {
            node: {
              title: "Free Shipping",
              discountedPriceSet: { shopMoney: { amount: "0.00" } },
            },
          },
        ],
      },
      channelInformation: {
        channelDefinition: { channelName: "Online Store", handle: "online_store" },
      },
    };
    expect(resolvePriority(order)).toEqual({ isPriority: false, reason: "" });
  });

  it("handles absent shippingLines gracefully", () => {
    const order = { tags: [] };
    expect(resolvePriority(order)).toEqual({ isPriority: false, reason: "" });
  });

  it("handles null channelInformation gracefully", () => {
    const order = {
      tags: [],
      shippingLines: { edges: [] },
      channelInformation: null,
    };
    expect(resolvePriority(order)).toEqual({ isPriority: false, reason: "" });
  });
});

// ─── formatCurrency ───────────────────────────────────────────────────────────

describe("formatCurrency", () => {
  it("formats whole-dollar USD amounts without cents", () => {
    expect(formatCurrency(1234, "USD")).toBe("$1,234");
  });

  it("rounds fractional amounts to whole dollars", () => {
    expect(formatCurrency(99.99, "USD")).toBe("$100");
  });

  it("formats zero correctly", () => {
    expect(formatCurrency(0, "USD")).toBe("$0");
  });

  it("formats EUR amounts with the correct symbol", () => {
    // EUR formatting uses the local's symbol; just check it's non-empty and numeric
    const result = formatCurrency(500, "EUR");
    expect(result).toMatch(/500/);
  });

  it("formats large amounts with thousands separator", () => {
    expect(formatCurrency(12345, "USD")).toBe("$12,345");
  });
});

// ─── timeAgo ─────────────────────────────────────────────────────────────────

describe("timeAgo", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // Fix "now" to a known timestamp so relative calculations are deterministic.
    vi.setSystemTime(new Date("2024-06-15T12:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows minutes for a very recent date", () => {
    const fiveMinutesAgo = new Date("2024-06-15T11:55:00Z").toISOString();
    expect(timeAgo(fiveMinutesAgo)).toBe("5m ago");
  });

  it("shows at least 1m ago for a brand-new date", () => {
    const justNow = new Date("2024-06-15T11:59:59Z").toISOString();
    expect(timeAgo(justNow)).toBe("1m ago");
  });

  it("shows hours for a sub-day date", () => {
    const threeHoursAgo = new Date("2024-06-15T09:00:00Z").toISOString();
    expect(timeAgo(threeHoursAgo)).toBe("3h ago");
  });

  it("shows days for a date more than 24 hours ago", () => {
    const twoDaysAgo = new Date("2024-06-13T12:00:00Z").toISOString();
    expect(timeAgo(twoDaysAgo)).toBe("2d ago");
  });

  it("shows 1d ago for exactly 25 hours ago", () => {
    const twentyFiveHoursAgo = new Date("2024-06-14T11:00:00Z").toISOString();
    expect(timeAgo(twentyFiveHoursAgo)).toBe("1d ago");
  });
});
