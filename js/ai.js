/* =========================================================
   YAX AI — Memory-Based Portfolio Assistant
   Recognizes returning visitors: remembers their name, how
   many times they've dropped by, and which sections they
   explored — then greets them personally and answers
   questions about Boyet. Memory lives in localStorage;
   visits are also reported to the testimonials-api backend
   so the owner can see who visited (Filament → Visitors).
   ========================================================= */

const AI_API_BASE = (
  location.hostname.endsWith(".test") ||
  location.hostname === "localhost" ||
  location.hostname === "127.0.0.1"
) ? "http://testimonials-api.test/api" : "https://testimonials-kappa-sable.vercel.app/api";
const TRACK_API = `${AI_API_BASE}/visitors/track`;
const CHAT_API = `${AI_API_BASE}/yax/chat`;

const MEM_KEY = "yax_ai_memory_v1";
const SESSION_FLAG = "yax_ai_session";

/* ---------- tiny helpers ---------- */
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => (
  { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
));
const uuid = () =>
  (crypto.randomUUID && crypto.randomUUID()) ||
  "v-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);

const SECTION_LABELS = {
  home: "Home", about: "About", resume: "Resume", projects: "Projects",
  experience: "Experience", testimonials: "Testimonials", contact: "Contact",
};

function timeAgo(ts) {
  const s = Math.max(1, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return "moments ago";
  const m = Math.round(s / 60);
  if (m < 60) return m === 1 ? "a minute ago" : `${m} minutes ago`;
  const h = Math.round(m / 60);
  if (h < 24) return h === 1 ? "an hour ago" : `${h} hours ago`;
  const d = Math.round(h / 24);
  if (d < 30) return d === 1 ? "yesterday" : `${d} days ago`;
  const mo = Math.round(d / 30);
  return mo === 1 ? "a month ago" : `${mo} months ago`;
}
function timeGreet() {
  const h = new Date().getHours();
  if (h < 12) return "Good morning";
  if (h < 18) return "Good afternoon";
  return "Good evening";
}

/* =========================================================
   1. Visitor memory (localStorage)
   ========================================================= */
let mem;
let storageOk = true;
function loadMemory() {
  try {
    const raw = localStorage.getItem(MEM_KEY);
    if (raw) return JSON.parse(raw);
  } catch (e) { storageOk = false; }
  return null;
}
function saveMemory() {
  if (!storageOk) return;
  try { localStorage.setItem(MEM_KEY, JSON.stringify(mem)); }
  catch (e) { storageOk = false; }
}

mem = loadMemory() || {
  key: uuid(),
  name: null,
  visits: 0,
  firstVisit: Date.now(),
  lastVisit: null,     // timestamp of the PREVIOUS visit (for "3 days ago")
  sections: {},
  lastSection: null,
  chats: 0,
};

// a "visit" = one browser session (refreshes don't double-count)
let isNewSession = false;
try { isNewSession = !sessionStorage.getItem(SESSION_FLAG); } catch (e) { /* count anyway */ isNewSession = true; }
const prevVisitTs = mem.lastVisit;
const isReturning = mem.visits > 0;
if (isNewSession) {
  mem.visits += 1;
  try { sessionStorage.setItem(SESSION_FLAG, "1"); } catch (e) {}
}
mem.lastVisit = Date.now();
saveMemory();

function favoriteSection() {
  const entries = Object.entries(mem.sections).filter(([id]) => id !== "home");
  if (!entries.length) return null;
  entries.sort((a, b) => b[1] - a[1]);
  return entries[0][1] > 1 ? { id: entries[0][0], count: entries[0][1] } : null;
}
function unexploredSections() {
  return Object.keys(SECTION_LABELS).filter((id) => id !== "home" && !mem.sections[id]);
}

/* ---------- section tracking (which pages they open) ---------- */
let activeSection = null;
const pageObserver = new MutationObserver(() => {
  const act = document.querySelector(".page.is-active");
  if (act && act.id !== activeSection) {
    activeSection = act.id;
    mem.sections[act.id] = (mem.sections[act.id] || 0) + 1;
    mem.lastSection = act.id;
    saveMemory();
  }
});
document.querySelectorAll(".page").forEach((p) =>
  pageObserver.observe(p, { attributes: true, attributeFilter: ["class"] })
);

/* =========================================================
   2. Report the visit to the backend (owner sees it in
      Filament → Visitors). Silent — never bothers the UI.
   ========================================================= */
function trackPayload(bump) {
  let tz = null;
  try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone; } catch (e) {}
  return {
    key: mem.key,
    name: mem.name,
    visits: mem.visits,
    sections: mem.sections,
    last_section: mem.lastSection,
    theme: document.documentElement.dataset.theme || null,
    referrer: (document.referrer || "").slice(0, 255) || null,
    language: navigator.language || null,
    timezone: tz,
    bump: !!bump,
  };
}
function pingServer(bump = false) {
  try {
    fetch(TRACK_API, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json" },
      body: JSON.stringify(trackPayload(bump)),
      keepalive: true,
    }).catch(() => {});
  } catch (e) { /* offline / blocked — memory still works locally */ }
}
pingServer(isNewSession);

// final snapshot on leave so the sections they explored get saved
window.addEventListener("pagehide", () => {
  try {
    const blob = new Blob([JSON.stringify(trackPayload(false))], { type: "application/json" });
    navigator.sendBeacon(TRACK_API, blob);
  } catch (e) {}
});

/* =========================================================
   3. Widget UI (built here so index.html stays clean)
   ========================================================= */
const root = document.createElement("div");
root.className = "ai";
root.innerHTML = `
  <div class="ai__teaser" id="aiTeaser" role="status"></div>
  <button class="ai__fab" id="aiFab" type="button" aria-label="Chat with Yax AI" aria-expanded="false">
    <span class="ai__fab-spark">✦</span>
    <span class="ai__fab-ring"></span>
  </button>
  <section class="ai__panel" id="aiPanel" aria-label="Yax AI chat" aria-hidden="true">
    <header class="ai__head">
      <span class="ai__avatar">✦</span>
      <div class="ai__head-txt">
        <strong>Yax AI</strong>
        <em id="aiStatus">Portfolio assistant</em>
      </div>
      <button class="ai__close" id="aiClose" type="button" aria-label="Close chat">×</button>
    </header>
    <div class="ai__msgs" id="aiMsgs"></div>
    <div class="ai__chips" id="aiChips"></div>
    <form class="ai__form" id="aiForm" novalidate>
      <input class="ai__input" id="aiInput" type="text" placeholder="Ask me anything…" maxlength="300" autocomplete="off" />
      <button class="ai__send" type="submit" aria-label="Send">
        <svg width="14" height="14" viewBox="0 0 14 14"><path d="M2 7h10M8 3l4 4-4 4" stroke="currentColor" fill="none" stroke-width="1.4"/></svg>
      </button>
    </form>
    <p class="ai__note">Memory stays in this browser — say “forget me” to reset.</p>
  </section>
`;
document.body.appendChild(root);

const fab = root.querySelector("#aiFab");
const panel = root.querySelector("#aiPanel");
const teaser = root.querySelector("#aiTeaser");
const msgsEl = root.querySelector("#aiMsgs");
const chipsEl = root.querySelector("#aiChips");
const formEl = root.querySelector("#aiForm");
const inputEl = root.querySelector("#aiInput");
const statusEl = root.querySelector("#aiStatus");
const closeBtn = root.querySelector("#aiClose");

// the site's custom cursor reacts to hover on [data-cursor] elements bound at
// load — ours are created later, so wire the hover class manually
const cursorEl = document.getElementById("cursor");
if (cursorEl) {
  root.querySelectorAll("button, input").forEach((el) => {
    el.addEventListener("mouseenter", () => cursorEl.classList.add("is-hover"));
    el.addEventListener("mouseleave", () => cursorEl.classList.remove("is-hover"));
  });
}

function setStatus() {
  statusEl.textContent = mem.name ? `Remembering ${mem.name}` : "Portfolio assistant";
}
setStatus();

/* ---------- homepage hero greeting (time-based, remembers your name) ---------- */
const heroGreetEl = document.getElementById("heroGreet");
function updateHeroGreet() {
  if (!heroGreetEl) return;
  const h = new Date().getHours();
  const name = mem.name ? `, ${mem.name}` : "";
  let text;
  if (h >= 5 && h < 12) text = `Good morning${name}! ☀️`;
  else if (h >= 12 && h < 18) text = `Good afternoon${name}! 🌤️`;
  else if (h >= 18) text = `Good evening${name}! 🌙`;
  else text = `Still up${name}? 🦉`; // 12am–5am — night-owl visitors
  heroGreetEl.textContent = text;
}
updateHeroGreet();
setInterval(updateHeroGreet, 60000); // keeps it correct if they linger on the page

/* ---------- messages ---------- */
function addMsg(html, who, actions) {
  const b = document.createElement("div");
  b.className = `ai__msg ai__msg--${who}`;
  b.innerHTML = html;
  if (actions && actions.length) {
    const row = document.createElement("div");
    row.className = "ai__actions";
    actions.forEach(({ label, hash }) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "ai__action";
      btn.textContent = label;
      btn.addEventListener("click", () => { location.hash = "#" + hash; });
      row.appendChild(btn);
    });
    b.appendChild(row);
  }
  msgsEl.appendChild(b);
  msgsEl.scrollTop = msgsEl.scrollHeight;
  return b;
}

let typingEl = null;
function showTyping() {
  typingEl = addMsg('<span class="ai__dots"><i></i><i></i><i></i></span>', "bot");
}
function hideTyping() {
  if (typingEl) { typingEl.remove(); typingEl = null; }
}

// queue AI replies with a small human-ish typing delay
let replyChain = Promise.resolve();
function reply(texts, opts = {}) {
  const list = Array.isArray(texts) ? texts : [texts];
  list.forEach((txt, i) => {
    replyChain = replyChain.then(() => new Promise((done) => {
      showTyping();
      const delay = Math.min(360 + txt.length * 7, 1400);
      setTimeout(() => {
        hideTyping();
        const last = i === list.length - 1;
        addMsg(txt, "bot", last ? opts.actions : null);
        if (last && opts.chips) setChips(opts.chips);
        done();
      }, delay);
    }));
  });
}

function setChips(labels) {
  chipsEl.innerHTML = "";
  (labels || []).forEach((label) => {
    const c = document.createElement("button");
    c.type = "button";
    c.className = "ai__chip";
    c.textContent = label;
    c.addEventListener("click", () => send(label));
    chipsEl.appendChild(c);
  });
}

/* ---------- open / close ---------- */
let panelOpen = false;
let greeted = false;
function setPanel(open) {
  panelOpen = open;
  panel.classList.toggle("is-open", open);
  panel.setAttribute("aria-hidden", String(!open));
  fab.classList.toggle("is-open", open);
  fab.setAttribute("aria-expanded", String(open));
  hideTeaser();
  if (open && !greeted) { greeted = true; greet(); }
  if (open) setTimeout(() => inputEl.focus(), 150);
}
fab.addEventListener("click", () => setPanel(!panelOpen));
closeBtn.addEventListener("click", () => setPanel(false));
window.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && panelOpen) setPanel(false);
});

/* ---------- teaser bubble (the "it recognizes you" moment) ---------- */
let teaserTimer = null;
function showTeaser(text) {
  teaser.textContent = text;
  teaser.classList.add("is-visible");
  clearTimeout(teaserTimer);
  teaserTimer = setTimeout(hideTeaser, 9000);
}
function hideTeaser() {
  teaser.classList.remove("is-visible");
}
teaser.addEventListener("click", () => setPanel(true));

setTimeout(() => {
  if (panelOpen) return;
  if (isReturning && mem.name) showTeaser(`Welcome back, ${mem.name}! ✦`);
  else if (isReturning) showTeaser("Welcome back! I remember you ✦");
  else showTeaser("Hi! First time here? — Yax AI ✦");
}, 2600);

/* =========================================================
   4. Conversation brain (memory-aware, rule-based)
   ========================================================= */
const KB = {
  email: "dedalboyet16@gmail.com",
  github: "https://github.com/ChuBoyax",
  linkedin: "https://www.linkedin.com/in/boyet-dedal-936484359/",
};
const DEFAULT_CHIPS = ["Projects", "Skills", "Contact", "What do you know about me?"];

let awaitingName = !mem.name;

/* Recent turns sent to the AI for context. Kept short to control tokens. */
const history = [];
const MAX_HISTORY = 12;
function pushHistory(role, content) {
  history.push({ role, content });
  if (history.length > MAX_HISTORY) history.splice(0, history.length - MAX_HISTORY);
}
const stripTags = (h) => String(h).replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();

/* Intents that MUST run locally — they mutate private memory (name, visits)
   or read it back precisely — so they never hit the network and stay instant.
   Returns a reply object, or null to let the real AI handle the message. */
function localBrain(raw) {
  const q = raw.trim().toLowerCase();

  /* — name capture flow — */
  if (awaitingName) {
    if (/^(skip|no|nope|wag|ayaw|later|secret|pass)\b/.test(q)) {
      awaitingName = false;
      return { texts: ["No worries! 🙂 Ask me anything — about Boyet, or really anything at all."], chips: DEFAULT_CHIPS };
    }
    const m = raw.match(/(?:call me|my name is|i am|i'm|ako si|ako'y)\s+(.{2,40})$/i);
    const candidate = (m ? m[1] : raw).replace(/[.!]+$/, "").trim();
    if (looksLikeName(candidate)) {
      awaitingName = false;
      setName(cap(candidate));
      return {
        texts: [
          `Nice to meet you, <strong>${esc(mem.name)}</strong>! 🤝 You're saved in my memory now — when you come back, I'll recognize you.`,
          "So — what would you like to know? You can ask about Boyet's work, or anything else on your mind.",
        ],
        chips: DEFAULT_CHIPS,
      };
    }
    awaitingName = false; // not a name — let the AI answer the actual question
  }

  /* — forget me — */
  if (/forget me|forget everything|kalimutan mo ako|kalimti ko|delete my (data|memory)|clear memory|burahin/i.test(q)) {
    try { localStorage.removeItem(MEM_KEY); sessionStorage.removeItem(SESSION_FLAG); } catch (e) {}
    mem = { key: uuid(), name: null, visits: 1, firstVisit: Date.now(), lastVisit: Date.now(), sections: {}, lastSection: null, chats: 0 };
    saveMemory();
    setStatus();
    updateHeroGreet();
    history.length = 0;
    awaitingName = true;
    return { texts: ["Done — wiped my memory of you. 🧹 It's like we're meeting for the first time again. What should I call you?"] };
  }

  /* — rename — */
  const rename = raw.match(/(?:call me|my name is|ako si|ako'y|change my name to)\s+(.{2,40})$/i);
  if (rename && looksLikeName(rename[1].replace(/[.!]+$/, "").trim())) {
    setName(cap(rename[1].replace(/[.!]+$/, "").trim()));
    return { texts: [`Got it, <strong>${esc(mem.name)}</strong>! I've updated my memory. ✍️`], chips: DEFAULT_CHIPS };
  }

  /* — what do you remember about me — */
  if (/what do you (know|remember)|remember me|do you know me|anong alam mo|sino ako|kilala mo.*ako|kabalo ka.*nako/i.test(q)) {
    if (!mem.name && mem.visits <= 1) {
      return { texts: ["Not much yet! This is our first meeting — I only know you're here right now. Tell me your name and I'll remember you next time. 😊"] };
    }
    const seen = Object.entries(mem.sections)
      .sort((a, b) => b[1] - a[1])
      .map(([id, n]) => `${SECTION_LABELS[id] || id} (${n}×)`)
      .join(", ");
    return {
      texts: [
        `Here's what I remember about you${mem.name ? `, <strong>${esc(mem.name)}</strong>` : ""}: 🧠`,
        `• Visits: <strong>${mem.visits}</strong> — first dropped by ${timeAgo(mem.firstVisit)}<br>` +
        (seen ? `• Sections explored: ${esc(seen)}<br>` : "") +
        `• We've exchanged ${mem.chats} message${mem.chats === 1 ? "" : "s"}`,
        "All of it stays in your browser — say “forget me” anytime and it's gone. 🤞",
      ],
      chips: DEFAULT_CHIPS,
    };
  }

  return null; // → hand off to the real AI
}

function greet() {
  if (isReturning && mem.name) {
    const parts = [
      `${timeGreet()}, <strong>${esc(mem.name)}</strong>! 👋 Welcome back — this is visit #${mem.visits}${prevVisitTs ? `, last time was ${timeAgo(prevVisitTs)}` : ""}.`,
    ];
    const fav = favoriteSection();
    if (fav) parts.push(`Looks like <strong>${SECTION_LABELS[fav.id] || fav.id}</strong> is your favorite section — you've opened it ${fav.count}× already. 😄`);
    const unseen = unexploredSections();
    if (unseen.length) {
      parts.push(`You haven't explored <strong>${SECTION_LABELS[unseen[0]]}</strong> yet — want to take a look?`);
      reply(parts, { chips: DEFAULT_CHIPS, actions: [{ label: `Open ${SECTION_LABELS[unseen[0]]} ↗`, hash: unseen[0] }] });
    } else {
      parts.push("You've seen every corner of the portfolio. Solid. 🫡 Anything you want to ask about Boyet?");
      reply(parts, { chips: DEFAULT_CHIPS });
    }
    awaitingName = false;
  } else if (isReturning) {
    reply([
      `Welcome back! 👋 This is visit #${mem.visits}${prevVisitTs ? ` — last time was ${timeAgo(prevVisitTs)}` : ""}.`,
      "I never got your name though. What should I call you? (I'll remember you next time — and Boyet gets to see that you stopped by. 😊)",
    ]);
    awaitingName = true;
  } else {
    reply([
      "Hey! I'm <strong>Yax AI</strong> ✦ — Boyet's portfolio assistant. First time here, right? I remember my visitors, so next time I'll know you. 😊",
      "What should I call you? (Or just ask me anything — type “skip” if you'd rather not.)",
    ]);
    awaitingName = true;
  }
}

function setName(name) {
  mem.name = name;
  saveMemory();
  setStatus();
  updateHeroGreet(); // the homepage greeting turns personal right away
  pingServer(false);
}

function looksLikeName(raw) {
  const s = raw.trim();
  if (s.length < 2 || s.length > 40) return false;
  if (/[?@/\\]|https?:/i.test(s)) return false;
  if (s.split(/\s+/).length > 4) return false;
  return /^[\p{L}][\p{L}\p{N} .'-]*$/u.test(s);
}
const cap = (s) => s.replace(/\S+/g, (w) => w[0].toUpperCase() + w.slice(1));

function brain(raw) {
  const q = raw.trim().toLowerCase();

  /* — name capture flow — */
  if (awaitingName) {
    if (/^(skip|no|nope|wag|ayaw|later|secret|pass)\b/.test(q)) {
      awaitingName = false;
      return { texts: ["No worries! 🙂 Ask me anything about Boyet — his projects, skills, or how to reach him."], chips: DEFAULT_CHIPS };
    }
    const m = raw.match(/(?:call me|my name is|i am|i'm|ako si|ako'y)\s+(.{2,40})$/i);
    const candidate = (m ? m[1] : raw).replace(/[.!]+$/, "").trim();
    if (looksLikeName(candidate)) {
      awaitingName = false;
      setName(cap(candidate));
      return {
        texts: [
          `Nice to meet you, <strong>${esc(mem.name)}</strong>! 🤝 You're saved in my memory now — when you come back, I'll recognize you.`,
          "So — what would you like to know? Boyet's projects, skills, experience, or how to contact him?",
        ],
        chips: DEFAULT_CHIPS,
      };
    }
    awaitingName = false; // fall through and answer normally
  }

  /* — memory commands — */
  if (/forget me|forget everything|kalimutan mo ako|delete my (data|memory)|clear memory|burahin/i.test(q)) {
    try { localStorage.removeItem(MEM_KEY); sessionStorage.removeItem(SESSION_FLAG); } catch (e) {}
    mem = { key: uuid(), name: null, visits: 1, firstVisit: Date.now(), lastVisit: Date.now(), sections: {}, lastSection: null, chats: 0 };
    saveMemory();
    setStatus();
    updateHeroGreet();
    awaitingName = true;
    return { texts: ["Done — wiped my memory of you. 🧹 It's like we're meeting for the first time again. What should I call you?"] };
  }
  const rename = raw.match(/(?:call me|my name is|ako si|ako'y|change my name to)\s+(.{2,40})$/i);
  if (rename && looksLikeName(rename[1].replace(/[.!]+$/, "").trim())) {
    setName(cap(rename[1].replace(/[.!]+$/, "").trim()));
    return { texts: [`Got it, <strong>${esc(mem.name)}</strong>! I've updated my memory. ✍️`], chips: DEFAULT_CHIPS };
  }
  if (/paano mo (na)?alam|how do you (know|remember)|creepy|stalk|privacy|tracking/i.test(q)) {
    return {
      texts: [
        "Nothing spooky! 🙂 I only remember what happens right here on the site — your name (if you told me), how many times you've visited, and which sections you opened. It all stays in your browser.",
        "No GPS, no location tracking, no creepy scripts. Say “forget me” anytime and I drop everything I know about you.",
      ],
      chips: DEFAULT_CHIPS,
    };
  }
  if (/what do you (know|remember)|remember me|do you know me|anong alam mo|sino ako|kilala mo.*ako/i.test(q)) {
    if (!mem.name && mem.visits <= 1) {
      return { texts: ["Not much yet! This is our first meeting — I only know you're here right now. Tell me your name and I'll remember you next time. 😊"] };
    }
    const seen = Object.entries(mem.sections)
      .sort((a, b) => b[1] - a[1])
      .map(([id, n]) => `${SECTION_LABELS[id] || id} (${n}×)`)
      .join(", ");
    const lines = [
      `Here's what I remember about you${mem.name ? `, <strong>${esc(mem.name)}</strong>` : ""}: 🧠`,
      `• Visits: <strong>${mem.visits}</strong> — first dropped by ${timeAgo(mem.firstVisit)}<br>` +
      (seen ? `• Sections explored: ${esc(seen)}<br>` : "") +
      `• We've exchanged ${mem.chats} message${mem.chats === 1 ? "" : "s"}`,
      "All of it stays in your browser — say “forget me” anytime and it's gone. 🤞",
    ];
    return { texts: lines, chips: DEFAULT_CHIPS };
  }

  /* — small talk — */
  if (/^(hi|hello|hey|yo|kumusta|musta|hello po|hi po)\b/.test(q)) {
    return { texts: [`${timeGreet()}${mem.name ? `, ${esc(mem.name)}` : ""}! 👋 What can I help you with — projects, skills, or contact info?`], chips: DEFAULT_CHIPS };
  }
  if (/who are you|what are you|ano ka ba|anong ai/i.test(q)) {
    return { texts: ["I'm <strong>Yax AI</strong> ✦ — a memory-based assistant living in Boyet's portfolio. I recognize returning visitors, remember what you explored, and answer questions about his work."] };
  }
  if (/thank|salamat|thanks|ty\b/i.test(q)) {
    return { texts: [`You're welcome${mem.name ? `, ${esc(mem.name)}` : ""}! 🙌 Come back anytime — I'll remember you.`] };
  }
  if (/^(bye|goodbye|paalam|ingat|see you)/.test(q)) {
    return { texts: [`Take care${mem.name ? `, ${esc(mem.name)}` : ""}! 👋 See you on visit #${mem.visits + 1}.`] };
  }

  /* — portfolio knowledge — */
  if (/who.*(boyet|owner|made|built|gumawa)|about (boyet|him|the dev)|sino si/i.test(q)) {
    return {
      texts: [
        "<strong>Boyet A. Dedal</strong> — a Full-Stack Developer from Hindang, Leyte, Philippines 🇵🇭 (GMT+8). He builds scalable web applications with clean code and great UX, and he's currently <strong>open to freelance work</strong>.",
        "He works at the crossroads of design and code — detail-obsessed, performance-minded, and currently exploring shaders (this ink background? his doing 🎨).",
      ],
      actions: [{ label: "Open About ↗", hash: "about" }],
      chips: ["Skills", "Projects", "Contact"],
    };
  }
  if (/skill|stack|tech|technolog|language|framework|tools|marunong/i.test(q)) {
    return {
      texts: [
        "Boyet's stack: 🛠<br>• <strong>Languages:</strong> HTML, CSS, JavaScript, PHP, SQL<br>• <strong>Frameworks:</strong> Laravel, Filament, Tailwind CSS, Node.js<br>• <strong>Databases & CMS:</strong> MySQL, WordPress<br>• <strong>Tools:</strong> Git, GitHub, VS Code, Postman, cPanel",
      ],
      actions: [{ label: "Open Resume ↗", hash: "resume" }],
      chips: ["Projects", "Experience", "Contact"],
    };
  }
  if (/project|work|gawa|portfolio|apps|systems/i.test(q)) {
    return {
      texts: [
        "He's shipped quite a lot: 🚀<br>• <strong>LMBS</strong> — motorboat booking & management<br>• <strong>LTS PB</strong> — legislative tracking system<br>• <strong>HNVS Portal</strong> — school management with enrollment & ID generation<br>• <strong>NaturoDoc</strong> — healthcare platform with teleconsultation<br>• <strong>IBIS</strong> — LGU government portal<br>• <strong>MLGCL Library</strong> — library management system<br>…plus ID Maker and a couple of portfolios.",
      ],
      actions: [{ label: "Open Projects ↗", hash: "projects" }],
      chips: ["Skills", "Experience", "Contact"],
    };
  }
  if (/experience|job|trabaho|career|working|employ/i.test(q)) {
    return {
      texts: [
        "Boyet has been a <strong>Web Developer at Creative Dev Labs</strong> since October 2024 — building and maintaining full-stack web apps, managing MySQL databases, QA testing, and shipping system upgrades. 💼",
      ],
      actions: [{ label: "Open Experience ↗", hash: "experience" }],
      chips: ["Projects", "Skills", "Contact"],
    };
  }
  if (/education|school|study|aral|college|degree/i.test(q)) {
    return {
      texts: ["He's taking a <strong>BS in Information Technology</strong> (2022–2026) — and already shipping production systems while studying. 📚"],
      actions: [{ label: "Open Resume ↗", hash: "resume" }],
    };
  }
  if (/resume|cv|résumé|curriculum/i.test(q)) {
    return {
      texts: ["The full résumé is on the Resume page. 📄 The PDF download is owner-locked, but everything's readable right there."],
      actions: [{ label: "Open Resume ↗", hash: "resume" }],
    };
  }
  if (/contact|hire|email|reach|freelance|available|rate|work with|makipag/i.test(q)) {
    return {
      texts: [
        `Boyet is <strong>open to freelance and new opportunities</strong>! 🤝<br>• Email: <a href="mailto:${KB.email}">${KB.email}</a><br>• <a href="${KB.linkedin}" target="_blank" rel="noopener noreferrer">LinkedIn</a> · <a href="${KB.github}" target="_blank" rel="noopener noreferrer">GitHub</a>`,
      ],
      actions: [{ label: "Open Contact ↗", hash: "contact" }],
    };
  }
  if (/testimonial|feedback|review/i.test(q)) {
    return {
      texts: ["You can read what clients say about Boyet — or leave your own feedback — in the Testimonials section. Your name's already saved in my memory if you'd like to leave one. 😉"],
      actions: [{ label: "Open Testimonials ↗", hash: "testimonials" }],
    };
  }
  if (/music|song|kanta|sound|tugtog/i.test(q)) {
    return { texts: ["Nice catch — this site has a built-in lo-fi player! 🎧 Click the <strong>Sound</strong> button up top to pick a track (there's even a Jamendo search). Perfect browsing music."] };
  }
  if (/dark|light|theme|mode/i.test(q)) {
    const cur = document.documentElement.dataset.theme || "light";
    return { texts: [`You're on <strong>${cur} mode</strong> right now. Toggle the sun/moon switch up top to flip it — I'll remember your choice. ${cur === "light" ? "🌙" : "☀️"}`] };
  }
  if (/tour|guide|where.*start|libot|ikot/i.test(q)) {
    return {
      texts: ["Quick tour! 🗺 Start with <strong>About</strong> to meet Boyet, check <strong>Projects</strong> for his best work, then <strong>Contact</strong> if you'd like to reach out."],
      actions: [
        { label: "About", hash: "about" },
        { label: "Projects", hash: "projects" },
        { label: "Contact", hash: "contact" },
      ],
    };
  }
  if (/how many.*(visit|times)|ilang beses|nth visit/i.test(q)) {
    return { texts: [`This is your <strong>visit #${mem.visits}</strong>${prevVisitTs && mem.visits > 1 ? ` — you first dropped by ${timeAgo(mem.firstVisit)}` : ""}. 📊 I keep count, promise.`] };
  }

  /* — fallback — */
  return {
    texts: [
      "Hmm, I'm not sure about that one. 😅 I'm best at questions about <strong>Boyet</strong> — try one of these:",
    ],
    chips: ["Projects", "Skills", "Experience", "Contact"],
  };
}

/* ---------- ask the real AI (with a rule-based offline fallback) ---------- */
let aiChain = Promise.resolve();
function askAI(userText) {
  aiChain = aiChain.then(async () => {
    showTyping();
    try {
      const res = await fetch(CHAT_API, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Accept": "application/json" },
        body: JSON.stringify({
          messages: history.slice(-MAX_HISTORY),
          visitor: { name: mem.name, visits: mem.visits, last_section: mem.lastSection },
        }),
      });
      const data = await res.json().catch(() => ({}));
      hideTyping();
      if (res.ok && data.ok && data.reply) {
        addMsg(data.reply, "bot");
        pushHistory("assistant", stripTags(data.reply));
        setChips(DEFAULT_CHIPS);
        return;
      }
      throw new Error(data.error || "ai_unavailable");
    } catch (e) {
      // network down, no API key, or rate-limited — use the offline brain
      hideTyping();
      const res = brain(userText);
      reply(res.texts, { chips: res.chips, actions: res.actions });
      pushHistory("assistant", stripTags(res.texts[res.texts.length - 1]));
    }
  });
}

/* ---------- send flow ---------- */
function send(text) {
  const val = String(text).trim();
  if (!val) return;
  addMsg(esc(val), "user");
  pushHistory("user", val);
  mem.chats += 1;
  saveMemory();
  setChips([]);

  // Memory intents run locally & instantly; everything else goes to the AI.
  const local = localBrain(val);
  if (local) {
    reply(local.texts, { chips: local.chips, actions: local.actions });
    pushHistory("assistant", stripTags(local.texts[local.texts.length - 1]));
    return;
  }
  askAI(val);
}
formEl.addEventListener("submit", (e) => {
  e.preventDefault();
  const val = inputEl.value;
  inputEl.value = "";
  send(val);
});
