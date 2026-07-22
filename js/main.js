/* =========================================================
   1. Parallax background
   Gradient blobs + ring in #bg drift with scroll (data-speed)
   and react subtly to the mouse (data-depth). Elements with
   data-plx (hero art) parallax on scroll too. One rAF loop,
   lerped so everything glides.
   ========================================================= */
const bgLayers = [...document.querySelectorAll(".bgfx [data-speed]")];
const plxItems = [...document.querySelectorAll("[data-plx]")];
// viewport-pinned section backdrops (hero photo, about portrait, …):
// each [data-art] figure names its section and crossfades with scroll
const pinnedArts = [...document.querySelectorAll("[data-art]")]
  .map((el) => ({ el, section: document.getElementById(el.dataset.art) }))
  .filter((a) => a.section);
let plxScroll = window.scrollY || 0;
let plxMX = 0, plxMY = 0, plxTX = 0, plxTY = 0;

window.addEventListener("pointermove", (e) => {
  plxTX = e.clientX / window.innerWidth - 0.5;
  plxTY = e.clientY / window.innerHeight - 0.5;
});

(function plxLoop() {
  plxScroll += ((window.scrollY || 0) - plxScroll) * 0.08;
  plxMX += (plxTX - plxMX) * 0.05;
  plxMY += (plxTY - plxMY) * 0.05;
  bgLayers.forEach((el) => {
    const sp = parseFloat(el.dataset.speed) || 0;
    const dp = parseFloat(el.dataset.depth) || 0;
    el.style.transform = `translate3d(${(plxMX * dp).toFixed(2)}px, ${(plxScroll * sp + plxMY * dp).toFixed(2)}px, 0)`;
  });
  plxItems.forEach((el) => {
    const sp = parseFloat(el.dataset.plx) || 0;
    el.style.transform = `translate3d(0, ${(plxScroll * sp).toFixed(2)}px, 0)`;
  });
  // crossfade each pinned backdrop by how much of the viewport its section covers
  const vh = window.innerHeight || 1;
  pinnedArts.forEach(({ el, section }) => {
    const r = section.getBoundingClientRect();
    const overlap = Math.max(0, Math.min(r.bottom, vh) - Math.max(r.top, 0)) / vh;
    const o = Math.min(1, overlap * 1.35);
    el.style.opacity = o.toFixed(3);
    el.style.visibility = o <= 0.01 ? "hidden" : "visible";
  });
  requestAnimationFrame(plxLoop);
})();

/* =========================================================
   2. Loader
   ========================================================= */
const loader = document.getElementById("loader");
const loaderNum = document.getElementById("loaderNum");
const loaderBar = document.getElementById("loaderBar");
let progress = 0;
const tick = setInterval(() => {
  progress += Math.random() * 18;
  if (progress >= 100) { progress = 100; clearInterval(tick); finish(); }
  loaderNum.textContent = Math.floor(progress);
  loaderBar.style.width = progress + "%";
}, 130);
function finish() {
  setTimeout(() => {
    loader.classList.add("is-done");
    const fromHash = location.hash.slice(1);
    const target = document.getElementById(fromHash);
    if (target?.classList.contains("page") && fromHash !== "home") {
      target.scrollIntoView({ behavior: "instant", block: "start" });
    }
    initPageObservers();
  }, 350);
}

/* =========================================================
   5. Continuous scroll — reveal-on-scroll + current-section tracking
   ========================================================= */
const pages = [...document.querySelectorAll("section.page")];

function initPageObservers() {
  // reveal each section's content the first time it scrolls into view
  const revealObs = new IntersectionObserver((entries) => {
    entries.forEach((en) => {
      if (en.isIntersecting) en.target.classList.add("is-in");
    });
  }, { threshold: 0.12 });
  pages.forEach((p) => revealObs.observe(p));

  // track which section is centered — keeps the hash and .is-active in sync
  // (.is-active is still what js/ai.js watches to learn section visits)
  const activeObs = new IntersectionObserver((entries) => {
    entries.forEach((en) => {
      if (!en.isIntersecting) return;
      pages.forEach((p) => p.classList.toggle("is-active", p === en.target));
      if (location.hash !== "#" + en.target.id) {
        history.replaceState(null, "", "#" + en.target.id);
      }
    });
  }, { rootMargin: "-45% 0px -45% 0px" });
  pages.forEach((p) => activeObs.observe(p));
}

function scrollToPage(id) {
  const target = document.getElementById(id);
  if (!target || !target.classList.contains("page")) return false;
  target.scrollIntoView({ behavior: "smooth", block: "start" });
  if (location.hash !== "#" + id) history.replaceState(null, "", "#" + id);
  return true;
}

// external hash changes (e.g. the Yax AI widget setting location.hash)
window.addEventListener("hashchange", () => {
  const id = location.hash.slice(1);
  if (id) scrollToPage(id);
});

/* =========================================================
   6. Work — floating image preview
   ========================================================= */
const preview = document.getElementById("workPreview");
const previewImg = preview ? preview.querySelector("img") : null;
let ppx = 0, ppy = 0, ptx = 0, pty = 0, previewActive = false;
if (preview && previewImg) {
  document.querySelectorAll(".work__item").forEach((item) => {
    item.addEventListener("mouseenter", () => {
      previewImg.src = item.dataset.img;
      preview.classList.add("is-visible");
      previewActive = true;
    });
    item.addEventListener("mouseleave", () => {
      preview.classList.remove("is-visible");
      previewActive = false;
    });
  });
  window.addEventListener("pointermove", (e) => { ptx = e.clientX; pty = e.clientY; });
  (function previewLoop() {
    ppx += (ptx - ppx) * 0.12;
    ppy += (pty - ppy) * 0.12;
    if (previewActive) { preview.style.left = ppx + "px"; preview.style.top = ppy + "px"; }
    requestAnimationFrame(previewLoop);
  })();
}

/* =========================================================
   7. In-page links → smooth-scroll to the section
   ========================================================= */
document.querySelectorAll('a[href^="#"]').forEach((a) => {
  a.addEventListener("click", (e) => {
    const id = a.getAttribute("href").slice(1);
    if (document.getElementById(id)?.classList.contains("page")) {
      e.preventDefault();
      scrollToPage(id);
    }
  });
});

/* =========================================================
   10. Full-screen menu — open/close (mobile only)
   ========================================================= */
const menuToggle = document.getElementById("menuToggle");
const menu = document.getElementById("menu");
const menuHand = document.getElementById("menuHand");
let menuOpen = false;
function setMenu(open) {
  menuOpen = open;
  menu.classList.toggle("is-open", open);
  if (menuHand) menuHand.classList.toggle("is-open", open);
  menuToggle.classList.toggle("is-open", open);
  menuToggle.setAttribute("aria-expanded", String(open));
  menuToggle.setAttribute("aria-label", open ? "Close menu" : "Open menu");
  menu.setAttribute("aria-hidden", String(!open));
  document.body.classList.toggle("no-scroll", open);
}
menuToggle.addEventListener("click", () => setMenu(!menuOpen));
menu.querySelectorAll('a[href^="#"]').forEach((a) => {
  a.addEventListener("click", () => setMenu(false));
});
window.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && menuOpen) setMenu(false);
});

/* =========================================================
   11. Résumé PDF — generated on the fly from the page content
   ========================================================= */
function buildResumePDF() {
  const JsPDF = window.jspdf && window.jspdf.jsPDF;
  if (!JsPDF) { alert("PDF library failed to load. Check your connection and try again."); return; }

  const doc = new JsPDF({ unit: "pt", format: "a4" });
  const PAGE_W = doc.internal.pageSize.getWidth();
  const PAGE_H = doc.internal.pageSize.getHeight();
  const M = 46;                    // page margin
  const RIGHT = PAGE_W - M;
  const INK = [22, 20, 15];
  const MUTED = [120, 115, 105];

  const q = (sel, root = document) => root.querySelector(sel);
  const qa = (sel, root = document) => [...root.querySelectorAll(sel)];

  const name = q(".resume__name")?.textContent.trim() || "Boyet A. Dedal";
  const role = q(".resume__role")?.textContent.trim() || "Web & Software Developer";
  const contacts = qa(".resume__contact li").map((li) => li.textContent.trim());

  // Profile photo (top-left of the header). Loaded async below; null until ready.
  let photoData = null;       // JPEG data URL
  let photoAspect = 1;        // width / height

  // Render the whole résumé at scale S. When draw is false we only advance y
  // (a measuring pass), so we can pick the largest S that still fits one page.
  const render = (S, draw) => {
    let y = M;
    const LH = 13 * S;             // base line height
    const t = draw ? (txt, x, yy, opt) => doc.text(txt, x, yy, opt) : () => {};
    const line = draw ? (x1, yy1, x2, yy2) => doc.line(x1, yy1, x2, yy2) : () => {};

    // ---- header (photo top-left, name + role beside it, contacts right) ----
    let headX = M;            // x where the name/role text starts
    let photoBottom = y;
    const ph = 80 * S;        // photo height (also the header height when a photo is shown)
    if (photoData) {
      const pw = ph * photoAspect;
      if (draw) doc.addImage(photoData, "JPEG", M, y, pw, ph);
      headX = M + pw + 16 * S;
      photoBottom = y + ph;
    }
    doc.setTextColor(...INK);
    doc.setFont("times", "bold"); doc.setFontSize(24 * S);
    t(name, headX, y + (photoData ? 34 : 4) * S);
    doc.setFont("helvetica", "normal"); doc.setFontSize(9.5 * S); doc.setTextColor(...MUTED);
    t(role.toUpperCase(), headX, y + (photoData ? 51 : 21) * S, { charSpace: 1.5 });
    // Contacts: vertically centred against the photo so they sit level with the name.
    const cLH = 12.5 * S;
    const cStartY = photoData
      ? y + ph / 2 - ((contacts.length - 1) * cLH) / 2 + 4 * S
      : y + 4 * S;
    contacts.forEach((c, i) => t(c, RIGHT, cStartY + i * cLH, { align: "right" }));
    const textBottom = y + Math.max((photoData ? 56 : 30) * S, 4 * S + contacts.length * cLH);
    y = Math.max(photoBottom, textBottom);
    doc.setDrawColor(210, 205, 196); doc.setLineWidth(0.6); line(M, y, RIGHT, y);
    y += 18 * S;

    // ---- shared renderers ----
    const heading = (title) => {
      doc.setFont("helvetica", "bold"); doc.setFontSize(8.5 * S); doc.setTextColor(...MUTED);
      t(title.toUpperCase(), M, y, { charSpace: 1.2 });
      y += 6 * S;
      doc.setDrawColor(220, 215, 206); doc.setLineWidth(0.5); line(M, y, RIGHT, y);
      y += 15 * S;
    };
    const paragraph = (txt) => {
      // Set the font BEFORE measuring so splitTextToSize wraps at the real render
      // size — otherwise it measures at the previous (smaller) heading size and
      // the printed lines overrun the label rule.
      doc.setFont("helvetica", "normal"); doc.setFontSize(10 * S); doc.setTextColor(...INK);
      const lines = doc.splitTextToSize(txt, RIGHT - M);
      t(lines, M, y); y += lines.length * LH + 7 * S;
    };
    const bullet = (txt) => {
      doc.setFont("helvetica", "normal"); doc.setFontSize(10 * S); doc.setTextColor(...INK);
      const lines = doc.splitTextToSize(txt, RIGHT - M - 13 * S);
      t("•", M, y);
      t(lines, M + 13 * S, y); y += lines.length * LH + 3 * S;
    };

    qa(".resume__doc .resume__section").forEach((sec) => {
      heading(q(".resume__label", sec)?.textContent.trim() || "");

      const text = q(".resume__text", sec);
      if (text) paragraph(text.textContent.trim());

      qa(".resume__skills li", sec).forEach((li) => {
        const cat = q(".resume__skill-cat", li)?.textContent.trim() || "";
        const val = q(".resume__skill-val", li)?.textContent.trim() || "";
        doc.setFont("helvetica", "normal"); doc.setFontSize(10 * S);
        const valLines = doc.splitTextToSize(val, RIGHT - M - 130 * S);
        doc.setFont("helvetica", "bold"); doc.setTextColor(...INK);
        t(cat, M, y);
        doc.setFont("helvetica", "normal"); doc.setTextColor(...INK);
        t(valLines, M + 130 * S, y);
        y += Math.max(LH, valLines.length * LH) + 3 * S;
      });

      qa(".resume__plist li", sec).forEach((li) => {
        const pn = q(".resume__pname", li)?.textContent.trim() || "";
        const pd = q(".resume__pdesc", li)?.textContent.trim() || "";
        bullet(pd ? `${pn} — ${pd}` : pn);
      });

      qa(".resume__entry", sec).forEach((en) => {
        const tt = q(".resume__entry-title", en)?.textContent.trim() || "";
        const d = q(".resume__entry-date", en)?.textContent.trim() || "";
        const sub = q(".resume__entry-sub", en)?.textContent.trim() || "";
        const bl = qa(".resume__bullets li", en).map((li) => li.textContent.trim());
        doc.setFont("times", "bold"); doc.setFontSize(12 * S); doc.setTextColor(...INK);
        const tLines = doc.splitTextToSize(tt, RIGHT - M - 110 * S);
        t(tLines, M, y);
        doc.setFont("helvetica", "normal"); doc.setFontSize(9 * S); doc.setTextColor(...MUTED);
        t(d, RIGHT, y, { align: "right" });
        y += tLines.length * LH + 3 * S;
        if (sub) { doc.setFontSize(9.5 * S); doc.setTextColor(...MUTED); t(sub, M, y); y += LH; }
        bl.forEach(bullet);
        y += 8 * S;
      });

      // loose bullets (e.g. Certifications) — only those not inside an entry
      if (!q(".resume__entry", sec)) {
        qa(".resume__bullets li", sec).forEach((li) => bullet(li.textContent.trim()));
      }

      y += 6 * S;
    });

    return y;   // total height consumed
  };

  // Measure (auto-fit), then draw at the largest scale that fits one page.
  const finish = () => {
    const limit = PAGE_H - M;
    let S = 1;
    while (S > 0.6 && render(S, false) > limit) S -= 0.02;
    render(S, true);
    doc.save("Boyet-Resume.pdf");
  };

  // Load the profile photo first, then build. If it fails, build without it.
  const img = new Image();
  img.onload = () => {
    try {
      const maxPx = 700;   // downscale so the embedded photo stays light
      const sc = Math.min(1, maxPx / Math.max(img.naturalWidth, img.naturalHeight));
      const cw = Math.round(img.naturalWidth * sc);
      const ch = Math.round(img.naturalHeight * sc);
      const c = document.createElement("canvas");
      c.width = cw; c.height = ch;
      c.getContext("2d").drawImage(img, 0, 0, cw, ch);
      photoData = c.toDataURL("image/jpeg", 0.9);
      photoAspect = img.naturalWidth / img.naturalHeight;
    } catch (e) { photoData = null; }
    finish();
  };
  img.onerror = () => { photoData = null; finish(); };
  img.src = "images/dedalb.jpg";
}

// Résumé download is owner-only: clicking the button opens a sign-in gate that
// verifies the credentials against the Laravel backend before the PDF is built.
const resumeBtn = document.getElementById("resumeBtn");
const resumeGate = document.getElementById("resumeGate");
if (resumeBtn && resumeGate) {
  // Production goes through the portfolio's own domain (see vercel.json rewrites).
  const RESUME_API_BASE = (
    location.hostname.endsWith(".test") ||
    location.hostname === "localhost" ||
    location.hostname === "127.0.0.1"
  ) ? "http://testimonials-api.test/api" : "/api";
  const RESUME_VERIFY_API = `${RESUME_API_BASE}/resume/verify`;

  const gateForm = document.getElementById("gateForm");
  const gateStatus = document.getElementById("gateStatus");
  const gateClose = document.getElementById("gateClose");
  const gateSubmit = gateForm.querySelector(".gate__submit");
  const emailInput = gateForm.querySelector('input[name="email"]');

  const setGateStatus = (msg, kind) => {
    gateStatus.textContent = msg || "";
    gateStatus.classList.toggle("is-ok", kind === "ok");
    gateStatus.classList.toggle("is-err", kind === "err");
  };

  const openGate = () => {
    resumeGate.classList.add("is-open");
    resumeGate.setAttribute("aria-hidden", "false");
    setGateStatus("", null);
    setTimeout(() => emailInput?.focus(), 60);
  };
  const closeGate = () => {
    resumeGate.classList.remove("is-open");
    resumeGate.setAttribute("aria-hidden", "true");
  };

  resumeBtn.addEventListener("click", (e) => { e.preventDefault(); openGate(); });
  gateClose.addEventListener("click", closeGate);
  resumeGate.querySelector("[data-gate-close]").addEventListener("click", closeGate);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && resumeGate.classList.contains("is-open")) closeGate();
  });

  gateForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const email = emailInput.value.trim();
    const password = gateForm.querySelector('input[name="password"]').value;
    if (!email || !password) { setGateStatus("Enter your email and password.", "err"); return; }

    gateSubmit.disabled = true;
    setGateStatus("Verifying…", null);
    try {
      const res = await fetch(RESUME_VERIFY_API, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Accept": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      if (res.ok) {
        setGateStatus("Access granted — preparing your PDF…", "ok");
        buildResumePDF();
        setTimeout(() => { closeGate(); gateForm.reset(); setGateStatus("", null); }, 1200);
      } else if (res.status === 429) {
        setGateStatus("Too many attempts. Please wait a minute and try again.", "err");
      } else {
        const data = await res.json().catch(() => ({}));
        setGateStatus(data.message || "Incorrect email or password.", "err");
      }
    } catch (err) {
      setGateStatus("Network error. Check your connection and try again.", "err");
    } finally {
      gateSubmit.disabled = false;
    }
  });
}

/* =========================================================
   12. Testimonials — visitor feedback form
   ========================================================= */
// Laravel + Filament backend (testimonials-api).
// Use the local Herd backend during local dev and the deployed API in production,
// so testing locally always hits the latest code (you can see new fields like the
// social badge immediately, instead of an old frozen production deployment).
const TM_LOCAL_API = "http://testimonials-api.test/api/testimonials";
// Production calls the portfolio's OWN domain and Vercel proxies to the backend
// (vercel.json rewrites) — same-origin, so CORS and the Vercel Security
// Checkpoint can never block it.
const TM_PROD_API = "/api/testimonials";
const TESTIMONIAL_API = (
  location.hostname.endsWith(".test") ||
  location.hostname === "localhost" ||
  location.hostname === "127.0.0.1"
) ? TM_LOCAL_API : TM_PROD_API;

(function initTestimonials() {
  const form = document.getElementById("tmForm");
  if (!form) return;
  const grid = document.getElementById("tmGrid");
  const rate = document.getElementById("tmRate");
  const ratingInput = document.getElementById("tmRating");
  const status = document.getElementById("tmStatus");
  const submitBtn = form.querySelector(".tm__submit");
  const stars = rate ? [...rate.querySelectorAll(".tm__star")] : [];
  let rating = 5;

  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));

  const paint = (n) => stars.forEach((s) => s.classList.toggle("is-on", Number(s.dataset.val) <= n));
  stars.forEach((s) => {
    s.addEventListener("mouseenter", () => paint(Number(s.dataset.val)));
    s.addEventListener("click", () => { rating = Number(s.dataset.val); ratingInput.value = rating; paint(rating); });
  });
  if (rate) rate.addEventListener("mouseleave", () => paint(rating));

  const setStatus = (msg, kind) => {
    status.textContent = msg;
    status.classList.toggle("is-ok", kind === "ok");
    status.classList.toggle("is-err", kind === "err");
  };

  // social profile link → brand logo (shown on each card as a clickable verification badge)
  const SOCIAL_ICONS = {
    facebook: '<path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z"/>',
    instagram: '<path d="M12 2.163c3.204 0 3.584.012 4.85.07 3.252.148 4.771 1.691 4.919 4.919.058 1.265.069 1.645.069 4.849 0 3.205-.012 3.584-.069 4.849-.149 3.225-1.664 4.771-4.919 4.919-1.266.058-1.644.07-4.85.07-3.204 0-3.584-.012-4.849-.07-3.26-.149-4.771-1.699-4.919-4.92-.058-1.265-.07-1.644-.07-4.849 0-3.204.013-3.583.07-4.849.149-3.227 1.664-4.771 4.919-4.919 1.266-.057 1.645-.069 4.849-.069zM12 0C8.741 0 8.333.014 7.053.072 2.695.272.273 2.69.073 7.052.014 8.333 0 8.741 0 12c0 3.259.014 3.668.072 4.948.2 4.358 2.618 6.78 6.98 6.98C8.333 23.986 8.741 24 12 24c3.259 0 3.668-.014 4.948-.072 4.354-.2 6.782-2.618 6.979-6.98.059-1.28.073-1.689.073-4.948 0-3.259-.014-3.667-.072-4.947-.196-4.354-2.617-6.78-6.979-6.98C15.668.014 15.259 0 12 0zm0 5.838a6.162 6.162 0 1 0 0 12.324 6.162 6.162 0 0 0 0-12.324zM12 16a4 4 0 1 1 0-8 4 4 0 0 1 0 8zm6.406-11.845a1.44 1.44 0 1 0 0 2.881 1.44 1.44 0 0 0 0-2.881z"/>',
    linkedin: '<path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433a2.062 2.062 0 0 1-2.063-2.065 2.064 2.064 0 1 1 2.063 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.225 0z"/>',
    tiktok: '<path d="M12.525.02c1.31-.02 2.61-.01 3.91-.02.08 1.53.63 3.09 1.75 4.17 1.12 1.11 2.7 1.62 4.24 1.79v4.03c-1.44-.05-2.89-.35-4.2-.97-.57-.26-1.1-.59-1.62-.93-.01 2.92.01 5.84-.02 8.75-.08 1.4-.54 2.79-1.35 3.94-1.31 1.92-3.58 3.17-5.91 3.21-1.43.08-2.86-.31-4.08-1.03-2.02-1.19-3.44-3.37-3.65-5.71-.02-.5-.03-1-.01-1.49.18-1.9 1.12-3.72 2.58-4.96 1.66-1.44 3.98-2.13 6.15-1.72.02 1.48-.04 2.96-.04 4.44-.99-.32-2.15-.23-3.02.37-.63.41-1.11 1.04-1.36 1.75-.21.51-.15 1.07-.14 1.61.24 1.64 1.82 3.02 3.5 2.87 1.12-.01 2.19-.66 2.77-1.61.19-.33.4-.67.41-1.06.1-1.79.06-3.57.07-5.36.01-4.03-.01-8.05.02-12.07z"/>',
  };
  const EXTERNAL_ICON = '<path d="M14 4h6v6"/><path d="M20 4 10 14"/><path d="M19 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5"/>';

  const socialMeta = (host) => {
    const h = host.replace(/^www\./, "");
    if (/(^|\.)facebook\.com$|(^|\.)fb\.(com|me)$/.test(h)) return { key: "facebook", label: "Facebook" };
    if (/(^|\.)instagram\.com$/.test(h)) return { key: "instagram", label: "Instagram" };
    if (/(^|\.)linkedin\.com$/.test(h)) return { key: "linkedin", label: "LinkedIn" };
    if (/(^|\.)tiktok\.com$/.test(h)) return { key: "tiktok", label: "TikTok" };
    return { key: "link", label: "Profile" };
  };

  function socialLink(url) {
    if (!/^https?:\/\//i.test(url || "")) return "";
    let host;
    try { host = new URL(url).hostname.toLowerCase(); } catch { return ""; }
    const m = socialMeta(host);
    const icon = SOCIAL_ICONS[m.key] || EXTERNAL_ICON;
    const attrs = m.key === "link"
      ? 'fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"'
      : 'fill="currentColor"';
    return `<a class="tm__social tm__social--${m.key}" href="${esc(url)}" target="_blank" rel="noopener noreferrer nofollow" aria-label="${m.label} profile" title="${m.label}" data-cursor>
            <svg viewBox="0 0 24 24" ${attrs} aria-hidden="true">${icon}</svg>
          </a>`;
  }

  // load approved testimonials from the backend (keeps the static cards as fallback)
  async function loadTestimonials() {
    if (!grid) return;
    try {
      const res = await fetch(TESTIMONIAL_API, { headers: { "Accept": "application/json" } });
      if (!res.ok) return;
      const list = await res.json();
      if (!Array.isArray(list) || !list.length) return;
      grid.innerHTML = list.map((t) => {
        const r = Math.max(1, Math.min(5, Number(t.rating) || 5));
        return `<figure class="tm__card reveal is-in">
          ${socialLink(t.social)}
          <div class="tm__stars" aria-label="${r} out of 5 stars">${"★".repeat(r)}</div>
          <blockquote>${esc(t.message)}</blockquote>
          <figcaption>
            <span class="tm__name">${esc(t.name)}</span>
            ${t.role ? `<span class="tm__role">${esc(t.role)}</span>` : ""}
          </figcaption>
        </figure>`;
      }).join("");
    } catch (e) { /* offline / API down — keep the static fallback cards */ }
  }
  loadTestimonials();

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = form.name.value.trim();
    const role = form.role.value.trim();
    let social = form.social.value.trim();
    const message = form.message.value.trim();
    if (!name || !message) { setStatus("Please add your name and feedback.", "err"); return; }
    if (!social) { setStatus("Please add your social profile link (FB / IG / LinkedIn / TikTok).", "err"); return; }
    // normalize bare handles/domains to a full URL, then validate it's a real link
    if (!/^https?:\/\//i.test(social)) social = "https://" + social;
    try {
      const u = new URL(social);
      if (!u.hostname.includes(".")) throw new Error("no domain");
    } catch {
      setStatus("Please enter a valid link, e.g. https://facebook.com/yourname", "err");
      return;
    }

    try {
      submitBtn.disabled = true;
      setStatus("Sending…", "");
      const res = await fetch(TESTIMONIAL_API, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Accept": "application/json" },
        body: JSON.stringify({ name, role, social, rating, message, website: form.website.value }),
      });
      if (!res.ok) throw new Error("Request failed");
      form.reset(); rating = 5; ratingInput.value = 5; paint(5);
      setStatus("Salamat! Your feedback was submitted for review. 🙌", "ok");
    } catch (err) {
      setStatus("Sorry, something went wrong. Please try again later.", "err");
    } finally {
      submitBtn.disabled = false;
    }
  });
})();
