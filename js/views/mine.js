// "My tasks": what needs me now, what I posted, what I took, and deposits awarded to me.
import { sb } from "../supabase.js";
import { store, must } from "../api.js";
import {
  h, money, fmtDate, fmtDateTime, timeLeft, statusChip, depositTag, depositTone,
  DEPOSIT_STATUS, loading, notice, errMsg,
} from "../ui.js";

export default async function render(root) {
  const uid = store.user.id;
  root.append(loading());

  let tasks, deposits, payouts;
  try {
    [tasks, deposits, payouts] = await Promise.all([
      must(sb.from("tasks")
        .select("id,title,status,reward_sen,deposit_sen,due_at,poster_id,taker_id,reserved_until,auto_confirm_at,created_at")
        .or(`poster_id.eq.${uid},taker_id.eq.${uid}`)
        .order("created_at", { ascending: false }).limit(100)),
      must(sb.from("deposits").select("task_id,party,amount_sen,status").eq("user_id", uid)),
      must(sb.from("payouts").select("id,task_id,amount_sen,status,reference,paid_at,created_at")
        .eq("to_user_id", uid).order("created_at", { ascending: false })),
    ]);
  } catch (e) {
    root.replaceChildren(notice("bad", errMsg(e)));
    return;
  }

  // The live (not cancelled) deposit this person has on each task.
  const myDeposit = new Map();
  for (const d of deposits) {
    const key = d.task_id;
    if (d.status !== "cancelled" || !myDeposit.has(key)) myDeposit.set(key, d);
  }
  const sum = (status) => deposits.filter((d) => d.status === status).reduce((n, d) => n + d.amount_sen, 0);
  const awardedDue = payouts.filter((p) => p.status === "due").reduce((n, p) => n + p.amount_sen, 0);

  const roleOf = (t) => (t.poster_id === uid ? "poster" : "taker");
  const todo = (t) => {
    const role = roleOf(t);
    if (t.status === "awaiting_poster_deposit" && role === "poster") return "Pay your deposit to publish this task";
    if (t.status === "reserved" && role === "taker") return `Pay your deposit within ${timeLeft(t.reserved_until)}`;
    if (t.status === "awaiting_confirmation" && role === "poster") return "Check the work and confirm";
    return null;
  };

  function card(t) {
    const dep = myDeposit.get(t.id);
    const action = todo(t);
    return h("a", { class: "card", href: `#/task/${t.id}` },
      h("div", { class: "row spread" }, statusChip(t.status), h("span", { class: "chip" }, roleOf(t) === "poster" ? "You posted" : "You took")),
      h("h3", {}, t.title),
      h("div", { class: "reward" }, money(t.reward_sen)),
      h("div", { class: "meta" }, h("span", {}, "Needed by ", fmtDateTime(t.due_at))),
      action ? h("div", { class: "todo" }, action) : null,
      h("div", { class: "foot" },
        h("span", { class: "small muted" }, "Your deposit"),
        dep
          ? depositTag(dep.amount_sen, { tone: depositTone(dep.status), note: DEPOSIT_STATUS[dep.status] })
          : depositTag(t.deposit_sen, { tone: "done", note: "not paid" })));
  }

  function section(title, list, empty) {
    return h("section", { class: "mine-section" },
      h("h2", {}, title),
      list.length ? h("div", { class: "board" }, list.map(card)) : h("p", { class: "muted" }, empty));
  }

  const needs = tasks.filter((t) => todo(t));
  const posted = tasks.filter((t) => t.poster_id === uid);
  const taken = tasks.filter((t) => t.taker_id === uid);

  const parts = [
    h("h1", { style: "font-size:2.2rem" }, "My tasks"),
    h("div", { class: "numbers" },
      h("div", { class: "panel" }, h("strong", {}, money(sum("held"))), "Deposits held right now"),
      h("div", { class: "panel" }, h("strong", {}, money(sum("refund_pending"))), "Refunds on their way"),
      h("div", { class: "panel" }, h("strong", {}, money(awardedDue)), "Awarded to you, waiting to be paid")),
  ];

  if (!tasks.length) {
    parts.push(h("div", { class: "empty" },
      h("h3", {}, "You have no tasks yet"),
      h("p", {}, "Take a task from the board, or post one of your own."),
      h("div", { class: "row", style: "justify-content:center" },
        h("a", { class: "btn primary", href: "#/" }, "Browse tasks"),
        h("a", { class: "btn", href: "#/post" }, "Post a task"))));
  } else {
    if (needs.length) parts.push(section("Needs you now", needs, ""));
    parts.push(section("Posted by me", posted, "You have not posted a task yet."));
    parts.push(section("Taken by me", taken, "You have not taken a task yet."));
  }

  if (payouts.length) {
    parts.push(h("section", { class: "mine-section" },
      h("h2", {}, "Deposits awarded to you"),
      h("p", { class: "muted" }, "When the team rules that someone let you down, their deposit is awarded to you. The team pays it to you by bank transfer, and will email you to ask where to send it."),
      h("div", { class: "panel scroll-x" },
        h("table", {},
          h("thead", {}, h("tr", {}, h("th", {}, "Amount"), h("th", {}, "Status"), h("th", {}, "Task"))),
          h("tbody", {}, payouts.map((p) => h("tr", {},
            h("td", {}, money(p.amount_sen)),
            h("td", {}, p.status === "paid" ? `Paid on ${fmtDate(p.paid_at)}${p.reference ? `, ref ${p.reference}` : ""}` : "Waiting for the team to pay you"),
            h("td", {}, h("a", { href: `#/task/${p.task_id}` }, "Open task")))))))));
  }

  root.replaceChildren(...parts);
}
