/**
 * Fulfillment Dashboard — main route
 *
 * Displays a rolling snapshot of recent orders grouped by shipment status,
 * with special alerts for priority (paid-shipping / Amazon) orders.
 *
 * Time period is controlled via the `?period=` query-string param so the
 * view is bookmarkable and shareable.
 */

import { json, type LoaderFunctionArgs } from "@remix-run/node";
import { Form, useLoaderData, useNavigation } from "@remix-run/react";
import {
  Badge,
  Banner,
  BlockStack,
  Box,
  Button,
  ButtonGroup,
  Card,
  Divider,
  EmptyState,
  IndexTable,
  InlineStack,
  Layout,
  Page,
  SkeletonBodyText,
  SkeletonDisplayText,
  Text,
  Tooltip,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";

// ─── Types ───────────────────────────────────────────────────────────────────

type TimePeriod = "24h" | "48h" | "1w";

/**
 * Granular shipment progress mapped from Shopify FulfillmentEvent statuses.
 * Falls back gracefully when a carrier doesn't push tracking updates.
 */
type ShipmentStatus =
  | "unfulfilled"       // No fulfillment attempted yet
  | "label_created"     // Label purchased / printed, not yet picked up
  | "accepted_by_carrier" // Carrier has picked up the package
  | "in_transit"        // Package is moving toward destination
  | "delivered"         // Successfully delivered
  | "delivery_issue"    // Delivery failed / returned
  | "in_progress";      // Fulfillment started but status unknown

interface ProcessedOrder {
  id: string;
  name: string;
  createdAt: string;
  customer: string;
  itemsSummary: string;
  shippingMethod: string;
  revenue: number;
  currency: string;
  isPriority: boolean;
  priorityReason: string;
  status: ShipmentStatus;
  trackingNumber: string | null;
  trackingUrl: string | null;
}

interface StatusBreakdown {
  unfulfilled: number;
  label_created: number;
  accepted_by_carrier: number;
  in_transit: number;
  delivered: number;
  delivery_issue: number;
  in_progress: number;
}

interface DashboardData {
  period: TimePeriod;
  totalOrders: number;
  totalRevenue: number;
  currency: string;
  priorityCount: number;
  priorityUnfulfilledCount: number;
  statusBreakdown: StatusBreakdown;
  orders: ProcessedOrder[];
}

// ─── GraphQL query ────────────────────────────────────────────────────────────

/**
 * Fetches all orders within the selected window.
 *
 * Notes:
 *  - `fulfillments` on Order is a plain array, not a Relay connection.
 *  - `fulfillments.events` IS a connection and requires `first:`.
 *  - `fulfillments.trackingInfo` is a plain array.
 *  - `channelInformation` identifies orders from external sales channels
 *    (e.g. Amazon via Marketplace Connect / CedCommerce / Codisto).
 */
const ORDERS_QUERY = `#graphql
  query FulfillmentDashboard($query: String!, $first: Int!) {
    orders(
      first: $first
      sortKey: CREATED_AT
      reverse: true
      query: $query
    ) {
      edges {
        node {
          id
          name
          createdAt
          displayFulfillmentStatus
          tags
          totalPriceSet {
            shopMoney { amount currencyCode }
          }
          shippingLines(first: 5) {
            edges {
              node {
                title
                discountedPriceSet {
                  shopMoney { amount }
                }
              }
            }
          }
          fulfillments {
            id
            status
            trackingInfo {
              number
              company
              url
            }
            events(first: 10, sortKey: HAPPENED_AT, reverse: true) {
              edges {
                node {
                  status
                  happenedAt
                }
              }
            }
          }
          channelInformation {
            channelDefinition {
              channelName
              handle
            }
          }
          customer {
            displayName
            email
          }
          lineItems(first: 4) {
            edges {
              node {
                title
                quantity
              }
            }
          }
        }
      }
    }
  }
`;

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Derive a fine-grained shipment status from Shopify order data.
 *
 * The `FulfillmentEvent` records are the most accurate source when the store
 * uses Shopify Shipping or an app that pushes tracking events back to the
 * Admin API.  When no events are present we fall back to inferring status
 * from the existence of a tracking number.
 */
export function resolveShipmentStatus(order: Record<string, any>): ShipmentStatus {
  const displayStatus: string = order.displayFulfillmentStatus ?? "";

  // Orders that haven't entered the fulfillment workflow at all
  if (
    displayStatus === "UNFULFILLED" ||
    displayStatus === "ON_HOLD" ||
    displayStatus === "SCHEDULED"
  ) {
    return "unfulfilled";
  }

  const fulfillments: any[] = order.fulfillments ?? [];
  if (fulfillments.length === 0) return "unfulfilled";

  // Walk every fulfillment.  We sorted events descending so the first event
  // in the first fulfillment is the most recent overall.
  let latestEventStatus: string | null = null;
  let hasTrackingNumber = false;

  for (const fulfillment of fulfillments) {
    if ((fulfillment.trackingInfo ?? []).length > 0) {
      hasTrackingNumber = true;
    }

    const events: any[] = fulfillment.events?.edges ?? [];
    if (events.length > 0 && latestEventStatus === null) {
      latestEventStatus = events[0].node.status;
    }
  }

  if (latestEventStatus) {
    switch (latestEventStatus) {
      case "LABEL_PURCHASED":
      case "LABEL_PRINTED":
        return "label_created";

      case "CONFIRMED":
      case "CARRIER_PICKED_UP":
        return "accepted_by_carrier";

      case "IN_TRANSIT":
      case "OUT_FOR_DELIVERY":
      case "READY_FOR_PICKUP":
      case "ATTEMPTED_DELIVERY":
        return "in_transit";

      case "DELIVERED":
        return "delivered";

      case "FAILURE":
      case "LABEL_VOIDED":
        return "delivery_issue";

      default:
        // Unknown event — treat as label created if we at least have tracking
        return hasTrackingNumber ? "label_created" : "in_progress";
    }
  }

  // No events recorded.  If a tracking number exists the label was at least created.
  if (hasTrackingNumber) return "label_created";

  // Fulfillment record exists but no tracking yet — partially in progress
  return "in_progress";
}

/**
 * Returns `true` (plus a human-readable reason) when an order should be
 * highlighted as priority/expedited:
 *   1. Customer paid for shipping (any non-zero shipping line cost), OR
 *   2. Order originated from Amazon (tag or channel name contains "amazon").
 */
export function resolvePriority(
  order: Record<string, any>
): { isPriority: boolean; reason: string } {
  // --- Paid shipping check ---
  const shippingEdges: any[] = order.shippingLines?.edges ?? [];
  for (const { node: line } of shippingEdges) {
    const amount = parseFloat(
      line.discountedPriceSet?.shopMoney?.amount ?? "0"
    );
    if (amount > 0) {
      return { isPriority: true, reason: `Paid shipping: ${line.title}` };
    }
  }

  // --- Amazon channel check (tag-based — most portable across connectors) ---
  const tags: string[] = order.tags ?? [];
  if (tags.some((t) => t.toLowerCase().includes("amazon"))) {
    return { isPriority: true, reason: "Amazon order" };
  }

  // --- Amazon channel check (via Marketplace Connect / Codisto channel info) ---
  const channelName: string =
    order.channelInformation?.channelDefinition?.channelName ?? "";
  const channelHandle: string =
    order.channelInformation?.channelDefinition?.handle ?? "";
  if (
    channelName.toLowerCase().includes("amazon") ||
    channelHandle.toLowerCase().includes("amazon")
  ) {
    return { isPriority: true, reason: "Amazon channel" };
  }

  return { isPriority: false, reason: "" };
}

/** ISO date string → compact relative label ("2h ago", "3d ago") */
export function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(ms / 60_000);
  const hours = Math.floor(mins / 60);
  const days = Math.floor(hours / 24);
  if (days > 0) return `${days}d ago`;
  if (hours > 0) return `${hours}h ago`;
  return `${Math.max(1, mins)}m ago`;
}

export function formatCurrency(amount: number, currency: string): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(amount);
}

// ─── Loader ───────────────────────────────────────────────────────────────────

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin } = await authenticate.admin(request);

  const url = new URL(request.url);
  const rawPeriod = url.searchParams.get("period");
  const period: TimePeriod =
    rawPeriod === "48h" || rawPeriod === "1w" ? rawPeriod : "24h";

  const hoursBack = period === "24h" ? 24 : period === "48h" ? 48 : 168;
  const startDate = new Date(Date.now() - hoursBack * 60 * 60 * 1000);

  // Shopify query string syntax — ISO 8601 timestamps work here.
  const queryFilter = `created_at:>='${startDate.toISOString()}'`;

  const response = await admin.graphql(ORDERS_QUERY, {
    variables: { first: 250, query: queryFilter },
  });

  const { data } = await response.json();
  const rawOrders: any[] = (data?.orders?.edges ?? []).map(
    ({ node }: any) => node
  );

  // ── Process each order ──────────────────────────────────────────────────
  const orders: ProcessedOrder[] = rawOrders.map((order) => {
    const { isPriority, reason: priorityReason } = resolvePriority(order);
    const status = resolveShipmentStatus(order);

    // Summarise line items to a compact string
    const lineItems: any[] = (order.lineItems?.edges ?? []).map(
      ({ node }: any) => node
    );
    const itemsSummary =
      lineItems
        .slice(0, 3)
        .map((li) => `${li.quantity}× ${li.title}`)
        .join(", ") + (lineItems.length > 3 ? ` +${lineItems.length - 3} more` : "");

    // First shipping line name
    const firstShipping = order.shippingLines?.edges?.[0]?.node;
    const shippingMethod = firstShipping?.title ?? "No shipping";

    // First tracking info across fulfillments
    const firstTracking = order.fulfillments
      ?.flatMap((f: any) => f.trackingInfo ?? [])
      .find(Boolean);

    return {
      id: order.id,
      name: order.name,
      createdAt: order.createdAt,
      customer:
        order.customer?.displayName ||
        order.customer?.email ||
        "Guest",
      itemsSummary,
      shippingMethod,
      revenue: parseFloat(order.totalPriceSet.shopMoney.amount),
      currency: order.totalPriceSet.shopMoney.currencyCode,
      isPriority,
      priorityReason,
      status,
      trackingNumber: firstTracking?.number ?? null,
      trackingUrl: firstTracking?.url ?? null,
    };
  });

  // ── Aggregate stats ─────────────────────────────────────────────────────
  const totalRevenue = orders.reduce((sum, o) => sum + o.revenue, 0);
  const currency = orders[0]?.currency ?? "USD";
  const priorityCount = orders.filter((o) => o.isPriority).length;
  const priorityUnfulfilledCount = orders.filter(
    (o) => o.isPriority && o.status === "unfulfilled"
  ).length;

  const statusBreakdown: StatusBreakdown = {
    unfulfilled: 0,
    label_created: 0,
    accepted_by_carrier: 0,
    in_transit: 0,
    delivered: 0,
    delivery_issue: 0,
    in_progress: 0,
  };
  for (const o of orders) {
    statusBreakdown[o.status]++;
  }

  return json<DashboardData>({
    period,
    totalOrders: orders.length,
    totalRevenue,
    currency,
    priorityCount,
    priorityUnfulfilledCount,
    statusBreakdown,
    orders,
  });
};

// ─── Status display config ────────────────────────────────────────────────────

type PolarisStatusTone =
  | "info"
  | "success"
  | "warning"
  | "critical"
  | "new"
  | undefined;

interface StatusConfig {
  label: string;
  tone: PolarisStatusTone;
  description: string;
}

const STATUS_CONFIG: Record<ShipmentStatus, StatusConfig> = {
  unfulfilled: {
    label: "Unfulfilled",
    tone: "critical",
    description: "Awaiting fulfillment",
  },
  label_created: {
    label: "Label Created",
    tone: "info",
    description: "Label printed / tracking issued",
  },
  accepted_by_carrier: {
    label: "With Carrier",
    tone: "info",
    description: "Carrier has picked it up",
  },
  in_transit: {
    label: "In Transit",
    tone: "new",
    description: "On its way",
  },
  delivered: {
    label: "Delivered",
    tone: "success",
    description: "Delivered to customer",
  },
  delivery_issue: {
    label: "Issue",
    tone: "warning",
    description: "Delivery failed or voided",
  },
  in_progress: {
    label: "In Progress",
    tone: undefined,
    description: "Fulfillment started",
  },
};

// Status cards shown in the breakdown grid, in logical pipeline order
const STATUS_ORDER: ShipmentStatus[] = [
  "unfulfilled",
  "label_created",
  "accepted_by_carrier",
  "in_transit",
  "delivered",
  "delivery_issue",
];

// ─── Period selector helpers ──────────────────────────────────────────────────

const PERIODS: { label: string; value: TimePeriod; title: string }[] = [
  { label: "Last 24h", value: "24h", title: "Last 24 hours" },
  { label: "Last 48h", value: "48h", title: "Last 48 hours" },
  { label: "Last Week", value: "1w", title: "Last 7 days" },
];

// ─── Component ────────────────────────────────────────────────────────────────

export default function Dashboard() {
  const data = useLoaderData<typeof loader>();
  const navigation = useNavigation();
  const isLoading = navigation.state === "loading";

  const periodTitle =
    PERIODS.find((p) => p.value === data.period)?.title ?? "recent";

  return (
    <Page
      title="Fulfillment Dashboard"
      subtitle={`Orders · ${periodTitle}`}
    >
      <BlockStack gap="500">
        {/* ── Period selector ── */}
        <Card>
          <InlineStack gap="300" align="start" blockAlign="center">
            <Text as="span" variant="bodyMd" fontWeight="semibold">
              Time period:
            </Text>
            <ButtonGroup variant="segmented">
              {PERIODS.map(({ label, value }) => (
                <Form key={value} method="get" action="/app">
                  <input type="hidden" name="period" value={value} />
                  <Button
                    submit
                    variant={data.period === value ? "primary" : "secondary"}
                    size="slim"
                    loading={isLoading && navigation.location?.search?.includes(`period=${value}`)}
                  >
                    {label}
                  </Button>
                </Form>
              ))}
            </ButtonGroup>
          </InlineStack>
        </Card>

        {/* ── Priority alert banner ── */}
        {data.priorityUnfulfilledCount > 0 && (
          <Banner
            title={`${data.priorityUnfulfilledCount} priority order${data.priorityUnfulfilledCount > 1 ? "s" : ""} awaiting fulfillment`}
            tone="warning"
          >
            <p>
              {data.priorityUnfulfilledCount > 1
                ? "These orders have"
                : "This order has"}{" "}
              expedited shipping or came from Amazon and{" "}
              {data.priorityUnfulfilledCount > 1 ? "have" : "has"} not yet been
              fulfilled. Scroll down to the orders table and filter by{" "}
              <strong>Priority</strong> to act on them.
            </p>
          </Banner>
        )}

        {/* ── Top-line summary stats ── */}
        {isLoading ? (
          <Layout>
            {[1, 2, 3].map((n) => (
              <Layout.Section variant="oneThird" key={n}>
                <Card>
                  <BlockStack gap="200">
                    <SkeletonDisplayText size="small" />
                    <SkeletonBodyText lines={1} />
                  </BlockStack>
                </Card>
              </Layout.Section>
            ))}
          </Layout>
        ) : (
          <Layout>
            <Layout.Section variant="oneThird">
              <Card>
                <BlockStack gap="100">
                  <Text as="h3" variant="headingSm" tone="subdued">
                    Total Orders
                  </Text>
                  <Text as="p" variant="heading2xl" fontWeight="bold">
                    {data.totalOrders}
                  </Text>
                  <Text as="span" variant="bodySm" tone="subdued">
                    {periodTitle}
                  </Text>
                </BlockStack>
              </Card>
            </Layout.Section>

            <Layout.Section variant="oneThird">
              <Card>
                <BlockStack gap="100">
                  <Text as="h3" variant="headingSm" tone="subdued">
                    Total Revenue
                  </Text>
                  <Text as="p" variant="heading2xl" fontWeight="bold">
                    {formatCurrency(data.totalRevenue, data.currency)}
                  </Text>
                  <Text as="span" variant="bodySm" tone="subdued">
                    {periodTitle}
                  </Text>
                </BlockStack>
              </Card>
            </Layout.Section>

            <Layout.Section variant="oneThird">
              <Card>
                <BlockStack gap="100">
                  <Text as="h3" variant="headingSm" tone="subdued">
                    Priority Orders ⚡
                  </Text>
                  <Text
                    as="p"
                    variant="heading2xl"
                    fontWeight="bold"
                    tone={data.priorityCount > 0 ? "critical" : undefined}
                  >
                    {data.priorityCount}
                  </Text>
                  <Text as="span" variant="bodySm" tone="subdued">
                    Paid shipping or Amazon
                  </Text>
                </BlockStack>
              </Card>
            </Layout.Section>
          </Layout>
        )}

        {/* ── Fulfillment status breakdown ── */}
        <Card>
          <BlockStack gap="400">
            <Text as="h2" variant="headingMd">
              Fulfillment Pipeline
            </Text>
            <Divider />
            <Layout>
              {STATUS_ORDER.map((statusKey) => {
                const cfg = STATUS_CONFIG[statusKey];
                const count = data.statusBreakdown[statusKey];
                return (
                  <Layout.Section variant="oneThird" key={statusKey}>
                    <Box
                      background="bg-surface-secondary"
                      padding="400"
                      borderRadius="200"
                    >
                      <BlockStack gap="200">
                        <Badge tone={cfg.tone}>{cfg.label}</Badge>
                        <Text as="p" variant="heading2xl" fontWeight="bold">
                          {count}
                        </Text>
                        <Text as="span" variant="bodySm" tone="subdued">
                          {cfg.description}
                        </Text>
                      </BlockStack>
                    </Box>
                  </Layout.Section>
                );
              })}
            </Layout>
          </BlockStack>
        </Card>

        {/* ── Orders table ── */}
        <Card padding="0">
          {data.orders.length === 0 ? (
            <EmptyState heading="No orders in this period" image="">
              <p>Try selecting a longer time range above.</p>
            </EmptyState>
          ) : (
            <IndexTable
              resourceName={{ singular: "order", plural: "orders" }}
              itemCount={data.orders.length}
              selectable={false}
              headings={[
                { title: "Order" },
                { title: "Age" },
                { title: "Customer" },
                { title: "Items" },
                { title: "Shipping" },
                { title: "Status" },
                { title: "Tracking" },
                { title: "Revenue", alignment: "end" },
              ]}
            >
              {data.orders.map((order, index) => {
                const cfg = STATUS_CONFIG[order.status];
                return (
                  <IndexTable.Row
                    id={order.id}
                    key={order.id}
                    position={index}
                  >
                    {/* Order number */}
                    <IndexTable.Cell>
                      <Text as="span" fontWeight="semibold">
                        {order.name}
                      </Text>
                    </IndexTable.Cell>

                    {/* Age */}
                    <IndexTable.Cell>
                      <Text as="span" tone="subdued" variant="bodySm">
                        {timeAgo(order.createdAt)}
                      </Text>
                    </IndexTable.Cell>

                    {/* Customer */}
                    <IndexTable.Cell>
                      <Text as="span" variant="bodySm">
                        {order.customer}
                      </Text>
                    </IndexTable.Cell>

                    {/* Items */}
                    <IndexTable.Cell>
                      <Text as="span" variant="bodySm">
                        {order.itemsSummary}
                      </Text>
                    </IndexTable.Cell>

                    {/* Shipping method + priority flag */}
                    <IndexTable.Cell>
                      <InlineStack gap="100" wrap={false} blockAlign="center">
                        {order.isPriority && (
                          <Tooltip content={order.priorityReason}>
                            <Badge tone="critical" size="small">
                              ⚡ Priority
                            </Badge>
                          </Tooltip>
                        )}
                        <Text as="span" variant="bodySm">
                          {order.shippingMethod}
                        </Text>
                      </InlineStack>
                    </IndexTable.Cell>

                    {/* Fulfillment status */}
                    <IndexTable.Cell>
                      <Badge tone={cfg.tone}>{cfg.label}</Badge>
                    </IndexTable.Cell>

                    {/* Tracking number (linked if URL available) */}
                    <IndexTable.Cell>
                      {order.trackingNumber ? (
                        order.trackingUrl ? (
                          <a
                            href={order.trackingUrl}
                            target="_blank"
                            rel="noreferrer"
                            style={{ fontSize: "var(--p-font-size-300)" }}
                          >
                            {order.trackingNumber}
                          </a>
                        ) : (
                          <Text as="span" variant="bodySm">
                            {order.trackingNumber}
                          </Text>
                        )
                      ) : (
                        <Text as="span" tone="subdued" variant="bodySm">
                          —
                        </Text>
                      )}
                    </IndexTable.Cell>

                    {/* Revenue */}
                    <IndexTable.Cell flush>
                      <Text
                        as="span"
                        variant="bodySm"
                        fontWeight="semibold"
                        alignment="end"
                      >
                        {formatCurrency(order.revenue, order.currency)}
                      </Text>
                    </IndexTable.Cell>
                  </IndexTable.Row>
                );
              })}
            </IndexTable>
          )}
        </Card>
      </BlockStack>
    </Page>
  );
}
