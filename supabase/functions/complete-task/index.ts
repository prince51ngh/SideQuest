// The poster confirms the task is done. Both deposits go back to their owners.
import { adminClient, handle, HttpError, json, requireUser, stripeClient } from "../_shared/util.ts";
import { processRefunds } from "../_shared/refunds.ts";

Deno.serve(handle(async (req) => {
  const { client } = await requireUser(req);
  const body = await req.json().catch(() => ({}));
  const taskId = String(body.task_id ?? "");
  if (!/^[0-9a-f-]{36}$/i.test(taskId)) throw new HttpError(400, "Missing task");

  // Runs as the caller, so the database itself checks they are the poster.
  const { error } = await client.rpc("confirm_task", { p_task: taskId });
  if (error) throw new HttpError(400, error.message);

  // If a refund fails here it stays queued and the 5-minute sweep retries it.
  const refunds = await processRefunds(adminClient(), stripeClient(), { taskId });
  return json(req, { ok: true, refunds });
}));
