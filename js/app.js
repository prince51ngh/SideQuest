// App shell: sign-in state, top bar, and page routing (#/ style so GitHub Pages never 404s).
import { CONFIG } from "./config.js";
import { configured, sb } from "./supabase.js";
import { refreshSession, store, signOut, forgetProfiles } from "./api.js";
import { h, setChildren, loading, notice, toast, errMsg } from "./ui.js";

const root = document.getElementById("view");
const nav = document.getElementById("nav");

// route pattern -> view module. Views are loaded on demand.
const ROUTES = [
  { re: /^\/?$/, load: () => import("./views/browse.js"), nav: "browse" },
  { re: /^\/task\/([0-9a-f-]{36})$/i, load: () => import("./views/task.js"), nav: "browse" },
  { re: /^\/paid\/([0-9a-f-]{36})$/i, load: () => import("./views/paid.js"), auth: true },
  { re: /^\/post$/, load: () => import("./views/post.js"), nav: "post", auth: true },
  { re: /^\/mine$/, load: () => import("./views/mine.js"), nav: "mine", auth: true },
  { re: /^\/me$/, load: () => import("./views/profile.js"), nav: "me", auth: true },
  { re: /^\/user\/([0-9a-f-]{36})$/i, load: () => import("./views/profile.js") },
  { re: /^\/login$/, load: () => import("./views/auth.js"), nav: "login" },
  { re: /^\/admin$/, load: () => import("./views/admin.js"), nav: "admin", auth: true },
];

let cleanup = null;
let routeToken = 0;

function parseHash() {
  const raw = location.hash.replace(/^#/, "") || "/";
  const [path, query = ""] = raw.split("?");
  return { path, query: new URLSearchParams(query) };
}

export function go(path) {
  location.hash = "#" + path;
}

function drawNav(active) {
  const link = (id, href, text) =>
    h("a", { href, "aria-current": active === id ? "page" : null }, text);
  setChildren(nav,
    link("browse", "#/", "Browse tasks"),
    link("post", "#/post", "Post a task"),
    store.user ? link("mine", "#/mine", "My tasks") : null,
    store.isAdmin ? link("admin", "#/admin", "Admin") : null,
    store.user
      ? link("me", "#/me", store.profile?.display_name ?? "Me")
      : link("login", "#/login", "Sign in"),
    store.user
      ? h("a", { href: "#/", onclick: async (e) => { e.preventDefault(); await signOut(); toast("You are signed out."); go("/"); } }, "Sign out")
      : null,
  );
}

async function route() {
  const token = ++routeToken;
  const { path, query } = parseHash();
  if (cleanup) { try { cleanup(); } catch (_) { /* ignore */ } cleanup = null; }

  const match = ROUTES.map((r) => ({ r, m: path.match(r.re) })).find((x) => x.m);
  drawNav(match?.r.nav);
  window.scrollTo(0, 0);

  if (!match) {
    root.replaceChildren(h("div", { class: "empty" }, h("h3", {}, "That page does not exist"), h("a", { class: "btn", href: "#/" }, "Back to the board")));
    return;
  }
  if (match.r.auth && !store.user) {
    go(`/login?next=${encodeURIComponent(path)}`);
    return;
  }

  root.replaceChildren(loading());
  try {
    const mod = await match.r.load();
    if (token !== routeToken) return; // the person already moved on
    root.replaceChildren();
    cleanup = (await mod.default(root, { params: match.m.slice(1), query, path })) ?? null;
  } catch (e) {
    console.error(e);
    if (token === routeToken) {
      root.replaceChildren(notice("bad", h("strong", {}, "This page could not load. "), errMsg(e)));
    }
  }
}

function setupScreen() {
  root.replaceChildren(
    h("div", { class: "panel stack" },
      h("h1", {}, `Almost there`),
      h("p", {}, `${CONFIG.appName} is not connected to a database yet.`),
      h("p", {}, "Open ", h("code", {}, "js/config.js"), " and paste in your Supabase project URL and anon key, then reload. The README walks through every step."),
    ),
  );
}

async function start() {
  document.title = `${CONFIG.appName}: small jobs, fair deposits`;
  document.querySelectorAll("[data-app-name]").forEach((el) => (el.textContent = CONFIG.appName));

  if (!configured) {
    drawNav("");
    setupScreen();
    return;
  }

  await refreshSession();
  let lastUserId = store.user?.id ?? null;
  sb.auth.onAuthStateChange(async (event) => {
    if (event === "TOKEN_REFRESHED") return;
    await refreshSession();
    const nowId = store.user?.id ?? null;
    if (nowId !== lastUserId) {
      lastUserId = nowId;
      forgetProfiles();
      route();
    } else {
      drawNav(null);
    }
  });
  window.addEventListener("hashchange", route);
  route();
}

start();
