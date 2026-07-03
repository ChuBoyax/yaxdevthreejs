/* =========================================================
   CONSOLE EASTER EGG
   A hidden "YAX" logo for the curious few who crack open
   DevTools. Purely cosmetic — no side effects.
   ========================================================= */
(function () {
  try {
    var accent = "#e5533c"; // warm ink accent, matches the site

    var art = [
      "",
      "   ▄██   ██▄   ▄▄▄   ▄██   ██▄",
      "    ██   ██   ██ ██   ▀██ ██▀ ",
      "     ▀███▀   ██▄▄▄██    ▀███▀  ",
      "      ██     ██   ██   ▄██ ██▄ ",
      "      ██     ██   ██  ▄██   ██▄",
      "",
    ].join("\n");

    console.log(
      "%c" + art,
      "color:" + accent + ";font-family:monospace;font-size:12px;line-height:1.15;font-weight:700;"
    );
  } catch (e) {
    /* never break the page over an easter egg */
  }
})();
