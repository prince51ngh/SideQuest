// Stripe calls this when a payment succeeds. This is the ONLY thing that marks a
// deposit as paid, so nobody can fake a payment from the browser.
// Deploy with --no-verify-jwt: Stripe does not send a Supabase login token,
// the request is trusted because its signature is checked below.
import Stripe from "npm:stripe@17";
import { adminClient, stripeClient } from "../_shared/util.ts";
import { processRefunds } from "../_shared/refunds.ts";

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });

  const stripe = stripeClient();
  const signature = req.headers.get("stripe-signature");
  const secret = Deno.env.get("STRIPE_WEBHOOK_SECRET");
  if (!signature || !secret) return new Response("Not configured", { status: 400 });

  const rawBody = await req.text();
  let event: Stripe.Event;
  try {
    event = await stripe.webhooks.constructEventAsync(
      rawBody,
      signature,
      secret,
      undefined,
      Stripe.createSubtleCryptoProvider(),
    );
  } catch (_) {
    return new Response("Bad signature", { status: 400 });
  }

  try {
    if (
      event.type === "checkout.session.completed" ||
      event.type === "checkout.session.async_payment_succeeded"
    ) {
      const session = event.data.object as Stripe.Checkout.Session;
      // Bank transfers (FPX) can complete later; wait for the success event in that case.
      if (session.payment_status !== "paid") return Response.json({ received: true });

      const depositId = session.metadata?.deposit_id;
      const paymentIntent = typeof session.payment_intent === "string"
        ? session.payment_intent
        : session.payment_intent?.id ?? null;
      if (!depositId || !paymentIntent) return Response.json({ received: true });

      const admin = adminClient();
      const { data: result, error } = await admin.rpc("mark_deposit_paid", {
        p_deposit: depositId,
        p_payment_intent: paymentIntent,
        p_session: session.id,
      });
      if (error) throw error;

      if (result === "needs_refund") {
        // Paid after the task stopped waiting for it: give the money straight back.
        await processRefunds(admin, stripe, { depositId });
      } else if (result === "duplicate") {
        // Paid twice for one deposit: refund the extra payment.
        await stripe.refunds.create(
          { payment_intent: paymentIntent, metadata: { deposit_id: depositId, reason: "duplicate" } },
          { idempotencyKey: `dup-${paymentIntent}` },
        );
      }
    } else if (event.type === "refund.failed") {
      // Bank refunds (FPX) finish days later and can still fail. Flag it so the team
      // sees it under "Needs attention" in the admin page and pays the person back another way.
      const refund = event.data.object as Stripe.Refund;
      await adminClient()
        .from("deposits")
        .update({
          last_error: `The bank rejected this refund (${refund.failure_reason ?? "no reason given"}). Pay the person back another way.`,
        })
        .eq("stripe_refund_id", refund.id);
    }
    return Response.json({ received: true });
  } catch (e) {
    console.error("webhook failed", e);
    // A 500 makes Stripe retry later, which is what we want.
    return new Response("Webhook handler failed", { status: 500 });
  }
});
