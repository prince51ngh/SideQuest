import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";
import { CONFIG } from "./config.js";

export const configured =
  !CONFIG.supabaseUrl.includes("YOUR-") && !CONFIG.supabaseAnonKey.includes("YOUR-");

// PKCE keeps the sign-in redirect in ?code=... instead of the #hash, which this site uses for page routing.
export const sb = configured
  ? createClient(CONFIG.supabaseUrl, CONFIG.supabaseAnonKey, {
      auth: { flowType: "pkce", persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
    })
  : null;
