/**
 * webhooks.fulfillments.tsx
 *
 * Handles the Shopify `fulfillments/create` webhook.
 *
 * When Shippo purchases a shipping label for a Shopify order it automatically
 * marks the order as fulfilled in Shopify, which triggers this webhook.
 * We capture the tracking-number → Shopify-Fulfillment-GID mapping so the
 * Shippo `track_updated` webhook handler (webhooks.shippo.tsx) can look it
 * up instantly — no round-trip Shopify query needed at carrier event time.
 */

import { type ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import db from "../db.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { topic, shop, payload } = await authenticate.webhook(request);

  if (topic !== "FULFILLMENTS_CREATE") {
    return new Response("Unexpected topic", { status: 400 });
  }

  const fulfillment = payload as Record<string, any>;

  // Shopify provides the GraphQL GID directly in the REST webhook payload.
  const fulfillmentId: string = fulfillment.admin_graphql_api_id ?? "";
  const orderId = `gid://shopify/Order/${fulfillment.order_id}`;

  // `tracking_numbers` is an array; fall back to the scalar field if absent.
  const trackingNumbers: string[] =
    Array.isArray(fulfillment.tracking_numbers) && fulfillment.tracking_numbers.length > 0
      ? fulfillment.tracking_numbers
      : fulfillment.tracking_number
      ? [fulfillment.tracking_number as string]
      : [];

  if (!fulfillmentId || trackingNumbers.length === 0) {
    // No tracking info — nothing to index.
    return new Response(null, { status: 200 });
  }

  // Upsert so re-delivered webhooks are idempotent.
  await Promise.all(
    trackingNumbers
      .filter((tn) => typeof tn === "string" && tn.trim().length > 0)
      .map((trackingNumber) =>
        db.trackingRecord.upsert({
          where: { trackingNumber },
          create: { trackingNumber, shop, fulfillmentId, orderId },
          update: { fulfillmentId, orderId, shop },
        })
      )
  );

  return new Response(null, { status: 200 });
};
