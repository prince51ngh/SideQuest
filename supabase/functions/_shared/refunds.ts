// Sends queued refunds to Stripe. A deposit is 'refund_pending' once the database
// has decided it goes back to its owner; this is what actually moves the money.
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import type Stripe from "npm:stripe@17";

export type RefundSummary = { refunded: number; failed: number };

export async function processRefunds(
  admin: SupabaseClient,
  stripe: Stripe,
  filter: { taskId?: string; depositId?: string } = {},
): Promise<RefundSummary> {
  let q = admin
    .from("deposits")
    .select("id, stripe_payment_intent_id")
    .eq("status", "refund_pending");
  if (filter.taskId) q = q.eq("task_id", filter.taskId);
  if (filter.depositId) q = q.eq("id", filter.depositId);

  const { data, error } = await q.limit(50);
  if (error) throw error;

  const summary: RefundSummary = { refunded: 0, failed: 0 };

  for (const d of data ?? []) {
    if (!d.stripe_payment_intent_id) {
      summary.failed++;
      await admin.from("deposits").update({ last_error: "No payment on record to refund" }).eq("id", d.id);
      continue;
    }
    try {
      // The idempotency key means a retry can never refund the same deposit twice.
      const refund = await stripe.refunds.create(
        { payment_intent: d.stripe_payment_intent_id, metadata: { deposit_id: d.id } },
        { idempotencyKey: `refund-${d.id}` },
      );
      await admin
        .from("deposits")
        .update({
          status: "refunded",
          stripe_refund_id: refund.id,
          refunded_at: new Date().toISOString(),
          last_error: null,
        })
        .eq("id", d.id)
        .eq("status", "refund_pending");
      summary.refunded++;
    } catch (e) {
      const err = e as { code?: string; message?: string };
      if (err.code === "charge_already_refunded") {
        // Someone already refunded it from the Stripe dashboard.
        await admin
          .from("deposits")
          .update({ status: "refunded", refunded_at: new Date().toISOString(), last_error: null })
          .eq("id", d.id)
          .eq("status", "refund_pending");
        summary.refunded++;
      } else {
        summary.failed++;
        await admin.from("deposits").update({ last_error: (err.message ?? "Refund failed").slice(0, 300) }).eq("id", d.id);
      }
    }
  }
  return summary;
}
