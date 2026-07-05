/* =========================================================
   VAMPIRE NIGHT MODE — activation logic
   - Fully automatic: active from midnight to 4:59 AM,
     VISITOR's local time (new Date().getHours()). Outside
     those hours the normal theme is untouched — there is
     no manual toggle; the night decides.
   - Extras: "The night has fallen…" moment if midnight rolls
     over while they're on the page (once per session), rare
     drifting bats, and a "seen the night side" flag saved
     for a possible future achievement.

   TWEAK ME:
   - VAMPIRE_START / VAMPIRE_END below change the hours.
   - All colors live in css/vampire.css (first block).
   ========================================================= */
(function () {
  "use strict";

  var VAMPIRE_START = 0; // midnight (inclusive)
  var VAMPIRE_END = 5;   // active while hour < 5  →  12:00 AM – 4:59 AM

  var SEEN_KEY = "yax_night_seen";     // achievement flag (timestamp of first sighting)
  var SAVED_THEME_KEY = "vamp_saved_theme"; // theme to restore after a forced night
  var NIGHTFALL_FLAG = "vamp_midnight_shown"; // sessionStorage: rollover shown once

  /* localStorage can be blocked (private mode) — degrade gracefully */
  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
  function lsDel(k) { try { localStorage.removeItem(k); } catch (e) {} }

  function isNightHours() {
    var h = new Date().getHours();
    return h >= VAMPIRE_START && h < VAMPIRE_END;
  }
  function shouldBeVampire() {
    return isNightHours(); // the clock alone decides
  }
  lsDel("vamp_pref"); // clean up the old manual-toggle preference if present

  /* ---------- coordinate with the existing light/dark switch ----------
     Vampire mode looks right on a dark WebGL canvas, so entering it flips
     the site's own theme switch to dark (which retunes the fluid sim), and
     leaving restores whatever the visitor had before. If they touch the
     theme switch themselves mid-night, we respect that and restore nothing. */
  var themeInput = document.getElementById("input"); // checked = dark
  function currentTheme() { return document.documentElement.dataset.theme || "light"; }
  function setSiteTheme(theme) {
    if (!themeInput || currentTheme() === theme) return;
    themeInput.checked = theme === "dark";
    themeInput.dispatchEvent(new Event("change")); // main.js applyTheme() runs
  }
  if (themeInput) {
    themeInput.addEventListener("change", function () {
      // a manual flip while vampire is active becomes the visitor's choice
      if (document.body.classList.contains("vampire-mode")) lsDel(SAVED_THEME_KEY);
    });
  }

  /* ---------- night music ----------
     Entering vampire mode swaps the lo-fi for the horror ambience track;
     leaving restores whatever was playing before. Uses the yaxMusic bridge
     in main.js, which never force-unmutes — a muted visitor stays muted. */
  var VAMP_TRACK = "music/horrorsound.mp3";
  var prevTrackUrl = null;

  function vampMusicOn() {
    var m = window.yaxMusic;
    if (!m) return;
    if (m.current() !== VAMP_TRACK) prevTrackUrl = m.current();
    m.swap(VAMP_TRACK);
  }
  function vampMusicOff() {
    var m = window.yaxMusic;
    if (!m) return;
    // only restore if they're still on the vampire track — if they picked
    // their own song mid-night, that choice is theirs to keep
    if (m.current() === VAMP_TRACK && prevTrackUrl) m.swap(prevTrackUrl);
  }

  /* ---------- enter / leave ---------- */
  var batTimer = null;

  function enterVampire() {
    if (document.body.classList.contains("vampire-mode")) return;
    if (currentTheme() !== "dark") lsSet(SAVED_THEME_KEY, currentTheme());
    setSiteTheme("dark");
    document.body.classList.add("vampire-mode");
    lsSet(SEEN_KEY, lsGet(SEEN_KEY) || String(Date.now())); // achievement breadcrumb
    vampMusicOn();
    scheduleBat();
  }

  function leaveVampire() {
    if (!document.body.classList.contains("vampire-mode")) return;
    document.body.classList.remove("vampire-mode");
    clearTimeout(batTimer);
    vampMusicOff();
    var prev = lsGet(SAVED_THEME_KEY);
    if (prev) { lsDel(SAVED_THEME_KEY); setSiteTheme(prev); }
  }

  /* ---------- "The night has fallen…" (midnight rollover) ----------
     Checked every 30s: fires when the page is open as the clock
     crosses midnight, once per session. */
  var nightfallEl = null;
  function nightfallMoment() {
    try { if (sessionStorage.getItem(NIGHTFALL_FLAG)) { enterVampire(); return; } sessionStorage.setItem(NIGHTFALL_FLAG, "1"); } catch (e) {}
    if (!nightfallEl) {
      nightfallEl = document.createElement("div");
      nightfallEl.className = "vamp-nightfall";
      nightfallEl.innerHTML = "<p>The night has fallen…</p>";
      document.body.appendChild(nightfallEl);
    }
    requestAnimationFrame(function () {
      nightfallEl.classList.add("is-on");
      setTimeout(function () {
        enterVampire();
        nightfallEl.classList.remove("is-on"); // fade back out over the night side
      }, 2000);
    });
  }

  var wasNight = isNightHours();
  setInterval(function () {
    var night = isNightHours();
    if (night && !wasNight) nightfallMoment();       // crossed into the night
    else if (!night && wasNight) leaveVampire();     // dawn broke while browsing
    wasNight = night;
  }, 30000);

  /* ---------- rare drifting bats (1 at a time, every ~45–100s) ---------- */
  var BAT_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4.2c-.55 1.5-1.9 2.5-3.6 2.7C6.2 7.2 4.2 6.4 2 4.7c.8 2.6 2.2 4.5 4.2 5.6-1 .3-2 .3-3 .1 1.4 2.2 3.4 3.5 5.9 3.8l1 4.6c.3-.7.8-1.2 1.4-1.5l.5-2.7.5 2.7c.6.3 1.1.8 1.4 1.5l1-4.6c2.5-.3 4.5-1.6 5.9-3.8-1 .2-2 .2-3-.1 2-1.1 3.4-3 4.2-5.6-2.2 1.7-4.2 2.5-6.4 2.2-1.7-.2-3-1.2-3.6-2.7z"/></svg>';
  function scheduleBat() {
    clearTimeout(batTimer);
    batTimer = setTimeout(function () {
      if (document.body.classList.contains("vampire-mode")) {
        spawnBat();
        scheduleBat();
      }
    }, 45000 + Math.random() * 55000);
  }
  function spawnBat() {
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    var bat = document.createElement("div");
    var rtl = Math.random() < 0.5;
    bat.className = "vamp-bat" + (rtl ? " vamp-bat--rtl" : "");
    bat.style.top = (8 + Math.random() * 50) + "vh";
    bat.style.setProperty("--bat-time", (18 + Math.random() * 12) + "s");
    bat.innerHTML = BAT_SVG;
    document.body.appendChild(bat);
    bat.addEventListener("animationend", function (e) {
      if (e.target === bat) bat.remove();
    });
    setTimeout(function () { bat.remove(); }, 34000); // safety net
  }

  /* ---------- init ---------- */
  if (shouldBeVampire()) {
    enterVampire(); // instant on load — the rollover moment is only for live crossings
  } else {
    // daylight load: if a past forced night left the theme dark, restore choice
    var prev = lsGet(SAVED_THEME_KEY);
    if (prev) { lsDel(SAVED_THEME_KEY); setSiteTheme(prev); }
  }

  /* dev helpers — run in the console:
       yaxVampire.on()   yaxVampire.off()   yaxVampire.nightfall() */
  window.yaxVampire = {
    on: enterVampire,
    off: leaveVampire,
    nightfall: nightfallMoment,
    bat: spawnBat,
  };
})();
