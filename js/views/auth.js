import { signIn, signUp, store, refreshSession } from "../api.js";
import { go } from "../app.js";
import { h, setChildren, withButton, toast, notice, errMsg } from "../ui.js";

export default async function render(root, { query }) {
  const next = query.get("next") || "/";
  if (store.user) { go(next); return; }

  let mode = "in";
  const panel = h("div", { class: "panel stack", style: "max-width:460px;margin-inline:auto" });
  root.append(panel);

  function paint() {
    const msg = h("div", { "aria-live": "polite" });
    const email = h("input", { id: "a-email", type: "email", autocomplete: "email", required: true });
    const pass = h("input", { id: "a-pass", type: "password", autocomplete: mode === "in" ? "current-password" : "new-password", required: true, minlength: 8 });
    const name = h("input", { id: "a-name", type: "text", autocomplete: "name", maxlength: 40, placeholder: "What neighbours will see" });
    const submit = h("button", { class: "btn primary", type: "submit" }, mode === "in" ? "Sign in" : "Create account");

    const form = h("form", { class: "stack" },
      mode === "up" ? h("div", { class: "field" }, h("label", { for: "a-name" }, "Your name"), name) : null,
      h("div", { class: "field" }, h("label", { for: "a-email" }, "Email"), email),
      h("div", { class: "field" }, h("label", { for: "a-pass" }, "Password"), pass,
        mode === "up" ? h("div", { class: "hint" }, "At least 8 characters.") : null),
      msg, submit);

    form.addEventListener("submit", (e) => {
      e.preventDefault();
      if (mode === "up" && name.value.trim().length < 2) { msg.replaceChildren(notice("bad", "Add your name (at least 2 characters).")); return; }
      if (pass.value.length < 8) { msg.replaceChildren(notice("bad", "Use a password with at least 8 characters.")); return; }
      withButton(submit, mode === "in" ? "Signing in" : "Creating account", async () => {
        try {
          if (mode === "in") {
            const { error } = await signIn(email.value.trim(), pass.value);
            if (error) throw error;
            await refreshSession();
            go(next);
          } else {
            const { data, error } = await signUp(email.value.trim(), pass.value, name.value.trim());
            if (error) throw error;
            if (data.session) { await refreshSession(); toast("Welcome aboard.", "good"); go(next); }
            else msg.replaceChildren(notice("", h("strong", {}, "Check your email. "), "We sent you a link to confirm your address. Open it, then come back here and sign in."));
          }
        } catch (err) {
          msg.replaceChildren(notice("bad", errMsg(err)));
        }
      });
    });

    setChildren(panel,
      h("h1", { style: "font-size:2rem" }, mode === "in" ? "Sign in" : "Create your account"),
      mode === "up" ? h("p", { class: "muted" }, "You need an account to post or take a task. Browsing is open to everyone.") : null,
      form,
      h("p", { class: "muted" },
        mode === "in" ? "New here? " : "Already have an account? ",
        h("button", { class: "btn quiet", type: "button", onclick: () => { mode = mode === "in" ? "up" : "in"; paint(); } },
          mode === "in" ? "Create an account" : "Sign in instead")));
  }
  paint();
}
