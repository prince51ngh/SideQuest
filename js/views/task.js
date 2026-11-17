// The task page: one task from first look to final review.
// Sections are painted separately so a new chat message never wipes a form somebody is typing in.
import { sb } from "../supabase.js";
import { store, publicProfiles, rpc, callFn, startDepositPayment, must, signedUrls } from "../api.js";
import { go } from "../app.js";
import { CONFIG, categoryLabel } from "../config.js";
import {
  h, setChildren, money, fmtDate, fmtDateTime, timeLeft, statusChip, personLine, depositTag, depositTone,
  DEPOSIT_STATUS, loading, notice, toast, confirmDialog, formDialog, withButton, viewImage, errMsg,
} from "../ui.js";
import { DISPUTE_KIND, uploadTaskPhoto, photoGrid, rulingText } from "../shared.js";

const CHAT_WRITABLE = ["reserved", "in_progress", "awaiting_confirmation", "disputed"];
const FINISHED = ["completed", "resolved"];

export default async function render(root, { params }) {
  const taskId = params[0];
  const me = store.user?.id ?? null;

  const sec = {
    head: h("section", { class: "panel" }),
    steps: h("ol", { class: "steps", "aria-label": "Progress" }),
    where: h("section", { class: "panel", hidden: true }),
    proofs: h("section", { class: "panel", hidden: true }),
    chat: h("section", { class: "panel", hidden: true }),
    dispute: h("section", { class: "panel", hidden: true }),
    review: h("section", { class: "panel", hidden: true }),
    actions: h("section", { class: "panel", "aria-live": "polite" }),
    deposits: h("section", { class: "panel" }),
  };
  const boot = loading();
  const page = h("div", { hidden: true },
    sec.head,
    sec.steps,
    h("div", { class: "task-layout" },
      h("div", { class: "task-col" }, sec.where, sec.proofs, sec.chat, sec.dispute, sec.review),
      h("aside", { class: "task-col task-side" }, sec.actions, sec.deposits)));
  root.append(boot, page);

  let data = null;
  let lastFingerprint = "";
  let stopped = false;
  let channel = null;
  let refreshTimer = null;

  // ---------- Loading ----------
  async function fetchData() {
    const task = await must(sb.from("tasks").select("*").eq("id", taskId).maybeSingle());
    if (!task) return null;
    // A signed-out visitor has me === null, and an untaken task has taker_id === null: never match those.
    const role = me && me === task.poster_id ? "poster" : me && me === task.taker_id ? "taker" : null;
    const canSee = role !== null || store.isAdmin;
    const people = await publicProfiles([task.poster_id, task.taker_id]);
    const d = { task, role, canSee, people, deposits: [], address: null, proofs: [], messages: [], disputes: [], evidence: [], reviews: [], urls: {} };
    if (!canSee) return d;

    const [deposits, address, proofs, messages, disputes, reviews] = await Promise.all([
      must(sb.from("deposits").select("id,party,user_id,amount_sen,status,last_error").eq("task_id", taskId)),
      must(sb.from("task_private").select("address").eq("task_id", taskId).maybeSingle()),
      must(sb.from("task_proofs").select("*").eq("task_id", taskId).order("created_at")),
      must(sb.from("messages").select("*").eq("task_id", taskId).order("created_at").limit(300)),
      must(sb.from("disputes").select("*").eq("task_id", taskId).order("created_at", { ascending: false })),
      must(sb.from("reviews").select("*").eq("task_id", taskId)),
    ]);
    Object.assign(d, { deposits, address, proofs, messages, disputes, reviews });
    if (disputes.length) {
      d.evidence = await must(sb.from("dispute_evidence").select("*").in("dispute_id", disputes.map((x) => x.id)).order("created_at"));
    }
    const paths = [...proofs.map((p) => p.file_path), ...messages.map((m) => m.file_path), ...d.evidence.map((e) => e.file_path)];
    d.urls = await signedUrls("task-files", paths).catch(() => ({}));
    return d;
  }

  const fingerprint = (d) => JSON.stringify([
    d.task.status, d.task.taker_id, d.task.marked_done_at,
    d.deposits.map((x) => x.id + x.status), d.proofs.length, d.evidence.length,
    d.disputes.map((x) => x.id + x.status), d.reviews.length, d.address?.address ?? "",
  ]);

  async function refresh(force = false) {
    let d;
    try {
      d = await fetchData();
    } catch (e) {
      if (!data) { boot.replaceChildren(notice("bad", errMsg(e))); }
      else toast(errMsg(e), "bad");
      return;
    }
    if (stopped) return;
    if (!d) { showMissing(); return; }
    data = d;
    boot.remove();
    page.hidden = false;
    const fp = fingerprint(d);
    if (!force && fp === lastFingerprint) { paintChat(d); return; }
    lastFingerprint = fp;
    paintAll(d);
    if (!channel && me && d.canSee) subscribe();
  }

  function showMissing() {
    stopped = true;
    root.replaceChildren(h("div", { class: "empty" },
      h("h3", {}, "This task is not available"),
      h("p", {}, "It may have been taken, finished or removed.", me ? "" : " If it is your task, sign in to see it."),
      h("div", { class: "row", style: "justify-content:center" },
        h("a", { class: "btn primary", href: "#/" }, "See open tasks"),
        me ? null : h("a", { class: "btn", href: `#/login?next=${encodeURIComponent("/task/" + taskId)}` }, "Sign in"))));
  }

  function subscribe() {
    channel = sb.channel(`task-${taskId}`)
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "tasks", filter: `id=eq.${taskId}` }, () => {
        clearTimeout(refreshTimer);
        refreshTimer = setTimeout(() => refresh(), 400);
      })
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "messages", filter: `task_id=eq.${taskId}` }, async (p) => {
        const m = p.new;
        let url = null;
        if (m.file_path) url = (await signedUrls("task-files", [m.file_path]).catch(() => ({})))[m.file_path] ?? null;
        addMessage(m, url);
      })
      .subscribe();
  }

  function paintAll(d) {
    paintHead(d);
    paintSteps(d);
    paintWhere(d);
    paintProofs(d);
    paintChat(d);
    paintDispute(d);
    paintReview(d);
    paintActions(d);
    paintDeposits(d);
  }

  const posterName = () => data.people[data.task.poster_id]?.display_name ?? "the poster";
  const takerName = () => data.people[data.task.taker_id]?.display_name ?? "the taker";
  const prose = (text) => h("div", { class: "prose" }, text);

  // ---------- Head and steps ----------
  function paintHead(d) {
    const t = d.task;
    const poster = d.people[t.poster_id];
    const taker = d.people[t.taker_id];
    document.title = `${t.title} | ${CONFIG.appName}`;
    sec.head.replaceChildren(
      h("div", { class: "row spread" },
        h("div", { class: "row" }, h("span", { class: "chip" }, categoryLabel(t.category)), statusChip(t.status)),
        d.role ? h("span", { class: "chip warn" }, d.role === "poster" ? "You posted this" : "You took this") : null),
      h("h1", { class: "task-title" }, t.title),
      h("div", { class: "reward-big" }, money(t.reward_sen)),
      h("p", { class: "small muted" }, `Reward. ${poster?.display_name ?? "The poster"} pays it directly to the person who does the job. ${CONFIG.appName} only holds the deposits.`),
      h("dl", { class: "kv" },
        h("dt", {}, "Where"), h("dd", {}, t.area),
        h("dt", {}, "Needed by"), h("dd", {}, fmtDateTime(t.due_at)),
        h("dt", {}, "Posted by"), h("dd", {}, personLine(poster)),
        taker ? [h("dt", {}, "Taken by"), h("dd", {}, personLine(taker))] : null),
      prose(t.description));
  }

  function paintSteps(d) {
    const t = d.task;
    const labels = ["Poster's deposit paid", "Taker's deposit paid", "Marked done", "Confirmed"];
    const on = {
      awaiting_poster_deposit: 0, open: 1, reserved: 1, in_progress: 2, awaiting_confirmation: 3, completed: 4,
      disputed: t.marked_done_at ? 3 : 2,
    }[t.status] ?? 0;
    sec.steps.hidden = ["cancelled", "resolved"].includes(t.status);
    sec.steps.classList.toggle("bad", t.status === "disputed");
    sec.steps.replaceChildren(...labels.map((text, i) =>
      h("li", { class: i < on ? "on" : i === on ? "now" : "" }, text)));
  }

  // ---------- Address ----------
  function paintWhere(d) {
    const t = d.task;
    let body = null;
    if (d.address?.address) body = prose(d.address.address);
    else if (d.role === "taker" && t.status === "reserved") body = h("p", { class: "muted" }, "The exact address unlocks as soon as your deposit is paid.");
    else if (!d.role && !store.isAdmin) body = h("p", { class: "muted" }, "The exact address is only shared with the person who takes the task, once both deposits are held.");
    sec.where.hidden = !body;
    if (body) sec.where.replaceChildren(h("h2", {}, "Exact address"), body);
  }

  // ---------- Photos of the work ----------
  function paintProofs(d) {
    const t = d.task;
    const canAdd = d.role === "taker" && ["in_progress", "awaiting_confirmation"].includes(t.status);
    sec.proofs.hidden = !(d.canSee && (d.proofs.length || canAdd));
    if (sec.proofs.hidden) return;
    const photos = d.proofs.map((p) => ({
      url: d.urls[p.file_path], caption: p.caption, label: p.kind === "completion" ? "Finished" : "Progress",
    }));
    setChildren(sec.proofs,
      h("h2", {}, "Photos of the work"),
      h("p", { class: "small muted" }, "Only the two people on this task (and the team, if there is ever a disagreement) can see these."),
      photoGrid(photos) ?? h("p", { class: "muted" }, "No photos yet. Add some as you go, and one of the finished job."),
      canAdd ? h("div", { class: "row", style: "margin-top:.9rem" }, button("Add a photo", "small", (b) => addPhoto(b, "progress"))) : null);
  }

  // ---------- Chat ----------
  const chat = { built: false, seen: new Set(), log: null, form: null };

  function paintChat(d) {
    const t = d.task;
    const visible = d.canSee && !!t.taker_id && (CHAT_WRITABLE.includes(t.status) || FINISHED.includes(t.status));
    sec.chat.hidden = !visible;
    if (!visible) return;
    if (!chat.built) {
      chat.log = h("div", { class: "chat", role: "log", "aria-live": "polite", "aria-label": "Messages" });
      chat.form = buildChatForm();
      sec.chat.replaceChildren(
        h("h2", {}, "Messages"),
        h("p", { class: "small muted" }, "Only you and the other person can read these. Keep your arrangements here, so there is a record if the team ever needs to step in."),
        chat.log, chat.form);
      chat.built = true;
    }
    chat.form.hidden = !(d.role && CHAT_WRITABLE.includes(t.status));
    if (!chat.seen.size && !chat.log.querySelector(".chat-empty")) {
      chat.log.append(h("p", { class: "muted chat-empty" }, "No messages yet."));
    }
    for (const m of d.messages) addMessage(m, d.urls[m.file_path] ?? null);
  }

  function addMessage(m, url) {
    if (!chat.built || chat.seen.has(m.id)) return;
    chat.seen.add(m.id);
    chat.log.querySelector(".chat-empty")?.remove();
    const mine = m.sender_id === me;
    chat.log.append(h("div", { class: `msg ${mine ? "mine" : ""}` },
      m.body ? h("div", {}, m.body) : null,
      url ? h("img", { src: url, alt: "Photo sent in the chat", loading: "lazy", onclick: () => viewImage(url) }) : null,
      h("time", { datetime: m.created_at }, mine ? "" : `${data?.people[m.sender_id]?.display_name ?? "Them"}, `, fmtDateTime(m.created_at))));
    chat.log.scrollTop = chat.log.scrollHeight;
  }

  function buildChatForm() {
    const input = h("input", { type: "text", maxlength: 1000, placeholder: "Write a message", "aria-label": "Message", autocomplete: "off" });
    const file = h("input", { type: "file", accept: "image/*", hidden: true });
    const picked = h("span", { class: "small muted" });
    const send = h("button", { class: "btn primary small", type: "submit" }, "Send");
    const attach = h("button", { class: "btn small", type: "button", onclick: () => file.click() }, "Add photo");
    file.addEventListener("change", () => { picked.textContent = file.files[0]?.name ?? ""; });
    const form = h("form", { class: "chat-form" },
      h("div", { class: "row", style: "flex-wrap:nowrap" }, input, attach, send), picked, file);
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const body = input.value.trim();
      const photo = file.files[0] ?? null;
      if (!body && !photo) return;
      withButton(send, "Sending", async () => {
        const path = photo ? await uploadTaskPhoto(taskId, photo) : null;
        const row = await must(sb.from("messages").insert({ task_id: taskId, sender_id: me, body, file_path: path }).select().single());
        const url = path ? (await signedUrls("task-files", [path]).catch(() => ({})))[path] ?? null : null;
        addMessage(row, url);
        input.value = ""; file.value = ""; picked.textContent = "";
      });
    });
    return form;
  }

  // ---------- Dispute ----------
  function paintDispute(d) {
    const t = d.task;
    const disp = d.disputes[0];
    sec.dispute.hidden = !disp;
    if (!disp) return;
    const open = disp.status === "open";
    const evidence = d.evidence.filter((e) => e.dispute_id === disp.id);
    const sideOf = (uid) => (uid === t.poster_id ? "poster" : "taker");
    const nameOf = (uid) => d.people[uid]?.display_name ?? "Someone";
    const haveEvidence = (uid) => evidence.some((e) => e.user_id === uid);

    const parts = [
      h("h2", {}, open ? "Under review" : "Settled by the team"),
      h("p", {}, h("strong", {}, DISPUTE_KIND[disp.kind] ?? disp.kind), `. Raised by ${nameOf(disp.raised_by)} on ${fmtDate(disp.created_at)}.`),
      prose(disp.description),
    ];
    if (open) {
      parts.push(notice("warn",
        h("strong", {}, "Both deposits are frozen. "),
        `Each of you can add evidence (photos, messages, what happened) until ${fmtDateTime(disp.evidence_deadline)}. The team rules once both of you have added evidence, or after that time.`,
        h("div", { class: "small", style: "margin-top:.4rem" },
          `${nameOf(t.poster_id)}: ${haveEvidence(t.poster_id) ? "evidence added" : "no evidence yet"}. `,
          `${nameOf(t.taker_id)}: ${haveEvidence(t.taker_id) ? "evidence added" : "no evidence yet"}.`)));
    } else {
      parts.push(notice("",
        h("strong", {}, rulingText(disp, t, d.people)),
        disp.admin_note ? h("p", { class: "small", style: "margin:.4rem 0 0" }, `The team's note: ${disp.admin_note}`) : null));
    }
    parts.push(h("h3", { style: "margin-top:1.1rem" }, "Evidence"));
    if (!evidence.length) parts.push(h("p", { class: "muted" }, "Nothing added yet."));
    for (const e of evidence) {
      parts.push(h("div", { class: `evidence ${sideOf(e.user_id)}` },
        h("div", { class: "small muted" }, `${nameOf(e.user_id)}, ${fmtDateTime(e.created_at)}`),
        prose(e.note),
        photoGrid([{ url: d.urls[e.file_path], caption: "" }])));
    }
    if (open && d.role) parts.push(h("div", { class: "row" }, button("Add evidence", "primary small", (b) => addEvidence(b, disp))));
    sec.dispute.replaceChildren(...parts);
  }

  // ---------- Reviews ----------
  function paintReview(d) {
    const t = d.task;
    sec.review.hidden = !(d.canSee && FINISHED.includes(t.status));
    if (sec.review.hidden) return;
    const mine = d.reviews.find((r) => r.reviewer_id === me);
    const other = d.role === "poster" ? d.people[t.taker_id] : d.people[t.poster_id];
    const parts = [h("h2", {}, "Reviews")];
    if (d.role && !mine) parts.push(reviewForm(other));
    if (!d.reviews.length) parts.push(h("p", { class: "muted" }, "No reviews yet."));
    for (const r of d.reviews) {
      parts.push(h("div", { class: "evidence" },
        h("div", {}, h("span", { class: "stars" }, "★".repeat(r.rating) + "☆".repeat(5 - r.rating)), " ",
          h("span", { class: "small muted" }, `${d.people[r.reviewer_id]?.display_name ?? "Someone"}, ${fmtDate(r.created_at)}`)),
        r.comment ? prose(r.comment) : null));
    }
    sec.review.replaceChildren(...parts);
  }

  function reviewForm(other) {
    let rating = 0;
    const group = h("div", { class: "rate", role: "radiogroup", "aria-label": "Rating out of 5" });
    const stars = [1, 2, 3, 4, 5].map((n) => {
      const b = h("button", { type: "button", role: "radio", "aria-checked": "false", "aria-label": `${n} out of 5` }, "★");
      b.addEventListener("click", () => {
        rating = n;
        stars.forEach((s, i) => { s.classList.toggle("on", i < n); s.setAttribute("aria-checked", String(i === n - 1)); });
      });
      return b;
    });
    group.append(...stars);
    const comment = h("textarea", { id: "rv-comment", maxlength: 500, rows: 3, placeholder: "How did it go? Was it on time, as described, easy to deal with?" });
    const msg = h("div", { "aria-live": "polite" });
    const submit = h("button", { class: "btn primary", type: "submit" }, "Post review");
    const form = h("form", { class: "stack" },
      h("p", {}, `How was ${other?.display_name ?? "the other person"}?`), group,
      h("div", { class: "field" }, h("label", { for: "rv-comment" }, "A few words (optional)"), comment), msg, h("div", { class: "row" }, submit));
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      if (!rating) { msg.replaceChildren(notice("bad", "Choose a star rating first.")); return; }
      withButton(submit, "Posting", async () => {
        await rpc("submit_review", { p_task: taskId, p_rating: rating, p_comment: comment.value.trim() || null });
        toast("Review posted.", "good");
        await refresh(true);
      });
    });
    return h("div", { class: "panel flat", style: "background:var(--paper)" }, form);
  }

  // ---------- Deposits ----------
  function paintDeposits(d) {
    const t = d.task;
    const live = (party) => d.deposits.find((x) => x.party === party && x.status !== "cancelled");
    const row = (party) => {
      const dep = live(party);
      const person = d.people[party === "poster" ? t.poster_id : t.taker_id];
      return h("div", { class: "dep-row" },
        h("div", {}, h("strong", {}, party === "poster" ? "Poster" : "Taker"),
          h("div", { class: "small muted" }, person?.display_name ?? (party === "taker" ? "Nobody yet" : ""))),
        dep
          ? h("div", { class: "dep-state" },
              depositTag(dep.amount_sen, { tone: depositTone(dep.status), note: DEPOSIT_STATUS[dep.status] ?? dep.status }),
              store.isAdmin && dep.last_error ? h("div", { class: "small", style: "color:var(--raspberry)" }, dep.last_error) : null)
          : h("span", { class: "small muted" }, party === "taker" ? "Not taken yet" : "Not paid yet"));
    };
    const refunding = d.deposits.some((x) => ["refund_pending", "refunded"].includes(x.status));
    setChildren(sec.deposits,
      h("h2", { class: "side-title" }, "Deposits"),
      h("p", { class: "small muted" }, "Both people put down the same amount. It is held while the task is pending, then returned. Back out or no-show, and the team can award it to the person who was let down."),
      d.canSee && d.deposits.length
        ? h("div", { class: "dep-list" }, row("poster"), row("taker"))
        : depositTag(t.deposit_sen, { big: true, note: "each" }),
      refunding ? h("p", { class: "small muted", style: "margin:.8rem 0 0" }, "Refunds go back to the card or bank account that paid. Banks can take up to 14 days to show them.") : null);
  }

  // ---------- Actions ----------
  function button(label, cls, onClick) {
    const b = h("button", { class: `btn ${cls}`, type: "button" }, label);
    b.addEventListener("click", () => onClick(b));
    return b;
  }

  function paintActions(d) {
    const t = d.task;
    const dep = money(t.deposit_sen);
    const reward = money(t.reward_sen);
    const title = (text) => h("h2", { class: "side-title" }, text);
    const para = (...c) => h("p", {}, ...c);
    const buttons = (...b) => h("div", { class: "row" }, ...b.filter(Boolean));
    let content;

    if (!d.role) {
      if (store.isAdmin) {
        content = [title("Admin view"), para("You can see everything on this task. Rulings and payouts are in the admin area."), buttons(h("a", { class: "btn", href: "#/admin" }, "Open admin"))];
      } else if (t.status === "open" && new Date(t.due_at) > new Date()) {
        content = me
          ? [title("Take this task"),
             para(`Put down a ${dep} deposit and the job is yours. You get the deposit back when the job is done.`),
             buttons(button("Take it", "primary", takeTask))]
          : [title("Want this job?"),
             para(`Sign in to take it. You will put down a ${dep} deposit, which comes back when the job is done.`),
             buttons(h("a", { class: "btn primary", href: `#/login?next=${encodeURIComponent("/task/" + taskId)}` }, "Sign in to take it"))];
      } else {
        content = [title("Not open"), para("This task is no longer open.")];
      }
    } else if (d.role === "poster") {
      switch (t.status) {
        case "awaiting_poster_deposit":
          content = [title("Pay your deposit to publish"),
            para(`Your task is saved but not on the board yet. Pay the ${dep} deposit to publish it. You get it back when the job is done, or if you cancel before anyone takes it.`),
            buttons(button("Pay deposit", "primary", (b) => withButton(b, "Opening payment", () => startDepositPayment(taskId))),
              button("Delete this draft", "danger", (b) => cancelTask(b, true)))];
          break;
        case "open":
          content = [title("On the board"),
            para("Waiting for someone to take it. When they do, they pay the same deposit and the job starts."),
            buttons(button("Cancel and refund my deposit", "danger", (b) => cancelTask(b, false)))];
          break;
        case "reserved":
          content = [title(`${takerName()} is taking this`),
            para(`They have until ${fmtDateTime(t.reserved_until)} (about ${timeLeft(t.reserved_until)}) to pay their deposit. If they do not, the task goes back on the board.`)];
          break;
        case "in_progress":
          content = [title("The job is under way"),
            para(`${takerName()} has the address and has paid the same deposit. They will mark the job done when it is finished, and then you confirm.`),
            buttons(button("Report a problem", "", (b) => reportProblem(b)), button("Back out", "danger", (b) => backOut(b)))];
          break;
        case "awaiting_confirmation":
          content = [title("Check the work"),
            para(`${takerName()} says the job is done.`, t.done_note ? ` Their note: “${t.done_note}”` : ""),
            para("Look at the photos, then confirm. Both deposits go back to their owners."),
            h("p", { class: "small muted" }, `If you do not answer by ${fmtDateTime(t.auto_confirm_at)}, it is confirmed for you.`),
            buttons(button("Confirm it is done", "primary", confirmDone), button("Something is wrong", "danger", (b) => reportProblem(b)))];
          break;
        case "completed":
          content = [title("Done"), para("Both deposits are being returned."), para(`Have you paid ${takerName()} the ${reward} reward? It goes directly to them.`)];
          break;
        case "disputed":
          content = [title("Under review"), para("The team is looking into this. Add your evidence on this page.")];
          break;
        case "resolved":
          content = [title("Settled"), para("The team has ruled. The details are on this page.")];
          break;
        default:
          content = [title("Cancelled"), para("This task was cancelled. Your deposit is returned.")];
      }
    } else {
      switch (t.status) {
        case "reserved":
          content = [title("Pay your deposit to start"),
            para(`Pay ${dep} within about ${timeLeft(t.reserved_until)} to lock the job in. You get it back when the job is done. If you back out or do not show up, the team can award it to ${posterName()}.`),
            buttons(button("Pay deposit", "primary", (b) => withButton(b, "Opening payment", () => startDepositPayment(taskId))),
              button("I changed my mind", "quiet", releaseReservation))];
          break;
        case "in_progress":
          content = [title("You are on this one"),
            para("Add photos as you go. When the job is finished, add a photo of the result and mark it done."),
            buttons(button("Mark as done", "primary", markDone), button("Report a problem", "", (b) => reportProblem(b)), button("Back out", "danger", (b) => backOut(b)))];
          break;
        case "awaiting_confirmation":
          content = [title("Waiting for confirmation"),
            para(`${posterName()} will check your work. If they do not answer by ${fmtDateTime(t.auto_confirm_at)}, it is confirmed for you and your deposit comes back.`),
            h("p", { class: "small muted" }, `The ${reward} reward is paid by ${posterName()} directly to you.`),
            buttons(button("Report a problem", "", (b) => reportProblem(b)))];
          break;
        case "completed":
          content = [title("Done"), para("Both deposits are being returned."), h("p", { class: "small muted" }, `Your ${reward} reward comes directly from ${posterName()}.`)];
          break;
        case "disputed":
          content = [title("Under review"), para("The team is looking into this. Add your evidence on this page.")];
          break;
        case "resolved":
          content = [title("Settled"), para("The team has ruled. The details are on this page.")];
          break;
        default:
          content = [title("Closed"), para("This task is closed.")];
      }
    }
    sec.actions.replaceChildren(...content);
  }

  // ---------- Action handlers ----------
  async function takeTask(b) {
    const t = data.task;
    const ok = await confirmDialog({
      title: "Take this task?",
      body: [
        `You will pay a ${money(t.deposit_sen)} deposit now. It is held while the task is pending and returned when the job is done.`,
        `If you back out or do not show up, the team can award your deposit to ${posterName()}, who has put down the same amount.`,
        `The ${money(t.reward_sen)} reward is paid by ${posterName()} directly to you.`,
      ],
      confirmLabel: `Take it and pay ${money(t.deposit_sen)}`, cancelLabel: "Not now",
    });
    if (!ok) return;
    await withButton(b, "Reserving the task", async () => {
      await rpc("reserve_task", { p_task: taskId });
      try {
        await startDepositPayment(taskId); // leaves the page for Stripe
      } catch (e) {
        toast(`${errMsg(e)} Your place is saved for 45 minutes. Open the task again to pay.`, "bad");
        await refresh(true);
      }
    });
  }

  async function releaseReservation(b) {
    const ok = await confirmDialog({
      title: "Give this task back?", body: "You have not paid anything yet, so there is nothing to lose. The task goes back on the board.",
      confirmLabel: "Give it back", cancelLabel: "Keep it",
    });
    if (!ok) return;
    await withButton(b, "Releasing", async () => {
      await rpc("release_reservation", { p_task: taskId });
      toast("The task is back on the board.");
      await refresh(true);
    });
  }

  async function cancelTask(b, draft) {
    const ok = await confirmDialog({
      title: draft ? "Delete this draft?" : "Cancel this task?",
      body: draft ? "Nothing has been charged." : `Nobody has taken it, so your ${money(data.task.deposit_sen)} deposit is refunded in full. Banks can take up to 14 days to show the refund.`,
      confirmLabel: draft ? "Delete it" : "Cancel and refund", cancelLabel: "Keep it", danger: true,
    });
    if (!ok) return;
    await withButton(b, "Cancelling", async () => {
      await callFn("cancel-task", { task_id: taskId });
      toast(draft ? "Draft deleted." : "Task cancelled. Your refund is on its way.", "good");
      go("/mine");
    });
  }

  async function addPhoto(b, kind) {
    const v = await formDialog({
      title: "Add a photo",
      intro: `Photos help if there is ever a disagreement. Only you and ${posterName()} can see them.`,
      fields: [
        { name: "kind", label: "What is it?", type: "select", value: kind, options: [{ value: "progress", label: "Progress photo" }, { value: "completion", label: "The finished work" }] },
        { name: "photo", label: "Photo", type: "file", required: true },
        { name: "caption", label: "Caption (optional)", max: 200 },
      ],
      submitLabel: "Upload photo",
    });
    if (!v) return;
    await withButton(b, "Uploading", async () => {
      const path = await uploadTaskPhoto(taskId, v.photo);
      await must(sb.from("task_proofs").insert({ task_id: taskId, user_id: me, kind: v.kind, file_path: path, caption: v.caption || null }));
      toast("Photo added.", "good");
      await refresh(true);
    });
  }

  async function markDone(b) {
    if (!data.proofs.some((p) => p.kind === "completion")) {
      toast("Add a photo of the finished work first.", "bad");
      await addPhoto(b, "completion");
      return;
    }
    const v = await formDialog({
      title: "Mark this job as done?",
      intro: `${posterName()} will be asked to confirm. If they do not answer within 48 hours, it is confirmed for them and both deposits are returned.`,
      fields: [{ name: "note", label: `Note for ${posterName()} (optional)`, type: "textarea", rows: 3, max: 500 }],
      submitLabel: "Mark as done",
    });
    if (!v) return;
    await withButton(b, "Saving", async () => {
      await rpc("mark_done", { p_task: taskId, p_note: v.note || null });
      toast("Marked as done. Waiting for confirmation.", "good");
      await refresh(true);
    });
  }

  async function confirmDone(b) {
    const ok = await confirmDialog({
      title: "Confirm the job is done?",
      body: [`Both deposits go back to their owners. This cannot be undone.`, `Pay ${takerName()} the ${money(data.task.reward_sen)} reward directly, then confirm.`],
      confirmLabel: "Yes, it is done", cancelLabel: "Not yet",
    });
    if (!ok) return;
    await withButton(b, "Confirming", async () => {
      await callFn("complete-task", { task_id: taskId });
      toast("Confirmed. Both deposits are on their way back.", "good");
      await refresh(true);
    });
  }

  async function reportProblem(b) {
    const kinds = data.role === "poster" ? ["not_completed", "poor_quality", "no_show", "other"] : ["no_show", "other"];
    const v = await formDialog({
      title: "Report a problem",
      intro: "Both deposits are frozen while the team reviews. You and the other person each add evidence, then the team decides what happens to the deposits.",
      fields: [
        { name: "kind", label: "What went wrong?", type: "select", options: kinds.map((k) => ({ value: k, label: DISPUTE_KIND[k] })) },
        { name: "description", label: "What happened?", type: "textarea", required: true, min: 10, hint: "Be specific: dates, times and what was agreed. For example, if the reward was not paid, say so here." },
      ],
      submitLabel: "Report it", danger: true,
    });
    if (!v) return;
    await withButton(b, "Reporting", async () => {
      await rpc("raise_dispute", { p_task: taskId, p_kind: v.kind, p_description: v.description });
      toast("Reported. Add your evidence below.", "good");
      await refresh(true);
    });
  }

  async function backOut(b) {
    const t = data.task;
    const other = data.role === "poster" ? takerName() : posterName();
    const ok = await confirmDialog({
      title: "Back out of this task?",
      body: [
        `Your ${money(t.deposit_sen)} deposit is frozen while the team reviews. If they decide you let ${other} down, your deposit is awarded to ${other}.`,
        `${other}'s deposit is returned to them. The task does not go back on the board.`,
        "You cannot undo this.",
      ],
      confirmLabel: "Yes, back out", cancelLabel: "Keep going", danger: true,
    });
    if (!ok) return;
    const v = await formDialog({
      title: "Tell the team why",
      intro: `${other} will see what you write.`,
      fields: [{ name: "description", label: "Your reason", type: "textarea", required: true, min: 10 }],
      submitLabel: "Back out", danger: true,
    });
    if (!v) return;
    await withButton(b, "Backing out", async () => {
      await rpc("raise_dispute", { p_task: taskId, p_kind: "back_out", p_description: v.description });
      toast("You have backed out. Add any evidence below.");
      await refresh(true);
    });
  }

  async function addEvidence(b, dispute) {
    const v = await formDialog({
      title: "Add evidence",
      intro: "Say what happened and add a photo or screenshot if you have one. Both of you can add as many pieces as you like.",
      fields: [
        { name: "note", label: "What does this show?", type: "textarea", required: true, min: 3 },
        { name: "photo", label: "Photo or screenshot (optional)", type: "file" },
      ],
      submitLabel: "Add evidence",
    });
    if (!v) return;
    await withButton(b, "Saving", async () => {
      const path = v.photo ? await uploadTaskPhoto(taskId, v.photo) : null;
      await must(sb.from("dispute_evidence").insert({ dispute_id: dispute.id, user_id: me, note: v.note, file_path: path }));
      toast("Evidence added.", "good");
      await refresh(true);
    });
  }

  // ---------- Go ----------
  await refresh(true);
  const poll = setInterval(() => {
    if (document.hidden || !data || ["completed", "resolved", "cancelled"].includes(data.task.status)) return;
    refresh();
  }, 20000);

  return () => {
    stopped = true;
    clearInterval(poll);
    clearTimeout(refreshTimer);
    if (channel) sb.removeChannel(channel);
    document.title = `${CONFIG.appName}: small jobs, fair deposits`;
  };
}
