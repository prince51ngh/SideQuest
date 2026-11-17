// Where Stripe sends people after paying. The webhook can take a few seconds to confirm the payment.
import { sb } from "../supabase.js";
import { store } from "../api.js";
import { h, loading, notice, money } from "../ui.js";

export default async function render(root, { params }) {
  const taskId = params[0];
  const box = h("div", { class: "panel stack", style: "max-width:560px;margin-inline:auto;text-align:center" }, loading("Confirming your payment"));
  root.append(box);

  let stopped = false;
  const started = Date.now();

  async function check() {
    if (stopped) return;
    const { data } = await sb.from("deposits")
      .select("party,amount_sen,status")
      .eq("task_id", taskId).eq("user_id", store.user.id)
      .in("status", ["held", "refund_pending", "refunded"]).maybeSingle();

    if (data) {
      box.replaceChildren(
        h("h1", { style: "font-size:2rem" }, "Deposit received"),
        h("p", {}, `${money(data.amount_sen)} is now held safely.`),
        data.party === "poster"
          ? notice("", "Your task is live on the board. We will show it as soon as someone takes it.")
          : notice("", "You are in. The task has started and the exact address is now unlocked for you."),
        h("a", { class: "btn primary", href: `#/task/${taskId}` }, "Go to the task"));
      return;
    }
    if (Date.now() - started > 45000) {
      box.replaceChildren(
        h("h1", { style: "font-size:2rem" }, "Still waiting for the bank"),
        h("p", {}, "Bank transfers can take a few minutes to confirm. You can leave this page: the task will update by itself once the payment lands."),
        h("a", { class: "btn primary", href: `#/task/${taskId}` }, "Open the task"));
      return;
    }
    setTimeout(check, 2000);
  }
  check();
  return () => { stopped = true; };
}
