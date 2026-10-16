import crypto from "node:crypto";

export const FILLIP_APP = "fillip";

export type JsonObject = Record<string, unknown>;

export type StripeEvent = {
  type: string;
  data: { object: JsonObject };
};

export type BillingConfig = {
  appBaseUrl: string;
  productId: string;
  monthlyPriceId: string;
  yearlyPriceId: string;
};

export type ProfilePatch = {
  plan: "pro" | "annual" | "free";
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  subscription_status: string;
  current_period_end: string | null;
  cancel_at_period_end: boolean;
};

export type BillingAction =
  | { type: "ignore"; reason: string }
  | { type: "checkout"; userId: string; customerId: string | null; subscriptionId: string | null }
  | { type: "subscription"; userId: string; patch: ProfilePatch };

function asObject(value: unknown): JsonObject {
  return value && typeof value === "object" ? value as JsonObject : {};
}

function meta(object: JsonObject): JsonObject {
  return asObject(object.metadata);
}

export function priceIdOf(object: JsonObject): string | null {
  const items = asObject(object.items);
  const data = Array.isArray(items.data) ? items.data : [];
  const first = asObject(data[0]);
  const price = first.price;
  if (typeof price === "string" && price) return price;
  if (price && typeof price === "object" && typeof (price as JsonObject).id === "string") return (price as JsonObject).id as string;
  return null;
}

function ourPrices(config: BillingConfig): string[] {
  return [config.monthlyPriceId, config.yearlyPriceId].filter((price) => price.length > 0);
}

function idOf(value: unknown): string | null {
  if (typeof value === "string" && value) return value;
  if (value && typeof value === "object" && typeof (value as JsonObject).id === "string") return (value as JsonObject).id as string;
  return null;
}

/** Product ids attached to a Stripe object. Checkout sessions carry the one we stamp; subscriptions carry price.product. */
export function productIdsOf(object: JsonObject): string[] {
  const found: string[] = [];
  const push = (value: unknown) => {
    const id = idOf(value);
    if (id && !found.includes(id)) found.push(id);
  };
  const lists = [asObject(object.items).data, asObject(object.line_items).data];
  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      const row = asObject(item);
      const price = asObject(row.price);
      push(price.product);
      push(asObject(row.plan).product);
    }
  }
  push(meta(object).product);
  return found;
}

function isFillipProduct(object: JsonObject, config: BillingConfig): boolean {
  if (!config.productId) return false;
  const products = productIdsOf(object);
  return products.length > 0 && products.every((id) => id === config.productId);
}

/**
 * Fillip has its own Stripe product. Events for any other product on the same account are ignored,
 * including when they reuse a price id string or stamp metadata.app.
 */
export function decideBillingAction(event: StripeEvent, config: BillingConfig): BillingAction {
  const object = event.data?.object ?? {};
  if (!config.productId) return { type: "ignore", reason: "product is not configured" };
  if (event.type === "checkout.session.completed") {
    const success = typeof object.success_url === "string" ? object.success_url : "";
    const base = config.appBaseUrl.replace(/\/$/, "");
    const ownCheckout = success === base || success.startsWith(`${base}/`);
    if (!ownCheckout || !isFillipProduct(object, config)) return { type: "ignore", reason: "other product checkout" };
    const userId = typeof object.client_reference_id === "string" ? object.client_reference_id : "";
    if (!userId) return { type: "ignore", reason: "missing user" };
    return {
      type: "checkout",
      userId,
      customerId: typeof object.customer === "string" ? object.customer : null,
      subscriptionId: typeof object.subscription === "string" ? object.subscription : null
    };
  }
  if (event.type === "customer.subscription.created" || event.type === "customer.subscription.updated" || event.type === "customer.subscription.deleted") {
    if (!isFillipProduct(object, config)) return { type: "ignore", reason: "other product subscription" };
    const priceId = priceIdOf(object);
    const prices = ourPrices(config);
    if (!priceId || !prices.includes(priceId)) return { type: "ignore", reason: "other product price" };
    const userId = typeof meta(object).supabase_user_id === "string" ? String(meta(object).supabase_user_id) : "";
    if (!userId) return { type: "ignore", reason: "missing user" };
    const status = typeof object.status === "string" ? object.status : "unknown";
    const entitled = status === "active" || status === "trialing";
    const plan = !entitled ? "free" : priceId === config.yearlyPriceId ? "annual" : "pro";
    const periodEnd = typeof object.current_period_end === "number" ? new Date(object.current_period_end * 1000).toISOString() : null;
    return {
      type: "subscription",
      userId,
      patch: {
        plan,
        stripe_customer_id: typeof object.customer === "string" ? object.customer : null,
        stripe_subscription_id: typeof object.id === "string" ? object.id : null,
        subscription_status: status,
        current_period_end: periodEnd,
        cancel_at_period_end: Boolean(object.cancel_at_period_end)
      }
    };
  }
  return { type: "ignore", reason: "unhandled event" };
}

export function checkoutParams(input: {
  userId: string;
  email?: string | null;
  customerId?: string | null;
  priceId: string;
  productId: string;
  appBaseUrl: string;
}): URLSearchParams {
  const base = input.appBaseUrl.replace(/\/$/, "");
  const params = new URLSearchParams();
  params.set("mode", "subscription");
  params.set("automatic_tax[enabled]", "true");
  params.set("line_items[0][price]", input.priceId);
  params.set("line_items[0][quantity]", "1");
  params.set("client_reference_id", input.userId);
  params.set("metadata[supabase_user_id]", input.userId);
  params.set("metadata[app]", FILLIP_APP);
  params.set("metadata[product]", input.productId);
  params.set("subscription_data[metadata][supabase_user_id]", input.userId);
  params.set("subscription_data[metadata][app]", FILLIP_APP);
  params.set("subscription_data[metadata][product]", input.productId);
  params.set("subscription_data[trial_period_days]", "14");
  params.set("payment_method_collection", "always");
  params.set("success_url", `${base}/?checkout=success`);
  params.set("cancel_url", `${base}/?checkout=cancelled`);
  if (input.customerId) {
    params.set("customer", input.customerId);
    params.set("customer_update[address]", "auto");
  } else if (input.email) params.set("customer_email", input.email);
  return params;
}

export function verifyStripeSignature(rawBody: Buffer, signatureHeader: string, secret: string, nowMs = Date.now()): StripeEvent {
  if (!secret) throw new Error("Missing Stripe webhook secret");
  const fields = signatureHeader.split(",").map((part) => part.trim());
  const timestamp = fields.find((part) => part.startsWith("t="))?.slice(2);
  const signatures = fields.filter((part) => part.startsWith("v1=")).map((part) => part.slice(3));
  if (!timestamp || !/^\d+$/.test(timestamp) || signatures.length === 0) throw new Error("Malformed Stripe signature");
  if (Math.abs(nowMs / 1000 - Number(timestamp)) > 300) throw new Error("Expired Stripe signature");
  const expected = crypto.createHmac("sha256", secret).update(`${timestamp}.${rawBody.toString("utf8")}`).digest("hex");
  const valid = signatures.some((signature) => signature.length === expected.length && crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected)));
  if (!valid) throw new Error("Invalid Stripe signature");
  return JSON.parse(rawBody.toString("utf8")) as StripeEvent;
}

export function billingConfigFromEnv(env: NodeJS.ProcessEnv = process.env): BillingConfig {
  return {
    appBaseUrl: (env.APP_BASE_URL ?? "http://localhost:3000").replace(/\/$/, ""),
    productId: env.STRIPE_PRODUCT_ID ?? "",
    monthlyPriceId: env.STRIPE_PRICE_MONTHLY ?? "",
    yearlyPriceId: env.STRIPE_PRICE_YEARLY ?? ""
  };
}
