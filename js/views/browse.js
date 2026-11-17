import { sb } from "../supabase.js";
import { publicProfiles, store, must } from "../api.js";
import { CATEGORIES, categoryLabel, CONFIG } from "../config.js";
import { h, money, depositTag, fmtDateTime, personLine, loading, errMsg, notice } from "../ui.js";

const PAGE = 18;

export default async function render(root) {
  const state = { q: "", category: "", sort: "new", from: 0 };

  const hero = h("section", { class: "hero" },
    h("div", {},
      h("h1", {}, "Small jobs for neighbours who need a hand and a little extra cash."),
      h("p", { class: "lead" }, "Post a task or take one. Both people put down a deposit, so everyone shows up."),
      h("div", { class: "row" },
        h("a", { class: "btn primary", href: "#/post" }, "Post a task"),
        h("a", { class: "btn", href: "#board" , onclick: (e) => { e.preventDefault(); document.getElementById("board-title")?.scrollIntoView({ behavior: "smooth" }); } }, "See what is open"))),
    h("div", { class: "hero-flow" },
      h("ol", {},
        h("li", {}, h("div", {}, h("strong", {}, "Post or take a task"), "Everyone sees the deposit before they commit.")),
        h("li", {}, h("div", {}, h("strong", {}, "Both deposits are held"), "Nothing is spent. It sits safely while the job is pending.")),
        h("li", {}, h("div", {}, h("strong", {}, "Job done, deposits returned"), "Back out or no-show, and your deposit is lost.")))));

  const search = h("input", { id: "f-q", type: "search", placeholder: "Painting, plants, stroller...", maxlength: 60 });
  const cat = h("select", { id: "f-cat" }, h("option", { value: "" }, "Any kind"), CATEGORIES.map((c) => h("option", { value: c.id }, c.label)));
  const sort = h("select", { id: "f-sort" },
    h("option", { value: "new" }, "Newest first"),
    h("option", { value: "reward" }, "Highest reward"),
    h("option", { value: "due" }, "Due soonest"));
  const filters = h("form", { class: "filters", role: "search" },
    h("div", { class: "field" }, h("label", { for: "f-q" }, "Search by task or town"), search),
    h("div", { class: "field" }, h("label", { for: "f-cat" }, "Kind of task"), cat),
    h("div", { class: "field" }, h("label", { for: "f-sort" }, "Order"), sort),
    h("button", { class: "btn primary", type: "submit" }, "Search"));

  const board = h("div", { class: "board" });
  const status = h("div", {});
  const more = h("button", { class: "btn", type: "button", hidden: true }, "Show more");

  root.append(hero, h("h2", { id: "board-title" }, "Open tasks"), filters, board, status, h("div", { class: "row", style: "justify-content:center;margin-top:1.25rem" }, more));

  async function load(reset) {
    if (reset) { state.from = 0; board.replaceChildren(); }
    status.replaceChildren(loading());
    more.hidden = true;
    try {
      let q = sb.from("tasks")
        .select("id,title,category,area,reward_sen,deposit_sen,due_at,poster_id,created_at")
        .eq("status", "open")
        .gt("due_at", new Date().toISOString());
      if (state.category) q = q.eq("category", state.category);
      const term = state.q.replace(/[,()%*\\]/g, " ").trim();
      if (term) q = q.or(`title.ilike.%${term}%,area.ilike.%${term}%`);
      q = state.sort === "reward" ? q.order("reward_sen", { ascending: false })
        : state.sort === "due" ? q.order("due_at", { ascending: true })
        : q.order("created_at", { ascending: false });
      const rows = await must(q.range(state.from, state.from + PAGE - 1));
      const people = await publicProfiles(rows.map((r) => r.poster_id));

      for (const t of rows) board.append(card(t, people[t.poster_id]));
      state.from += rows.length;
      more.hidden = rows.length < PAGE;
      status.replaceChildren();
      if (!board.children.length) {
        status.replaceChildren(h("div", { class: "empty" },
          h("h3", {}, state.q || state.category ? "Nothing matches that search" : "No open tasks right now"),
          h("p", {}, state.q || state.category ? "Try a different word or clear the filters." : "Be the first: someone nearby might need exactly what you can do, or you might need a hand."),
          h("a", { class: "btn primary", href: "#/post" }, "Post a task")));
      }
    } catch (e) {
      status.replaceChildren(notice("bad", errMsg(e)));
    }
  }

  filters.addEventListener("submit", (e) => {
    e.preventDefault();
    state.q = search.value; state.category = cat.value; state.sort = sort.value;
    load(true);
  });
  more.addEventListener("click", () => load(false));
  await load(true);
}

function card(t, poster) {
  const mine = store.user?.id === t.poster_id;
  return h("a", { class: "card", href: `#/task/${t.id}` },
    h("div", { class: "row spread" },
      h("span", { class: "chip" }, categoryLabel(t.category)),
      mine ? h("span", { class: "chip warn" }, "Yours") : null),
    h("h3", {}, t.title),
    h("div", { class: "reward" }, money(t.reward_sen)),
    h("div", { class: "meta" },
      h("span", {}, t.area),
      h("span", {}, "Due ", fmtDateTime(t.due_at))),
    h("div", { class: "foot" }, personLine(poster, { link: false }), depositTag(t.deposit_sen)));
}
