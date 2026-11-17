// Starts a Stripe Checkout payment for the signed-in person's deposit on one task.
// The browser sends { task_id }; the amount always comes from the database,
// never from the browser.
import { adminClient, handle, HttpError, json, requireUser, siteUrl, stripeClient } from "../_shared/util.ts";

Deno.serve(handle(async (req) => {
  const { user } = await requireUser(req);
  const body = await req.json().catch(() => ({}));
  const taskId = String(body.task_id ?? "");
  if (!/^[0-9a-f-]{36}$/i.test(taskId)) throw new HttpError(400, "Missing task");

  const admin = adminClient();

  const { data: dep, error: depErr } = await admin
    .from("deposits")
    .select("id, party, amount_sen, stripe_session_id")
    .eq("task_id", taskId)
    .eq("user_id", user.id)
    .eq("status", "awaiting_payment")
    .maybeSingle();
  if (depErr) throw depErr;
  if (!dep) throw new HttpError(404, "There is no deposit waiting for payment on this task.");

  const { data: task, error: taskErr } = await admin
    .from("tasks")
    .select("id, title, status, taker_id, reserved_until")
    .eq("id", taskId)
    .single();
  if (taskErr) throw taskErr;

  if (dep.party === "poster" && task.status !== "awaiting_poster_deposit") {
    throw new HttpError(409, "This task is not waiting for your deposit any more.");
  }
  if (dep.party === "taker") {
    const stillReserved = task.status === "reserved" &&
      task.taker_id === user.id &&
      task.reserved_until && new Date(task.reserved_until).getTime() > Date.now();
    if (!stillReserved) {
      throw new HttpError(409, "Your 45 minutes to pay have run out. Take the task again if it is still open.");
    }
  }

  const stripe = stripeClient();

  // If they already opened a payment page, close it so only one can ever be paid.
  if (dep.stripe_session_id) {
    try {
      await stripe.checkout.sessions.expire(dep.stripe_session_id);
    } catch (_) { /* already expired or completed: fine */ }
  }

  const base = siteUrl();
  const meta = { deposit_id: dep.id, task_id: taskId, user_id: user.id };
  const session = await stripe.checkout.sessions.create({
    mode: "payment",
    payment_method_types: ["card", "fpx"],
    line_items: [{
      quantity: 1,
      price_data: {
        currency: "myr",
        unit_amount: dep.amount_sen,
        product_data: {
          name: `Task deposit: ${task.title}`.slice(0, 120),
          description: "Held until the task is finished, then refunded. Forfeited if you back out.",
        },
      },
    }],
    customer_email: user.email ?? undefined,
    client_reference_id: dep.id,
    metadata: meta,
    payment_intent_data: { metadata: meta },
    // Stripe requires at least 30 minutes; the taker's reservation lasts 45.
    expires_at: Math.floor(Date.now() / 1000) + 31 * 60,
    success_url: `${base}/#/paid/${taskId}`,
    cancel_url: `${base}/#/task/${taskId}`,
  });

  await admin.from("deposits").update({ stripe_session_id: session.id }).eq("id", dep.id);
  return json(req, { url: session.url });
}));
