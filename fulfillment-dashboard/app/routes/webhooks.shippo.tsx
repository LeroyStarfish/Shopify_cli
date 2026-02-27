/**
 * webhooks.shippo.tsx  →  POST /webhooks/shippo
 *
 * Receives Shippo `track_updated` events and writes a Shopify
 * FulfillmentEvent so the dashboard (and Shopify's order timeline)
 * reflect real carrier progress: label created → in transit → delivered.
 *
 * ── How it works ────────────────────────────────────────────────────────────
 * 1. Shippo fires this URL every time a carrier scan happens.
 * 2. We validate the HMAC-SHA256 signature (requires SHIPPO_WEBHOOK_SECRET).
 * 3. We map Shippo's status string to a Shopify FulfillmentEventStatus enum.
 * 4. We look up which Shopify shop + fulfillment owns the tracking number
 *    (stored by webhooks.fulfillments.tsx when Shippo created the label).
 * 5. We call Shopify's `fulfillmentEventCreate` GraphQL mutation.
 *
 * ── Setup ───────────────────────────────────────────────────────────────────
 * In Shippo (app.goshippo.com → Settings → Webhooks):
 *   URL: https://YOUR_APP_URL.vercel.app/webhooks/shippo
 *   Event: track_updated
 *
 * HMAC signing requires contacting Shippo support to exchange a secret.
 * They will provide a SHIPPO_WEBHOOK_SECRET — add it to your .env / Vercel.
 * Without it the handler still works but logs a warning (good for local dev).
 */

import type { ActionFunctionArgs } from "@remix-run/node";
import crypto from "node:crypto";
import { unauthenticated } from "../shopify.server";
import db from "../db.server";

// ─── Shippo → Shopify status map ─────────────────────────────────────────────
//
// Shippo top-level statuses (tracking_status.status):
//   UNKNOWN | PRE_TRANSIT | TRANSIT | DELIVERED | RETURNED | FAILURE
//
// Shopify FulfillmentEventStatus enum values (2024-10 API):
//   LABEL_PURCHASED | LABEL_PRINTED | CONFIRMED | IN_TRANSIT |
//   OUT_FOR_DELIVERY | ATTEMPTED_DELIVERY | READY_FOR_PICKUP |
//   DELIVERED | FAILURE
//
// null  →  ignore this event (no meaningful Shopify status to record)

export const SHIPPO_STATUS_MAP: Record<string, string | null> = {
  UNKNOWN: null,
  PRE_TRANSIT: "LABEL_PURCHASED", // Label bought, carrier not yet holding it
  TRANSIT: "IN_TRANSIT",
  DELIVERED: "DELIVERED",
  RETURNED: "FAILURE",
  FAILURE: "FAILURE",
};

// Shippo status_details strings that indicate a more specific Shopify status.
// Checked case-insensitively against the details text when status = TRANSIT.
const TRANSIT_DETAIL_MAP: Array<[RegExp, string]> = [
  [/out.?for.?delivery/i, "OUT_FOR_DELIVERY"],
  [/attempted.?delivery|delivery.?attempt/i, "ATTEMPTED_DELIVERY"],
  [/ready.?for.?pickup|available.?for.?pickup/i, "READY_FOR_PICKUP"],
  [/carrier.?picked.?up|picked.?up.?by/i, "CONFIRMED"],
];

export function refineTransitStatus(statusDetails: string): string {
  for (const [pattern, shopifyStatus] of TRANSIT_DETAIL_MAP) {
    if (pattern.test(statusDetails)) return shopifyStatus;
  }
  return "IN_TRANSIT";
}

// ─── HMAC signature validation ────────────────────────────────────────────────
//
// Shippo signs webhooks with:
//   Header: shippo-auth-signature
//   Format: t=<unix_timestamp>,v1=<hmac_sha256_hex>
//   Signed string: "<timestamp>.<raw_body>"

export function validateShippoSignature(
  rawBody: string,
  signatureHeader: string,
  secret: string
): boolean {
  try {
    // Parse the header fields (t and v1)
    const parts: Record<string, string> = {};
    for (const segment of signatureHeader.split(",")) {
      const eqIdx = segment.indexOf("=");
      if (eqIdx !== -1) {
        parts[segment.slice(0, eqIdx).trim()] = segment.slice(eqIdx + 1).trim();
      }
    }

    const { t: timestamp, v1: receivedSig } = parts;
    if (!timestamp || !receivedSig) return false;

    const expectedSig = crypto
      .createHmac("sha256", secret)
      .update(`${timestamp}.${rawBody}`)
      .digest("hex");

    // timingSafeEqual requires equal-length buffers
    if (expectedSig.length !== receivedSig.length) return false;

    return crypto.timingSafeEqual(
      Buffer.from(expectedSig, "utf8"),
      Buffer.from(receivedSig, "utf8")
    );
  } catch {
    return false;
  }
}

// ─── Shopify mutation ─────────────────────────────────────────────────────────

const CREATE_FULFILLMENT_EVENT = `#graphql
  mutation CreateFulfillmentEvent($fulfillmentEvent: FulfillmentEventInput!) {
    fulfillmentEventCreate(fulfillmentEvent: $fulfillmentEvent) {
      fulfillmentEvent {
        id
        status
        happenedAt
      }
      userErrors {
        field
        message
      }
    }
  }
`;

// ─── Action handler ───────────────────────────────────────────────────────────

export const action = async ({ request }: ActionFunctionArgs) => {
  // Read the raw body first — needed for HMAC validation and JSON parsing
  const rawBody = await request.text();

  // ── Signature validation ──────────────────────────────────────────────────
  const shippoSecret = process.env.SHIPPO_WEBHOOK_SECRET;
  if (shippoSecret) {
    const sigHeader =
      request.headers.get("shippo-auth-signature") ??
      request.headers.get("shippo-signature") ??
      "";

    if (!validateShippoSignature(rawBody, sigHeader, shippoSecret)) {
      console.error("[Shippo webhook] Invalid signature — request rejected");
      return new Response("Invalid signature", { status: 401 });
    }
  } else {
    console.warn(
      "[Shippo webhook] SHIPPO_WEBHOOK_SECRET not set — signature validation skipped. " +
        "Set this in .env to secure your webhook endpoint."
    );
  }

  // ── Parse payload ─────────────────────────────────────────────────────────
  let payload: Record<string, any>;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  // Ignore non-tracking events (batch_created, transaction_created, etc.)
  const eventType: string =
    payload.event_type ?? payload.data?.event_type ?? "";
  if (eventType !== "track_updated") {
    return new Response(null, { status: 200 });
  }

  // ── Extract core fields ───────────────────────────────────────────────────
  const trackingNumber: string =
    payload.tracking_number ?? payload.data?.tracking_number ?? "";

  const trackingStatusObj =
    payload.tracking_status ?? payload.data?.tracking_status ?? {};

  const rawStatus: string = (
    trackingStatusObj.status ?? "UNKNOWN"
  ).toUpperCase();

  const statusDetails: string = trackingStatusObj.status_details ?? "";

  const happenedAt: string =
    trackingStatusObj.object_updated ??
    trackingStatusObj.object_created ??
    new Date().toISOString();

  // ── Map to Shopify status ─────────────────────────────────────────────────
  let shopifyStatus = SHIPPO_STATUS_MAP[rawStatus] ?? null;
  if (shopifyStatus === null) {
    // Nothing meaningful to record
    return new Response(null, { status: 200 });
  }

  // Refine TRANSIT events when the details string hints at a sub-state
  if (shopifyStatus === "IN_TRANSIT" && statusDetails) {
    shopifyStatus = refineTransitStatus(statusDetails);
  }

  if (!trackingNumber) {
    return new Response(null, { status: 200 });
  }

  // ── Look up Shopify fulfillment from our local index ──────────────────────
  const record = await db.trackingRecord.findUnique({
    where: { trackingNumber },
  });

  if (!record) {
    // Could happen if the fulfillments/create webhook fired before the app
    // was installed, or if an order was fulfilled outside Shopify.
    console.warn(
      `[Shippo webhook] No TrackingRecord found for ${trackingNumber}. ` +
        "Ensure the app was installed before this order was fulfilled."
    );
    return new Response(null, { status: 200 });
  }

  // ── Write the FulfillmentEvent to Shopify ─────────────────────────────────
  try {
    const { admin } = await unauthenticated.admin(record.shop);

    const response = await admin.graphql(CREATE_FULFILLMENT_EVENT, {
      variables: {
        fulfillmentEvent: {
          fulfillmentId: record.fulfillmentId,
          status: shopifyStatus,
          happenedAt,
          // Include the status detail text as a timeline message when present
          ...(statusDetails ? { message: statusDetails } : {}),
        },
      },
    });

    const result = await response.json();
    const userErrors: any[] =
      result?.data?.fulfillmentEventCreate?.userErrors ?? [];

    if (userErrors.length > 0) {
      // Log but don't retry — Shopify sometimes rejects duplicate events
      console.error(
        `[Shippo webhook] Shopify userErrors for ${trackingNumber}:`,
        JSON.stringify(userErrors)
      );
    } else {
      const created = result?.data?.fulfillmentEventCreate?.fulfillmentEvent;
      console.info(
        `[Shippo webhook] Created Shopify FulfillmentEvent ` +
          `${created?.id} → ${shopifyStatus} for tracking ${trackingNumber}`
      );
    }
  } catch (err) {
    // Return 200 so Shippo doesn't retry endlessly — the error is logged
    // and the next tracking update will attempt again.
    console.error(
      `[Shippo webhook] Failed to create FulfillmentEvent for ${trackingNumber}:`,
      err
    );
  }

  return new Response(null, { status: 200 });
};
