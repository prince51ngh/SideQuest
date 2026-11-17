import { rpc, startDepositPayment } from "../api.js";
import { CONFIG, CATEGORIES } from "../config.js";
import { go } from "../app.js";
import { h, money, ringgitToSen, withButton, toast, notice, depositTag } from "../ui.js";

function localDateTimeValue(d) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

export default async function render(root) {
  const f = {
    title: h("input", { id: "p-title", maxlength: 80, placeholder: "Water my plants this weekend" }),
    description: h("textarea", { id: "p-desc", maxlength: 1000, placeholder: "What needs doing, roughly how long it takes, anything the person should bring." }),
    category: h("select", { id: "p-cat" }, CATEGORIES.map((c) => h("option", { value: c.id }, c.label))),
    area: h("input", { id: "p-area", maxlength: 60, placeholder: "Town or neighbourhood, e.g. Bentong" }),
    address: h("textarea", { id: "p-addr", maxlength: 300, rows: 3, placeholder: "Street, unit, gate code, who to ask for. Optional." }),
    reward: h("input", { id: "p-reward", type: "number", min: CONFIG.minRewardSen / 100, max: CONFIG.maxRewardSen / 100, step: "0.5", inputmode: "decimal" }),
    deposit: h("input", { id: "p-dep", type: "number", min: CONFIG.minDepositSen / 100, max: CONFIG.maxDepositSen / 100, step: "0.5", inputmode: "decimal" }),
    due: h("input", { id: "p-due", type: "datetime-local" }),
  };
  const soon = new Date(Date.now() + 3 * 24 * 3600 * 1000);
  soon.setMinutes(0, 0, 0);
  f.due.value = localDateTimeValue(soon);
  f.due.min = localDateTimeValue(new Date(Date.now() + 2 * 3600 * 1000));

  let depositTouched = false;
  const summary = h("div", { class: "notice warn", "aria-live": "polite" });
  const msg = h("div", { "aria-live": "polite" });

  const minDepositFor = (rewardSen) => Math.max(CONFIG.minDepositSen, Math.ceil(rewardSen * 0.1));

  function sync() {
    const reward = ringgitToSen(f.reward.value);
    if (!depositTouched && Number.isFinite(reward)) {
      const suggested = Math.min(CONFIG.maxDepositSen, Math.max(CONFIG.minDepositSen, Math.round((reward * CONFIG.depositPercent) / 100 / 50) * 50));
      f.deposit.value = (suggested / 100).toString();
    }
    const dep = ringgitToSen(f.deposit.value);
    summary.replaceChildren(
      h("div", { class: "row spread" },
        h("strong", {}, "What you pay today"),
        Number.isFinite(dep) ? depositTag(dep, { big: false }) : h("span", { class: "muted" }, "Set a deposit")),
      h("p", { class: "small", style: "margin:.5rem 0 0" },
        "Your deposit is charged now and held while the task is pending. You get it all back when the task is done, or if you cancel before anyone takes it. The person who takes it pays the same deposit before the task starts."));
  }
  f.reward.addEventListener("input", sync);
  f.deposit.addEventListener("input", () => { depositTouched = true; sync(); });
  sync();

  const submit = h("button", { class: "btn primary", type: "submit" }, "Post and pay deposit");
  const form = h("form", { class: "stack", novalidate: true },
    h("div", { class: "field" }, h("label", { for: "p-title" }, "What is the task?"), f.title),
    h("div", { class: "field" }, h("label", { for: "p-desc" }, "Details"), f.description),
    h("div", { class: "two" },
      h("div", { class: "field" }, h("label", { for: "p-cat" }, "Kind of task"), f.category),
      h("div", { class: "field" }, h("label", { for: "p-area" }, "Where (town)"), f.area, h("div", { class: "hint" }, "Shown to everyone."))),
    h("div", { class: "field" }, h("label", { for: "p-addr" }, "Exact address and access notes"), f.address,
      h("div", { class: "hint" }, "Private. Only shown to the person who takes the task, after both deposits are paid.")),
    h("div", { class: "two" },
      h("div", { class: "field" }, h("label", { for: "p-reward" }, "Reward you will pay"),
        h("div", { class: "money-input" }, h("span", {}, "RM"), f.reward),
        h("div", { class: "hint" }, "Paid by you directly to them when the job is done. Not held by us.")),
      h("div", { class: "field" }, h("label", { for: "p-dep" }, "Deposit (each person)"),
        h("div", { class: "money-input" }, h("span", {}, "RM"), f.deposit),
        h("div", { class: "hint" }, `At least RM 5 and 10% of the reward. We suggest ${CONFIG.depositPercent}%.`))),
    h("div", { class: "field" }, h("label", { for: "p-due" }, "Needs to be done by"), f.due),
    summary, msg, h("div", { class: "row" }, submit, h("a", { class: "btn quiet", href: "#/" }, "Cancel")));

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    msg.replaceChildren();
    const problems = [];
    const reward = ringgitToSen(f.reward.value);
    const deposit = ringgitToSen(f.deposit.value);
    if (f.title.value.trim().length < 4) problems.push("Give the task a title (at least 4 characters).");
    if (f.description.value.trim().length < 10) problems.push("Describe the task in a sentence or two (at least 10 characters).");
    if (f.area.value.trim().length < 2) problems.push("Say which town the task is in.");
    if (!Number.isFinite(reward) || reward < CONFIG.minRewardSen || reward > CONFIG.maxRewardSen)
      problems.push(`The reward must be between ${money(CONFIG.minRewardSen)} and ${money(CONFIG.maxRewardSen)}.`);
    else if (!Number.isFinite(deposit) || deposit < minDepositFor(reward) || deposit > CONFIG.maxDepositSen)
      problems.push(`For this reward the deposit must be between ${money(minDepositFor(reward))} and ${money(CONFIG.maxDepositSen)}.`);
    const due = new Date(f.due.value);
    if (!f.due.value || Number.isNaN(due.getTime()) || due.getTime() < Date.now() + 3600 * 1000)
      problems.push("Pick a due time at least an hour from now.");
    if (problems.length) {
      msg.replaceChildren(notice("bad", h("ul", { style: "margin:0;padding-left:1.1rem" }, problems.map((p) => h("li", {}, p)))));
      return;
    }

    withButton(submit, "Creating your task", async () => {
      const taskId = await rpc("create_task", {
        p_title: f.title.value,
        p_description: f.description.value,
        p_category: f.category.value,
        p_area: f.area.value,
        p_reward_sen: reward,
        p_deposit_sen: deposit,
        p_due_at: due.toISOString(),
        p_address: f.address.value || null,
      });
      try {
        await startDepositPayment(taskId); // leaves the page for Stripe
      } catch (err) {
        toast(`Your task is saved but the payment page did not open: ${err.message}`, "bad");
        go(`/task/${taskId}`);
      }
    });
  });

  root.append(h("div", { style: "max-width:720px;margin-inline:auto" },
    h("h1", { style: "font-size:2.2rem" }, "Post a task"),
    h("p", { class: "muted" }, "Be specific about the job. People take it more readily when they know what they are agreeing to."),
    h("div", { class: "panel" }, form)));
}
