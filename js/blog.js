/* =========================================================
   Blog — article reader overlay
   Index rows live in #blog; full articles live in <template>
   elements. Clicking a row clones its template into the
   full-height reader sheet (progress bar, ESC/backdrop close).
   ========================================================= */
const reader = document.getElementById("reader");
const readerScroll = document.getElementById("readerScroll");
const readerProgress = document.getElementById("readerProgress");
const readerCat = document.getElementById("readerCat");
const readerDate = document.getElementById("readerDate");
const readerRead = document.getElementById("readerRead");
const readerTitle = document.getElementById("readerTitle");
const readerContent = document.getElementById("readerContent");

let lastTrigger = null;

function openPost(id, trigger) {
  const tpl = document.getElementById(id);
  if (!tpl) return;
  const frag = tpl.content;
  readerCat.textContent = frag.querySelector("[data-cat]")?.textContent || "";
  readerDate.textContent = frag.querySelector("[data-date]")?.textContent || "";
  readerRead.textContent = frag.querySelector("[data-read]")?.textContent || "";
  readerTitle.textContent = frag.querySelector("[data-title]")?.textContent || "";
  readerContent.innerHTML = "";
  const body = frag.querySelector("[data-content]");
  if (body) readerContent.appendChild(body.cloneNode(true));

  lastTrigger = trigger || null;
  reader.classList.add("is-open");
  reader.setAttribute("aria-hidden", "false");
  document.body.classList.add("no-scroll");
  readerScroll.scrollTop = 0;
  updateProgress();
  document.getElementById("readerClose").focus({ preventScroll: true });
}

function closeReader() {
  if (!reader.classList.contains("is-open")) return;
  reader.classList.remove("is-open");
  reader.setAttribute("aria-hidden", "true");
  document.body.classList.remove("no-scroll");
  if (lastTrigger) lastTrigger.focus({ preventScroll: true });
  lastTrigger = null;
}

function updateProgress() {
  const max = readerScroll.scrollHeight - readerScroll.clientHeight;
  const ratio = max > 0 ? readerScroll.scrollTop / max : 0;
  readerProgress.style.transform = `scaleX(${Math.min(1, Math.max(0, ratio))})`;
}

document.querySelectorAll(".blog__link[data-post]").forEach((btn) => {
  btn.addEventListener("click", () => openPost(btn.dataset.post, btn));
});
reader.querySelectorAll("[data-reader-close]").forEach((el) => {
  el.addEventListener("click", closeReader);
});
document.getElementById("readerClose").addEventListener("click", closeReader);
readerScroll.addEventListener("scroll", updateProgress, { passive: true });
window.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeReader();
});
