// Small UI helpers. Everything is built with DOM nodes (never innerHTML) so text
// that people type can never turn into code on the page.

const SVG_NS = "http://www.w3.org/2000/svg";

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v === false || v == null) continue;
    if (k === "class") el.className = v;
    else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === "dataset") Object.assign(el.dataset, v);
    else if (v === true) el.setAttribute(k, "");
    else el.setAttribute(k, v);
  }
  append(el, children);
  return el;
}

export function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

/** Like el.replaceChildren(...), but skips null/false (the native method would print the word "null"). */
export function setChildren(el, ...children) {
  el.replaceChildren();
  return append(el, children);
}

export function svgIcon(pathD, size = "1em") {
  const s = document.createElementNS(SVG_NS, "svg");
  s.setAttribute("viewBox", "0 0 24 24");
  s.setAttribute("width", size);
  s.setAttribute("height", size);
  s.setAttribute("aria-hidden", "true");
  const p = document.createElementNS(SVG_NS, "path");
  p.setAttribute("d", pathD);
  p.setAttribute("fill", "none");
  p.setAttribute("stroke", "currentColor");
  p.setAttribute("stroke-width", "3");
  p.setAttribute("stroke-linecap", "round");
  p.setAttribute("stroke-linejoin", "round");
  s.append(p);
  return s;
}

// ---------- Formatting ----------
export function money(sen) {
  const v = (Number(sen) || 0) / 100;
  return "RM " + v.toLocaleString("en-MY", { minimumFractionDigits: v % 1 === 0 ? 0 : 2, maximumFractionDigits: 2 });
}

export function ringgitToSen(text) {
  const n = Number.parseFloat(String(text).replace(/,/g, ""));
  return Number.isFinite(n) ? Math.round(n * 100) : NaN;
}

const dateFmt = new Intl.DateTimeFormat("en-MY", { day: "numeric", month: "short", year: "numeric" });
const dateTimeFmt = new Intl.DateTimeFormat("en-MY", {
  day: "numeric", month: "short", hour: "numeric", minute: "2-digit",
});
export const fmtDate = (iso) => dateFmt.format(new Date(iso));
export const fmtDateTime = (iso) => dateTimeFmt.format(new Date(iso));

export function timeLeft(iso) {
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return "now";
  const mins = Math.round(ms / 60000);
  if (mins < 60) return `${mins} min`;
  const hrs = Math.round(mins / 60);
  if (hrs < 48) return `${hrs} hr`;
  return `${Math.round(hrs / 24)} days`;
}

export const initials = (name) =>
  (name || "?").trim().split(/\s+/).slice(0, 2).map((w) => w[0]?.toUpperCase() ?? "").join("") || "?";

export function stars(avg) {
  const full = Math.round(Number(avg) || 0);
  return "★".repeat(full) + "☆".repeat(5 - full);
}

export const errMsg = (e) => (e && (e.message || e.error_description || e.error)) || "Something went wrong. Try again.";

// ---------- Task status wording ----------
const STATUS = {
  awaiting_poster_deposit: { label: "Waiting for the deposit", tone: "warn" },
  open: { label: "Open", tone: "" },
  reserved: { label: "Waiting for the taker's deposit", tone: "warn" },
  in_progress: { label: "In progress", tone: "" },
  awaiting_confirmation: { label: "Waiting for confirmation", tone: "warn" },
  completed: { label: "Done", tone: "grey" },
  disputed: { label: "Under review", tone: "bad" },
  resolved: { label: "Settled by the team", tone: "grey" },
  cancelled: { label: "Cancelled", tone: "grey" },
};
export const statusInfo = (s) => STATUS[s] ?? { label: s, tone: "grey" };
export const statusChip = (s) => h("span", { class: `chip ${statusInfo(s).tone}` }, statusInfo(s).label);

export const DEPOSIT_STATUS = {
  awaiting_payment: "Not paid yet",
  held: "Held",
  refund_pending: "Refund on its way",
  refunded: "Refunded",
  forfeited: "Forfeited",
  cancelled: "Cancelled",
};

/** Colour of the deposit tag for each deposit status. */
export const depositTone = (status) =>
  ({ held: "held", forfeited: "gone", refund_pending: "done", refunded: "done", cancelled: "done" })[status] ?? "";

// ---------- Small components ----------
export function depositTag(sen, { big = false, tone = "", note = "" } = {}) {
  return h("span", { class: `tag ${big ? "big" : ""} ${tone}` }, money(sen), h("small", {}, note || "deposit"));
}

export function loading(text = "Loading") {
  return h("div", { class: "loading", role: "status" }, h("span", { class: "spinner" }), " ", text);
}

export function notice(tone, ...children) {
  return h("div", { class: `notice ${tone}`, role: tone === "bad" ? "alert" : null }, ...children);
}

export function personLine(p, { link = true } = {}) {
  if (!p) return h("span", { class: "muted" }, "Someone");
  const name = link ? h("a", { href: `#/user/${p.id}` }, p.display_name) : p.display_name;
  return h(
    "span",
    { class: "row", style: "gap:.5rem" },
    h("span", { class: "avatar", "aria-hidden": "true" }, initials(p.display_name)),
    h("span", {}, name, " ", p.verified ? verifiedBadge() : null,
      Number(p.rating_count) > 0
        ? h("span", { class: "small muted" }, " ", h("span", { class: "stars" }, "★"), ` ${Number(p.rating_avg).toFixed(1)} (${p.rating_count})`)
        : h("span", { class: "small muted" }, " New")),
  );
}

export function verifiedBadge() {
  return h("span", { class: "verified", title: "ID checked by the team" }, svgIcon("M5 13l4 4L19 7", "1em"), "Verified");
}

// ---------- Toasts ----------
export function toast(message, tone = "") {
  let box = document.getElementById("toasts");
  if (!box) {
    box = h("div", { id: "toasts", class: "toasts", "aria-live": "polite" });
    document.body.append(box);
  }
  const t = h("div", { class: `toast ${tone}` }, message);
  box.append(t);
  setTimeout(() => t.remove(), tone === "bad" ? 7000 : 4000);
}

// ---------- Dialogs ----------
function openDialog(content) {
  return new Promise((resolve) => {
    const dlg = h("dialog", {}, content);
    dlg.addEventListener("close", () => { dlg.remove(); resolve(dlg.returnValue || ""); });
    document.body.append(dlg);
    dlg.showModal();
    dlg.querySelector("[autofocus], input, textarea, select, button")?.focus();
  });
}

export async function confirmDialog({ title, body, confirmLabel = "Yes, continue", cancelLabel = "Cancel", danger = false }) {
  const form = h(
    "form", { method: "dialog", class: "stack" },
    h("h2", {}, title),
    ...[].concat(body).map((b) => (typeof b === "string" ? h("p", {}, b) : b)),
    h("div", { class: "row" },
      h("button", { class: `btn ${danger ? "danger solid" : "primary"}`, value: "yes" }, confirmLabel),
      h("button", { class: "btn", value: "no", formnovalidate: true }, cancelLabel)),
  );
  return (await openDialog(form)) === "yes";
}

/** Shows a form in a dialog. fields: [{name,label,type,options,required,min,hint,rows}] -> values object, or null if cancelled. */
export function formDialog({ title, intro = [], fields, submitLabel = "Send", danger = false }) {
  return new Promise((resolve) => {
    const inputs = {};
    const err = h("p", { class: "small", style: "color:var(--raspberry)", role: "alert" });
    const form = h("form", { class: "stack", novalidate: true });
    form.append(h("h2", {}, title), ...[].concat(intro).map((b) => (typeof b === "string" ? h("p", {}, b) : b)));
    for (const f of fields) {
      let input;
      if (f.type === "select") {
        input = h("select", { id: `fd-${f.name}` }, f.options.map((o) => h("option", { value: o.value }, o.label)));
      } else if (f.type === "textarea") {
        input = h("textarea", { id: `fd-${f.name}`, rows: f.rows ?? 4, maxlength: f.max ?? 1000 });
      } else if (f.type === "file") {
        input = h("input", { id: `fd-${f.name}`, type: "file", accept: "image/*" });
      } else {
        input = h("input", { id: `fd-${f.name}`, type: f.type ?? "text", maxlength: f.max ?? 200 });
      }
      if (f.value != null && f.type !== "file") input.value = f.value;
      inputs[f.name] = input;
      form.append(h("div", { class: "field" }, h("label", { for: `fd-${f.name}` }, f.label), input, f.hint ? h("div", { class: "hint" }, f.hint) : null));
    }
    form.append(err, h("div", { class: "row" },
      h("button", { class: `btn ${danger ? "danger solid" : "primary"}`, type: "submit" }, submitLabel),
      h("button", { class: "btn", type: "button", id: "fd-cancel" }, "Cancel")));

    const dlg = h("dialog", {}, form);
    const finish = (v) => { if (dlg.open) dlg.close(); dlg.remove(); resolve(v); };
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const values = {};
      for (const f of fields) {
        if (f.type === "file") {
          const file = inputs[f.name].files?.[0] ?? null;
          if (f.required && !file) {
            err.textContent = `${f.label}: choose a photo.`;
            inputs[f.name].focus();
            return;
          }
          values[f.name] = file;
          continue;
        }
        const v = inputs[f.name].value.trim();
        if (f.required && v.length < (f.min ?? 1)) {
          err.textContent = f.min ? `${f.label}: write at least ${f.min} characters.` : `${f.label} is required.`;
          inputs[f.name].focus();
          return;
        }
        values[f.name] = v;
      }
      finish(values);
    });
    form.querySelector("#fd-cancel").addEventListener("click", () => finish(null));
    dlg.addEventListener("cancel", (e) => { e.preventDefault(); finish(null); });
    document.body.append(dlg);
    dlg.showModal();
    form.querySelector("input, textarea, select")?.focus();
  });
}

export function viewImage(url) {
  const dlg = h("dialog", { class: "viewer" }, h("img", { src: url, alt: "Photo" }));
  dlg.addEventListener("click", () => dlg.close());
  dlg.addEventListener("close", () => dlg.remove());
  document.body.append(dlg);
  dlg.showModal();
}

// ---------- Images ----------
/** Shrinks a photo before upload (phone photos are huge). Returns a JPEG Blob. */
export async function compressImage(file, maxDim = 1600, quality = 0.82) {
  if (!file.type.startsWith("image/")) throw new Error("Choose a photo (JPG, PNG or WebP).");
  const bitmap = await createImageBitmap(file).catch(() => null);
  if (!bitmap) throw new Error("That photo could not be read. Try another one.");
  const scale = Math.min(1, maxDim / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise((res) => canvas.toBlob(res, "image/jpeg", quality));
  if (!blob) throw new Error("That photo could not be processed.");
  if (blob.size > 5 * 1024 * 1024) throw new Error("That photo is still too large. Try a smaller one.");
  return blob;
}

export function busy(button, on, label) {
  if (on) {
    button.dataset.label = button.textContent;
    button.disabled = true;
    button.replaceChildren(h("span", { class: "spinner" }), " ", label ?? "Working");
  } else {
    button.disabled = false;
    button.textContent = button.dataset.label ?? button.textContent;
  }
}

/** Runs an async action behind a button, with a spinner and error toast. */
export async function withButton(button, label, fn) {
  busy(button, true, label);
  try {
    return await fn();
  } catch (e) {
    toast(errMsg(e), "bad");
  } finally {
    if (button.isConnected) busy(button, false);
  }
}
