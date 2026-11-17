// One place for talking to Supabase, so the views stay short.
import { sb } from "./supabase.js";

// ---------- Who is signed in ----------
export const store = {
  user: null,
  profile: null,
  get isAdmin() { return this.profile?.role === "admin"; },
};

export async function refreshSession() {
  const { data } = await sb.auth.getSession();
  store.user = data.session?.user ?? null;
  store.profile = null;
  if (store.user) {
    const { data: p } = await sb.from("profiles").select("*").eq("id", store.user.id).maybeSingle();
    store.profile = p;
  }
  return store;
}

export const signIn = (email, password) => sb.auth.signInWithPassword({ email, password });
export const signOut = () => sb.auth.signOut();
export function signUp(email, password, displayName) {
  return sb.auth.signUp({
    email,
    password,
    options: {
      data: { display_name: displayName },
      emailRedirectTo: location.origin + location.pathname,
    },
  });
}

// ---------- Calling the database and Edge Functions ----------
export async function rpc(name, args = {}) {
  const { data, error } = await sb.rpc(name, args);
  if (error) throw new Error(error.message);
  return data;
}

export async function callFn(name, body = {}) {
  const { data, error } = await sb.functions.invoke(name, { body });
  if (error) {
    let message = error.message;
    try {
      const j = await error.context.json();
      if (j?.error) message = j.error;
    } catch (_) { /* keep generic message */ }
    throw new Error(message);
  }
  return data;
}

/** Sends the person to Stripe to pay the deposit they owe on this task. */
export async function startDepositPayment(taskId) {
  const { url } = await callFn("create-deposit-checkout", { task_id: taskId });
  if (!url) throw new Error("The payment page could not be opened. Try again.");
  location.assign(url);
}

export async function must(promise) {
  const { data, error } = await promise;
  if (error) throw new Error(error.message);
  return data;
}

// ---------- People ----------
const profileCache = new Map();
export async function publicProfiles(ids) {
  const want = [...new Set(ids.filter(Boolean))];
  const missing = want.filter((id) => !profileCache.has(id));
  if (missing.length) {
    const rows = await must(sb.from("public_profiles").select("*").in("id", missing));
    for (const r of rows) profileCache.set(r.id, r);
  }
  return Object.fromEntries(want.map((id) => [id, profileCache.get(id)]));
}
export const forgetProfiles = () => profileCache.clear();

// ---------- Photos (private buckets, so each one needs a short-lived link) ----------
export async function signedUrls(bucket, paths) {
  const list = [...new Set(paths.filter(Boolean))];
  if (!list.length) return {};
  const { data, error } = await sb.storage.from(bucket).createSignedUrls(list, 3600);
  if (error) throw new Error(error.message);
  return Object.fromEntries(data.filter((d) => d.signedUrl).map((d) => [d.path, d.signedUrl]));
}

export async function uploadImage(bucket, path, blob) {
  const { error } = await sb.storage.from(bucket).upload(path, blob, { contentType: "image/jpeg", upsert: false });
  if (error) throw new Error(error.message);
  return path;
}

export const newFileName = () => crypto.randomUUID() + ".jpg";
