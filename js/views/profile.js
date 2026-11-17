// Profiles. /me is editable and holds the verification request; /user/<id> is what everyone else sees.
import { sb } from "../supabase.js";
import {
  store, publicProfiles, must, rpc, refreshSession, forgetProfiles, uploadImage, newFileName,
} from "../api.js";
import {
  h, append, loading, notice, toast, withButton, errMsg, initials, verifiedBadge, fmtDate, compressImage,
} from "../ui.js";

export default async function render(root, { params }) {
  const meId = store.user?.id ?? null;
  const id = params[0] && params[0] !== meId ? params[0] : meId;
  const isMe = id !== null && id === meId;
  root.append(loading());

  let pub, reviews;
  try {
    [pub, reviews] = await Promise.all([
      must(sb.from("public_profiles").select("*").eq("id", id).maybeSingle()),
      must(sb.from("reviews").select("*").eq("reviewee_id", id).order("created_at", { ascending: false }).limit(50)),
    ]);
  } catch (e) {
    root.replaceChildren(notice("bad", errMsg(e)));
    return;
  }
  if (!pub) {
    root.replaceChildren(h("div", { class: "empty" }, h("h3", {}, "We could not find that person"), h("a", { class: "btn primary", href: "#/" }, "Back to the board")));
    return;
  }
  const reviewers = await publicProfiles(reviews.map((r) => r.reviewer_id)).catch(() => ({}));

  const avg = Number(pub.rating_avg);
  const header = h("section", { class: "panel profile-head" },
    h("span", { class: "avatar big", "aria-hidden": "true" }, initials(pub.display_name)),
    h("div", {},
      h("h1", { class: "profile-name" }, pub.display_name, " ", pub.verified ? verifiedBadge() : null),
      h("div", { class: "muted" }, [pub.area, `Joined ${fmtDate(pub.created_at)}`].filter(Boolean).join(". ")),
      h("div", { class: "profile-stats" },
        Number(pub.rating_count) > 0
          ? h("span", {}, h("span", { class: "stars" }, "★"), ` ${avg.toFixed(1)} from ${pub.rating_count} ${Number(pub.rating_count) === 1 ? "review" : "reviews"}`)
          : h("span", { class: "muted" }, "No reviews yet"),
        h("span", {}, `${pub.finished_count} ${Number(pub.finished_count) === 1 ? "task" : "tasks"} finished`))));

  const parts = [header];

  if (isMe) {
    parts.push(editPanel(), verificationPanel());
  } else if (pub.bio) {
    parts.push(h("section", { class: "panel" }, h("h2", {}, "About"), h("div", { class: "prose" }, pub.bio)));
  }

  parts.push(h("section", { class: "panel" },
    h("h2", {}, isMe ? "What people said about you" : "Reviews"),
    reviews.length
      ? reviews.map((r) => h("div", { class: "evidence" },
          h("div", {}, h("span", { class: "stars" }, "★".repeat(r.rating) + "☆".repeat(5 - r.rating)), " ",
            h("span", { class: "small muted" }, reviewers[r.reviewer_id]
              ? h("a", { href: `#/user/${r.reviewer_id}` }, reviewers[r.reviewer_id].display_name)
              : "Someone", `, ${fmtDate(r.created_at)}`)),
          r.comment ? h("div", { class: "prose" }, r.comment) : null))
      : h("p", { class: "muted" }, "Reviews appear here after a task is finished.")));

  root.replaceChildren(...parts);

  // ---------- Own profile ----------
  function editPanel() {
    const p = store.profile ?? {};
    const name = h("input", { id: "pf-name", maxlength: 40, value: p.display_name ?? "" });
    const area = h("input", { id: "pf-area", maxlength: 60, value: p.area ?? "", placeholder: "Town or neighbourhood" });
    const bio = h("textarea", { id: "pf-bio", maxlength: 300, rows: 3, placeholder: "A line or two so people know who they are dealing with." });
    bio.value = p.bio ?? "";
    const msg = h("div", { "aria-live": "polite" });
    const save = h("button", { class: "btn primary", type: "submit" }, "Save changes");
    const form = h("form", { class: "stack", novalidate: true },
      h("div", { class: "two" },
        h("div", { class: "field" }, h("label", { for: "pf-name" }, "Name people see"), name),
        h("div", { class: "field" }, h("label", { for: "pf-area" }, "Your area"), area)),
      h("div", { class: "field" }, h("label", { for: "pf-bio" }, "About you"), bio, h("div", { class: "hint" }, "Up to 300 characters. Everyone can read this.")),
      msg, h("div", { class: "row" }, save));
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      msg.replaceChildren();
      if (name.value.trim().length < 2) { msg.replaceChildren(notice("bad", "Your name needs at least 2 characters.")); return; }
      withButton(save, "Saving", async () => {
        await must(sb.from("profiles").update({
          display_name: name.value.trim(), area: area.value.trim() || null, bio: bio.value.trim() || null,
        }).eq("id", meId));
        await refreshSession();
        forgetProfiles();
        toast("Saved.", "good");
        window.dispatchEvent(new HashChangeEvent("hashchange")); // redraws the page and the top bar
      });
    });
    return h("section", { class: "panel" }, h("h2", {}, "Your details"), form);
  }

  function verificationPanel() {
    const status = store.profile?.verification_status ?? "none";
    const box = h("section", { class: "panel" }, h("h2", {}, "Verified profile"));

    if (status === "verified") {
      box.append(notice("", verifiedBadge(), " The team has checked your ID. This tick shows next to your name on every task."));
      return box;
    }
    if (status === "pending") {
      box.append(notice("warn", h("strong", {}, "We are checking your photos. "), "This usually takes a day or two. You can keep using the site meanwhile."));
      return box;
    }

    const doc = h("input", { id: "vf-doc", type: "file", accept: "image/*" });
    const selfie = h("input", { id: "vf-selfie", type: "file", accept: "image/*" });
    const msg = h("div", { "aria-live": "polite" });
    const send = h("button", { class: "btn primary", type: "submit" }, "Send for checking");
    const form = h("form", { class: "stack", novalidate: true },
      h("div", { class: "field" }, h("label", { for: "vf-doc" }, "Photo of your ID (IC or passport)"), doc,
        h("div", { class: "hint" }, "We only need to see your name and your face. You can cover the ID number.")),
      h("div", { class: "field" }, h("label", { for: "vf-selfie" }, "A selfie holding the same ID"), selfie),
      msg, h("div", { class: "row" }, send));

    form.addEventListener("submit", (e) => {
      e.preventDefault();
      msg.replaceChildren();
      if (!doc.files[0] || !selfie.files[0]) { msg.replaceChildren(notice("bad", "Add both photos.")); return; }
      withButton(send, "Sending", async () => {
        const [docBlob, selfieBlob] = await Promise.all([compressImage(doc.files[0]), compressImage(selfie.files[0])]);
        const docPath = await uploadImage("verification", `${meId}/${newFileName()}`, docBlob);
        const selfiePath = await uploadImage("verification", `${meId}/${newFileName()}`, selfieBlob);
        await rpc("submit_verification", { p_doc: docPath, p_selfie: selfiePath });
        await refreshSession();
        toast("Sent. We will let the page show the result once it is checked.", "good");
        window.dispatchEvent(new HashChangeEvent("hashchange"));
      });
    });

    append(box, [
      h("p", {}, "A tick next to your name tells people you are who you say you are, and they take your tasks more readily."),
      status === "rejected" ? notice("bad", "The last photos could not be accepted. Try again with clear, well-lit photos.") : null,
      h("p", { class: "small muted" }, "Only the team can see these photos. They are stored privately and deleted as soon as the team has made a decision."),
      form]);
    return box;
  }
}
