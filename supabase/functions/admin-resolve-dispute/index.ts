// An admin rules on a dispute. Deposits are refunded or forfeited accordingly;
// a forfeited deposit becomes a payout the admin then pays to the person who was let down.
import { adminClient, handle, HttpError, json, requireUser, stripeClient } from "../_shared/util.ts";
import { processRefunds } from "../_shared/refunds.ts";

const RESOLUTIONS = ["refund_both", "forfeit_taker", "forfeit_poster"];

Deno.serve(handle(async (req) => {
  const { user } = await requireUser(req);
  const admin = adminClient();

  const { data: profile } = await admin.from("profiles").select("role").eq("id", user.id).single();
  if (profile?.role !== "admin") throw new HttpError(403, "Admins only");

  const body = await req.json().catch(() => ({}));
  const disputeId = String(body.dispute_id ?? "");
  const resolution = String(body.resolution ?? "");
  const note = String(body.admin_note ?? "").trim();
  if (!/^[0-9a-f-]{36}$/i.test(disputeId)) throw new HttpError(400, "Missing dispute");
  if (!RESOLUTIONS.includes(resolution)) throw new HttpError(400, "Choose a ruling");
  if (note.length < 10) throw new HttpError(400, "Write a short note explaining the ruling (at least 10 characters)");

  const { data: taskId, error } = await admin.rpc("resolve_dispute", {
    p_dispute: disputeId,
    p_resolution: resolution,
    p_note: note,
    p_admin: user.id,
  });
  if (error) throw new HttpError(400, error.message);

  const refunds = await processRefunds(admin, stripeClient(), { taskId });
  return json(req, { ok: true, refunds });
}));
