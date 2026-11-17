// Team area: rule on disputes, check IDs, record payouts of forfeited deposits.
// Everything here is enforced by the database too (is_admin()), so a non-admin who finds this page sees nothing.
import { sb } from "../supabase.js";
import { store, publicProfiles, rpc, callFn, must, signedUrls } from "../api.js";
import {
  h, money, fmtDate, fmtDateTime, statusChip, depositTag, depositTone, DEPOSIT_STATUS,
  loading, notice, toast, confirmDialog, withButton, errMsg,
} from "../ui.js";
import { DISPUTE_KIND, photoGrid, rulingText } from "../shared.js";

export default async function render(root) {
  if (!store.isAdmin) {
    root.append(notice("bad", "This area is for the team only."));
    return;
  }

  let tab = "overview";
  const counts = { disputes: 0, verification: 0, payouts: 0 };
  const tabBar = h("div", { class: "tabs", role: "tablist", "aria-label": "Team area" });
  const body = h("div", {});
  root.append(h("h1", { style: "font-size:2.2rem" }, "Team area"), tabBar, body);

  const TABS = [
    ["overview", "Overview"], ["disputes", "Disputes"], ["verification", "ID checks"], ["payouts", "Payouts"],
  ];

  function paintTabs() {
    tabBar.replaceChildren(...TABS.map(([id, label]) => {
      const n = counts[id] ?? 0;
      return h("button", {
        type: "button", role: "tab", "aria-selected": String(tab === id),
        onclick: () => { tab = id; paintTabs(); show(); },
      }, label, n ? ` (${n})` : "");
    }));
  }

  async function loadCounts() {
    const head = (table) => sb.from(table).select("id", { count: "exact", head: true });
    const [d, v, p] = await Promise.all([
      head("disputes").eq("status", "open"),
      head("profiles").eq("verification_status", "pending"),
      head("payouts").eq("status", "due"),
    ]);
    counts.disputes = d.count ?? 0;
    counts.verification = v.count ?? 0;
    counts.payouts = p.count ?? 0;
    paintTabs();
  }

  async function show() {
    body.replaceChildren(loading());
    try {
      const node = await ({ overview, disputes, verification, payouts })[tab]();
      body.replaceChildren(node);
    } catch (e) {
      body.replaceChildren(notice("bad", errMsg(e)));
    }
  }

  async function reload() {
    await loadCounts();
    await show();
  }

  // ---------- Overview ----------
  async function overview() {
    const [totals, attention] = await Promise.all([
      rpc("admin_held_total"),
      must(sb.from("deposits").select("id,task_id,party,amount_sen,status,last_error").not("last_error", "is", null).limit(50)),
    ]);
    const t = totals?.[0] ?? {};
    const num = (label, sen) => h("div", { class: "panel" }, h("strong", {}, money(Number(sen) || 0)), label);
    return h("div", { class: "stack" },
      h("div", { class: "numbers" },
        num("Deposits held right now", t.held_sen),
        num("Refunds queued for Stripe", t.refund_pending_sen),
        num("Awarded, waiting for you to pay out", t.payouts_due_sen)),
      h("section", { class: "panel" },
        h("h2", {}, "Needs attention"),
        attention.length
          ? attention.map((d) => h("div", { class: "evidence" },
              h("div", {}, h("a", { href: `#/task/${d.task_id}` }, "Open task"), `. ${d.party === "poster" ? "Poster" : "Taker"} deposit of ${money(d.amount_sen)} (${DEPOSIT_STATUS[d.status] ?? d.status})`),
              h("div", { class: "small", style: "color:var(--raspberry)" }, d.last_error)))
          : h("p", { class: "muted" }, "Nothing needs attention. Failed refunds and late payments show up here.")));
  }

  // ---------- Disputes ----------
  async function disputes() {
    const rows = await must(sb.from("disputes").select("*").order("status", { ascending: true }).order("created_at", { ascending: false }).limit(40));
    if (!rows.length) return h("div", { class: "empty" }, h("h3", {}, "No disputes"), h("p", {}, "Reports and back-outs appear here."));

    const taskIds = [...new Set(rows.map((r) => r.task_id))];
    const [tasks, deposits, evidence] = await Promise.all([
      must(sb.from("tasks").select("*").in("id", taskIds)),
      must(sb.from("deposits").select("task_id,party,amount_sen,status").in("task_id", taskIds)),
      must(sb.from("dispute_evidence").select("*").in("dispute_id", rows.map((r) => r.id)).order("created_at")),
    ]);
    const taskById = Object.fromEntries(tasks.map((t) => [t.id, t]));
    const people = await publicProfiles(tasks.flatMap((t) => [t.poster_id, t.taker_id]));
    const urls = await signedUrls("task-files", evidence.map((e) => e.file_path)).catch(() => ({}));

    return h("div", { class: "stack" }, rows.map((d) => disputeCard(d, taskById[d.task_id], deposits.filter((x) => x.task_id === d.task_id), evidence.filter((e) => e.dispute_id === d.id), people, urls)));
  }

  function disputeCard(d, t, deps, evidence, people, urls) {
    if (!t) return h("div", { class: "panel" }, "Task not found.");
    const open = d.status === "open";
    const name = (uid) => people[uid]?.display_name ?? "Someone";
    const live = (party) => deps.find((x) => x.party === party && x.status !== "cancelled");
    const depLine = (party) => {
      const dep = live(party);
      return h("div", { class: "dep-row" },
        h("div", {}, h("strong", {}, party === "poster" ? "Poster" : "Taker"), h("div", { class: "small muted" }, name(party === "poster" ? t.poster_id : t.taker_id))),
        dep ? depositTag(dep.amount_sen, { tone: depositTone(dep.status), note: DEPOSIT_STATUS[dep.status] }) : h("span", { class: "muted small" }, "None"));
    };
    const side = (uid, label) => {
      const mine = evidence.filter((e) => e.user_id === uid);
      return h("div", {},
        h("h3", {}, `${label}: ${name(uid)}`),
        mine.length
          ? mine.map((e) => h("div", { class: `evidence ${uid === t.poster_id ? "poster" : "taker"}` },
              h("div", { class: "small muted" }, fmtDateTime(e.created_at)), h("div", { class: "prose" }, e.note),
              photoGrid([{ url: urls[e.file_path], caption: "" }])))
          : h("p", { class: "muted" }, "No evidence added yet."));
    };

    const parts = [
      h("div", { class: "row spread" },
        h("h2", { style: "margin:0" }, h("a", { href: `#/task/${t.id}` }, t.title)),
        h("div", { class: "row" }, h("span", { class: "chip bad" }, DISPUTE_KIND[d.kind] ?? d.kind), statusChip(open ? "disputed" : "resolved"))),
      h("p", { class: "small muted" }, d.kind === "back_out" ? `${name(d.raised_by)} is backing out. Reported on ${fmtDateTime(d.created_at)}. Reward ${money(t.reward_sen)}.` : `Raised by ${name(d.raised_by)} against ${name(d.against_user)} on ${fmtDateTime(d.created_at)}. Reward ${money(t.reward_sen)}.`),
      h("div", { class: "prose" }, d.description),
      h("div", { class: "dep-list", style: "margin-block:1rem" }, depLine("poster"), depLine("taker")),
      h("div", { class: "two" }, side(t.poster_id, "Poster"), side(t.taker_id, "Taker")),
    ];

    if (open) {
      const both = [t.poster_id, t.taker_id].every((u) => evidence.some((e) => e.user_id === u));
      const closed = new Date(d.evidence_deadline) <= new Date();
      parts.push(
        both || closed
          ? notice("", both ? "Both people have added evidence. You can rule now." : `The evidence window closed on ${fmtDateTime(d.evidence_deadline)}. You can rule now.`)
          : notice("warn", `You can rule once both people have added evidence, or after ${fmtDateTime(d.evidence_deadline)}.`),
        rulingForm(d, t, people));
    } else {
      parts.push(notice("", h("strong", {}, rulingText(d, t, people)), d.admin_note ? h("p", { class: "small", style: "margin:.4rem 0 0" }, `Note: ${d.admin_note}`) : null));
    }
    return h("section", { class: "panel" }, parts);
  }

  function rulingForm(d, t, people) {
    const poster = people[t.poster_id]?.display_name ?? "the poster";
    const taker = people[t.taker_id]?.display_name ?? "the taker";
    const choice = h("select", { "aria-label": "Ruling" },
      h("option", { value: "" }, "Choose a ruling"),
      h("option", { value: "refund_both" }, "Return both deposits"),
      h("option", { value: "forfeit_taker" }, `${taker} forfeits: award their deposit to ${poster}`),
      h("option", { value: "forfeit_poster" }, `${poster} forfeits: award their deposit to ${taker}`));
    const note = h("textarea", { rows: 3, maxlength: 1000, "aria-label": "Note", placeholder: "Explain the ruling in a few sentences. Both people will read this." });
    const msg = h("div", { "aria-live": "polite" });
    const submit = h("button", { class: "btn primary", type: "submit" }, "Record ruling");
    const form = h("form", { class: "stack", novalidate: true },
      h("h3", {}, "Your ruling"),
      h("div", { class: "field" }, choice),
      h("div", { class: "field" }, note),
      msg, h("div", { class: "row" }, submit));
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      if (!choice.value) { msg.replaceChildren(notice("bad", "Choose a ruling.")); return; }
      if (note.value.trim().length < 10) { msg.replaceChildren(notice("bad", "Write a short note explaining the ruling (at least 10 characters).")); return; }
      const ok = await confirmDialog({
        title: "Record this ruling?",
        body: [choice.selectedOptions[0].textContent + ".", "The deposits are settled straight away and this cannot be undone."],
        confirmLabel: "Record ruling", cancelLabel: "Go back",
      });
      if (!ok) return;
      withButton(submit, "Recording", async () => {
        await callFn("admin-resolve-dispute", { dispute_id: d.id, resolution: choice.value, admin_note: note.value.trim() });
        toast("Ruling recorded.", "good");
        await reload();
      });
    });
    return form;
  }

  // ---------- ID checks ----------
  async function verification() {
    const rows = await must(sb.from("profiles")
      .select("id,display_name,area,created_at,verification_doc_path,verification_selfie_path")
      .eq("verification_status", "pending").order("created_at"));
    if (!rows.length) return h("div", { class: "empty" }, h("h3", {}, "No ID checks waiting"), h("p", {}, "Requests appear here when someone sends their photos."));
    const urls = await signedUrls("verification", rows.flatMap((r) => [r.verification_doc_path, r.verification_selfie_path])).catch(() => ({}));

    return h("div", { class: "stack" },
      notice("", "Check that the name and face on the ID match the selfie. The photos are deleted as soon as you decide."),
      rows.map((r) => {
        const decide = async (approve, b) => {
          const ok = await confirmDialog({
            title: approve ? `Verify ${r.display_name}?` : `Reject ${r.display_name}?`,
            body: approve ? "They get a Verified tick on their profile and tasks." : "They can try again with new photos.",
            confirmLabel: approve ? "Verify" : "Reject", cancelLabel: "Go back", danger: !approve,
          });
          if (!ok) return;
          withButton(b, "Saving", async () => {
            await rpc("admin_review_verification", { p_user: r.id, p_approve: approve });
            const gone = await sb.storage.from("verification").remove([r.verification_doc_path, r.verification_selfie_path]);
            if (gone.error) toast("Decision saved, but the photos could not be deleted. Remove them in Supabase Storage.", "bad");
            else toast(approve ? "Verified." : "Rejected.", "good");
            await reload();
          });
        };
        const approveBtn = h("button", { class: "btn primary", type: "button" }, "Verify");
        const rejectBtn = h("button", { class: "btn danger", type: "button" }, "Reject");
        approveBtn.addEventListener("click", () => decide(true, approveBtn));
        rejectBtn.addEventListener("click", () => decide(false, rejectBtn));
        return h("section", { class: "panel" },
          h("h2", {}, r.display_name), h("p", { class: "small muted" }, [r.area, `Joined ${fmtDate(r.created_at)}`].filter(Boolean).join(". ")),
          photoGrid([{ url: urls[r.verification_doc_path], label: "ID" }, { url: urls[r.verification_selfie_path], label: "Selfie" }]) ?? h("p", { class: "muted" }, "The photos could not be loaded."),
          h("div", { class: "row", style: "margin-top:1rem" }, approveBtn, rejectBtn));
      }));
  }

  // ---------- Payouts ----------
  async function payouts() {
    const rows = await rpc("admin_payouts");
    const due = rows.filter((r) => r.status === "due");
    const paid = rows.filter((r) => r.status === "paid");

    const dueCard = (r) => {
      const ref = h("input", { type: "text", maxlength: 80, "aria-label": "Payment reference", placeholder: "Transfer reference, e.g. DuitNow ID" });
      const go = h("button", { class: "btn primary", type: "submit" }, "Mark as paid");
      const form = h("form", { class: "row", novalidate: true }, ref, go);
      form.addEventListener("submit", (e) => {
        e.preventDefault();
        if (ref.value.trim().length < 3) { toast("Add the transfer reference first.", "bad"); return; }
        withButton(go, "Saving", async () => {
          await rpc("admin_mark_payout_paid", { p_payout: r.payout_id, p_reference: ref.value.trim() });
          toast("Marked as paid.", "good");
          await reload();
        });
      });
      return h("section", { class: "panel" },
        h("div", { class: "row spread" },
          h("div", {}, h("strong", {}, r.display_name), " ", h("a", { href: `mailto:${r.email}` }, r.email)),
          h("strong", { style: "font-size:1.4rem" }, money(r.amount_sen))),
        h("p", { class: "small muted" }, "From the task ", h("a", { href: `#/task/${r.task_id}` }, r.task_title), `, awarded ${fmtDate(r.created_at)}.`),
        form);
    };

    return h("div", { class: "stack" },
      notice("", "Forfeited deposits stay with you until you pay them out. Email the person to ask where to send the money, transfer it (bank transfer or DuitNow), then record the reference here."),
      due.length ? due.map(dueCard) : h("div", { class: "empty" }, h("h3", {}, "Nothing to pay out"), h("p", {}, "Awarded deposits appear here.")),
      paid.length ? h("section", { class: "panel scroll-x" },
        h("h2", {}, "Paid"),
        h("table", {},
          h("thead", {}, h("tr", {}, h("th", {}, "Person"), h("th", {}, "Amount"), h("th", {}, "Paid on"), h("th", {}, "Reference"))),
          h("tbody", {}, paid.map((r) => h("tr", {}, h("td", {}, r.display_name), h("td", {}, money(r.amount_sen)), h("td", {}, fmtDate(r.paid_at)), h("td", {}, r.reference ?? "")))))) : null);
  }

  paintTabs();
  await Promise.all([loadCounts().catch(() => {}), show()]);
}
