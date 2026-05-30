import Stripe from "stripe";
import { config, stripeEnabled } from "./config.js";
import {
  getAccountByKey,
  getAccountById,
  getAccountByCustomerId,
  setStripeCustomer,
  setPlan,
} from "./db.js";

const stripe = stripeEnabled ? new Stripe(config.stripe.secretKey) : null;

// Create a Checkout Session for the account identified by apiKey.
export async function createCheckout(apiKey) {
  if (!stripe) throw new Error("Stripe is not configured.");
  const account = getAccountByKey(apiKey);
  if (!account) throw new Error("Unknown API key.");

  let customerId = account.stripe_customer_id;
  if (!customerId) {
    const customer = await stripe.customers.create({
      email: account.email,
      metadata: { account_id: account.id },
    });
    customerId = customer.id;
    setStripeCustomer(account.id, customerId);
  }

  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    customer: customerId,
    line_items: [{ price: config.stripe.priceId, quantity: 1 }],
    success_url: `${config.baseUrl}/#dashboard?upgraded=1`,
    cancel_url: `${config.baseUrl}/#pricing`,
    metadata: { account_id: account.id },
  });
  return session.url;
}

// Create a Billing Portal session so customers can manage/cancel.
export async function createPortal(apiKey) {
  if (!stripe) throw new Error("Stripe is not configured.");
  const account = getAccountByKey(apiKey);
  if (!account?.stripe_customer_id) throw new Error("No subscription found.");
  const session = await stripe.billingPortal.sessions.create({
    customer: account.stripe_customer_id,
    return_url: `${config.baseUrl}/#dashboard`,
  });
  return session.url;
}

// Verify and handle a Stripe webhook. `rawBody` must be the raw Buffer.
export function handleWebhook(rawBody, signature) {
  if (!stripe) throw new Error("Stripe is not configured.");
  const event = stripe.webhooks.constructEvent(
    rawBody,
    signature,
    config.stripe.webhookSecret,
  );

  const obj = event.data.object;

  switch (event.type) {
    case "checkout.session.completed": {
      const accountId = obj.metadata?.account_id;
      let account = accountId ? getAccountById(accountId) : null;
      if (!account && obj.customer) account = getAccountByCustomerId(obj.customer);
      if (account) {
        if (obj.customer) setStripeCustomer(account.id, obj.customer);
        setPlan(account.id, "pro", obj.subscription || null);
        console.log(`[stripe] checkout completed -> pro: ${account.email}`);
      } else {
        console.warn(
          `[stripe] checkout completed but no account matched (account_id=${accountId}, customer=${obj.customer})`,
        );
      }
      break;
    }
    case "customer.subscription.created":
    case "customer.subscription.updated": {
      const account = getAccountByCustomerId(obj.customer);
      if (account) {
        const active = obj.status === "active" || obj.status === "trialing";
        setPlan(account.id, active ? "pro" : "free", obj.id);
        console.log(`[stripe] subscription ${obj.status} -> ${active ? "pro" : "free"}: ${account.email}`);
      } else {
        console.warn(`[stripe] subscription event, no account for customer=${obj.customer}`);
      }
      break;
    }
    case "customer.subscription.deleted": {
      const account = getAccountByCustomerId(obj.customer);
      if (account) {
        setPlan(account.id, "free", null);
        console.log(`[stripe] subscription deleted -> free: ${account.email}`);
      }
      break;
    }
  }
  return event.type;
}

export { stripeEnabled };
