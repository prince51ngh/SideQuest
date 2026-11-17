// Runs every few minutes (see README, "Schedule the sweep").
//  - frees tasks whose taker never paid their deposit
//  - drops tasks whose poster never paid theirs
//  - cancels and refunds tasks nobody took before they were due
//  - confirms tasks the poster ignored for 48 hours after "done"
//  - retries any refund that failed earlier
// Deploy with --no-verify-jwt; it is protected by the CRON_SECRET header instead.
import { adminClient, stripeClient } from "../_shared/util.ts";
import { processRefunds } from "../_shared/refunds.ts";

Deno.serve(async (req) => {
  const secret = Deno.env.get("CRON_SECRET");
  if (!secret || req.headers.get("x-cron-secret") !== secret) {
    return new Response("Forbidden", { status: 403 });
  }
  try {
    const admin = adminClient();
    const { data: sweep, error } = await admin.rpc("sweep_expired");
    if (error) throw error;
    const refunds = await processRefunds(admin, stripeClient());
    return Response.json({ sweep, refunds });
  } catch (e) {
    console.error("sweep failed", e);
    return new Response("Sweep failed", { status: 500 });
  }
});
