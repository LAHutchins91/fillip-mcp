import crypto from "node:crypto";
import http, { type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkoutParams, decideBillingAction, verifyStripeSignature, type StripeEvent } from "../src/lib/billing.js";
import { app } from "../src/server.js";

const config = {
  appBaseUrl: "https://fillip.example",
  productId: "prod_fillip",
  monthlyPriceId: "price_fillip_month",
  yearlyPriceId: "price_fillip_year"
};

function subscription(input: { app?: string; product?: string | null; price?: string; status?: string; userId?: string } = {}): StripeEvent {
  const product = input.product === undefined ? config.productId : input.product;
  return {
    type: "customer.subscription.updated",
    data: {
      object: {
        id: "sub_123",
        customer: "cus_123",
        status: input.status ?? "active",
        current_period_end: 1_800_000_000,
        cancel_at_period_end: false,
        metadata: {
          ...(input.app ? { app: input.app } : {}),
          supabase_user_id: input.userId ?? "user-1"
        },
        items: { data: [{ price: { id: input.price ?? config.monthlyPriceId, ...(product ? { product } : {}) } }] }
      }
    }
  };
}

describe("billing webhook filter", () => {
  it("ignores another product even when the price id matches Fillip", () => {
    const action = decideBillingAction(subscription({ app: "fillip", product: "prod_continuity", price: config.monthlyPriceId }), config);
    expect(action).toEqual({ type: "ignore", reason: "other product subscription" });
  });

  it("ignores a subscription that never names Fillip's product", () => {
    const action = decideBillingAction(subscription({ app: "fillip", product: null, price: config.monthlyPriceId }), config);
    expect(action).toMatchObject({ type: "ignore", reason: "other product subscription" });
  });

  it("ignores a Fillip product on a different price", () => {
    const action = decideBillingAction(subscription({ price: "price_other_product" }), config);
    expect(action).toMatchObject({ type: "ignore", reason: "other product price" });
  });

  it("ignores every subscription when Fillip's product id is not configured", () => {
    const action = decideBillingAction(subscription({}), { ...config, productId: "" });
    expect(action).toMatchObject({ type: "ignore", reason: "product is not configured" });
  });

  it("applies Fillip's monthly price as Pro while trialing", () => {
    const action = decideBillingAction(subscription({ status: "trialing" }), config);
    expect(action.type).toBe("subscription");
    if (action.type !== "subscription") return;
    expect(action.userId).toBe("user-1");
    expect(action.patch.plan).toBe("pro");
    expect(action.patch.subscription_status).toBe("trialing");
  });

  it("applies Fillip's yearly price as annual", () => {
    const action = decideBillingAction(subscription({ price: config.yearlyPriceId }), config);
    expect(action.type).toBe("subscription");
    if (action.type !== "subscription") return;
    expect(action.patch.plan).toBe("annual");
  });

  it("drops access when the Fillip subscription is no longer entitled", () => {
    const action = decideBillingAction({ ...subscription({ status: "canceled" }), type: "customer.subscription.deleted" }, config);
    expect(action.type).toBe("subscription");
    if (action.type !== "subscription") return;
    expect(action.patch.plan).toBe("none");
  });

  it("ignores checkout completed for another product", () => {
    const action = decideBillingAction({
      type: "checkout.session.completed",
      data: {
        object: {
          success_url: "https://desk.example/?checkout=success",
          client_reference_id: "user-1",
          metadata: { app: "desk", product: "prod_desk" }
        }
      }
    }, config);
    expect(action).toMatchObject({ type: "ignore" });
  });

  it("records Fillip checkout only", () => {
    const action = decideBillingAction({
      type: "checkout.session.completed",
      data: {
        object: {
          success_url: "https://fillip.example/?checkout=success",
          client_reference_id: "user-1",
          customer: "cus_123",
          subscription: "sub_123",
          metadata: { app: "fillip", product: config.productId, supabase_user_id: "user-1" }
        }
      }
    }, config);
    expect(action).toMatchObject({ type: "checkout", userId: "user-1", customerId: "cus_123", subscriptionId: "sub_123" });
  });

  it("ignores unrelated event types", () => {
    expect(decideBillingAction({ type: "invoice.paid", data: { object: { metadata: { app: "fillip" } } } }, config).type).toBe("ignore");
  });

  it("ignores checkout that names another product", () => {
    const action = decideBillingAction({
      type: "checkout.session.completed",
      data: {
        object: {
          success_url: "https://fillip.example/?checkout=success",
          client_reference_id: "user-1",
          metadata: { app: "fillip", product: "prod_continuity" }
        }
      }
    }, config);
    expect(action).toMatchObject({ type: "ignore", reason: "other product checkout" });
  });

  it("builds checkout with a 14-day trial and no printed amount", () => {
    const params = checkoutParams({
      userId: "user-1",
      email: "owner@example.com",
      priceId: config.monthlyPriceId,
      productId: config.productId,
      appBaseUrl: config.appBaseUrl
    });
    expect(params.get("subscription_data[trial_period_days]")).toBe("14");
    expect(params.get("metadata[app]")).toBe("fillip");
    expect(params.get("metadata[product]")).toBe(config.productId);
    expect(params.get("subscription_data[metadata][product]")).toBe(config.productId);
    expect(params.get("line_items[0][price]")).toBe(config.monthlyPriceId);
    expect(params.get("success_url")).toBe("https://fillip.example/?checkout=success");
    expect([...params.keys()].some((key) => key.includes("unit_amount"))).toBe(false);
  });
});

describe("billing webhook HTTP", () => {
  let server: Server;
  let base: string;
  const webhookSecret = "whsec_test";

  beforeAll(async () => {
    process.env.STRIPE_WEBHOOK_SECRET = webhookSecret;
    process.env.STRIPE_PRODUCT_ID = config.productId;
    process.env.STRIPE_PRICE_MONTHLY = config.monthlyPriceId;
    process.env.STRIPE_PRICE_YEARLY = config.yearlyPriceId;
    await new Promise<void>((resolve) => {
      server = app.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No port");
    base = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  });

  function sign(body: string) {
    const timestamp = Math.floor(Date.now() / 1000);
    const digest = crypto.createHmac("sha256", webhookSecret).update(`${timestamp}.${body}`).digest("hex");
    return `t=${timestamp},v1=${digest}`;
  }

  async function post(body: string, signature?: string) {
    const payload = Buffer.from(body);
    const url = new URL(base);
    return new Promise<{ status: number; text: string }>((resolve, reject) => {
      const req = http.request({
        hostname: url.hostname,
        port: url.port,
        path: "/billing/webhook",
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": payload.length,
          ...(signature ? { "stripe-signature": signature } : {})
        }
      }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf8") }));
      });
      req.on("error", reject);
      req.end(payload);
    });
  }

  it("accepts another product's event and does not try to write a profile", async () => {
    const body = JSON.stringify(subscription({ app: "desk", product: "prod_desk", price: "price_desk" }));
    const response = await post(body, sign(body));
    expect(response.status).toBe(200);
    expect(JSON.parse(response.text)).toEqual({ received: true });
  });

  it("rejects a bad signature", async () => {
    const body = JSON.stringify(subscription({}));
    const response = await post(body, sign(`${body} `));
    expect(response.status).toBe(400);
  });

  it("rejects a missing signature", async () => {
    const response = await post(JSON.stringify(subscription({})));
    expect(response.status).toBe(400);
  });

  it("round-trips a valid signature into the event filter", () => {
    const body = JSON.stringify(subscription({ app: "desk", product: "prod_desk", price: "price_desk" }));
    const event = verifyStripeSignature(Buffer.from(body), sign(body), webhookSecret);
    expect(decideBillingAction(event, config).type).toBe("ignore");
  });
});
