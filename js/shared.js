// Small pieces used by more than one page: dispute wording, photo upload, photo grid.
import { store, uploadImage, newFileName } from "./api.js";
import { h, compressImage, viewImage } from "./ui.js";

export const DISPUTE_KIND = {
  back_out: "Backing out",
  no_show: "Did not turn up or stopped replying",
  not_completed: "The work was not finished",
  poor_quality: "The work was not done properly",
  other: "Something else",
};

/** What a ruling means, in plain words for the two people involved. */
export function rulingText(dispute, task, people) {
  const poster = people[task.poster_id]?.display_name ?? "the poster";
  const taker = people[task.taker_id]?.display_name ?? "the taker";
  switch (dispute.resolution) {
    case "refund_both": return "Both deposits are returned in full.";
    case "forfeit_taker": return `${taker}'s deposit is awarded to ${poster}. ${poster}'s deposit is returned.`;
    case "forfeit_poster": return `${poster}'s deposit is awarded to ${taker}. ${taker}'s deposit is returned.`;
    default: return "";
  }
}

/** Shrinks a photo and uploads it to the private task-files bucket. Returns its storage path. */
export async function uploadTaskPhoto(taskId, file) {
  const blob = await compressImage(file);
  const path = `${taskId}/${store.user.id}/${newFileName()}`;
  return uploadImage("task-files", path, blob);
}

/** photos: [{ url, caption, label }] -> a grid people can tap to enlarge. */
export function photoGrid(photos) {
  const shown = photos.filter((p) => p.url);
  if (!shown.length) return null;
  return h("div", { class: "gallery" }, shown.map((p) => {
    const open = () => viewImage(p.url);
    return h("figure", {},
      h("img", {
        src: p.url, alt: p.caption || p.label || "Photo", loading: "lazy", tabindex: "0", role: "button",
        onclick: open, onkeydown: (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); } },
      }),
      p.caption || p.label ? h("figcaption", {}, [p.label, p.caption].filter(Boolean).join(": ")) : null);
  }));
}
