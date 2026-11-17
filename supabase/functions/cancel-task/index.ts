// The poster withdraws a task nobody has started yet (or deletes a draft they never paid for).
// The database rule allows this only while the task is waiting for a taker, and queues the
// poster's refund; this function then sends that refund to Stripe straight away.
import { adminClient, handle, HttpError, json, requireUser, stripeClient } from "../_shared/util.ts";
import { processRefunds } from "../_shared/refunds.ts";

Deno.serve(handle(async (req) => {
  const { client } = await requireUser(req);
  const body = await req.json().catch(() => ({}));
  const taskId = String(body.task_id ?? "");
  if (!/^[0-9a-f-]{36}$/i.test(taskId)) throw new HttpError(400, "Missing task");

  // Runs as the caller, so the database itself checks they are the poster.
  const { error } = await client.rpc("cancel_task", { p_task: taskId });
  if (error) throw new HttpError(400, error.message);

  // If the refund fails here it stays queued and the 5-minute sweep retries it.
  const refunds = await processRefunds(adminClient(), stripeClient(), { taskId });
  return json(req, { ok: true, refunds });
}));
