// Shared helpers for every Edge Function.
import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";
import Stripe from "npm:stripe@17";

// ---- Environment ------------------------------------------------------------
// SUPABASE_URL, SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY are provided by
// Supabase automatically. You set the rest with `supabase secrets set`:
//   STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, SITE_URL, CRON_SECRET
//   EXTRA_ORIGINS (optional, comma separated, e.g. http://localhost:8080 for testing)
function env(name: string): string {
  const v = Deno.env.get(name);
  if (!v) throw new Error(`Missing secret: ${name}`);
  return v;
}

export function siteUrl(): string {
  return env("SITE_URL").replace(/\/+$/, "");
}

// ---- CORS -------------------------------------------------------------------
function allowedOrigins(): string[] {
  const extra = (Deno.env.get("EXTRA_ORIGINS") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return [new URL(siteUrl()).origin, ...extra];
}

export function cors(req: Request): Record<string, string> {
  const origin = req.headers.get("origin") ?? "";
  const ok = allowedOrigins().includes(origin);
  return {
    "Access-Control-Allow-Origin": ok ? origin : allowedOrigins()[0],
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}

export function json(req: Request, body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors(req), "Content-Type": "application/json" },
  });
}

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

// ---- Clients ----------------------------------------------------------------
/** Full access. Only ever used on the server, never sent to a browser. */
export function adminClient(): SupabaseClient {
  return createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: { persistSession: false },
  });
}

/** Acts as the person who called the function, so row level security applies. */
export async function requireUser(req: Request) {
  const authHeader = req.headers.get("Authorization");
  if (!authHeader) throw new HttpError(401, "Sign in first");
  const client = createClient(env("SUPABASE_URL"), env("SUPABASE_ANON_KEY"), {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false },
  });
  const { data, error } = await client.auth.getUser();
  if (error || !data.user) throw new HttpError(401, "Your sign-in has expired. Sign in again.");
  return { user: data.user, client };
}

export function stripeClient(): Stripe {
  return new Stripe(env("STRIPE_SECRET_KEY"), { httpClient: Stripe.createFetchHttpClient() });
}

export function handle(fn: (req: Request) => Promise<Response>) {
  return async (req: Request): Promise<Response> => {
    if (req.method === "OPTIONS") return new Response("ok", { headers: cors(req) });
    try {
      return await fn(req);
    } catch (e) {
      if (e instanceof HttpError) return json(req, { error: e.message }, e.status);
      console.error(e);
      return json(req, { error: "Something went wrong on our side. Try again in a moment." }, 500);
    }
  };
}
