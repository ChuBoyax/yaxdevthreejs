import * as THREE from "three";

/* =========================================================
   REAL-TIME FLUID SIMULATION  (Unseen.co–style ink)
   GPU Navier-Stokes: advection · curl/vorticity · pressure
   solve · gradient subtract. Colorful dye is "painted" by
   the cursor over a cream canvas and slowly dissipates.
   ========================================================= */
const canvas = document.getElementById("bg");
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false });
renderer.autoClear = false;
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75));
renderer.setSize(window.innerWidth, window.innerHeight);
const gl = renderer.getContext();

const CFG = {
  SIM_RES: 140,
  DYE_RES: 1024,
  DENSITY_DISSIPATION: 0.55, // higher = ink fades faster
  VELOCITY_DISSIPATION: 1.6,
  PRESSURE: 0.8,
  PRESSURE_ITER: 20,
  CURL: 26,                  // swirliness
  SPLAT_RADIUS: 0.30,
  SPLAT_FORCE: 6200,
};

/* ---------- fullscreen blit rig ---------- */
const blitScene = new THREE.Scene();
const dummyCam = new THREE.Camera();
const blitMesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2));
blitScene.add(blitMesh);
function run(material, target) {
  blitMesh.material = material;
  renderer.setRenderTarget(target || null);
  renderer.render(blitScene, dummyCam);
}

/* ---------- framebuffer helpers ---------- */
function createFBO(w, h) {
  return new THREE.WebGLRenderTarget(w, h, {
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    format: THREE.RGBAFormat,
    type: THREE.HalfFloatType,
    depthBuffer: false,
    stencilBuffer: false,
    wrapS: THREE.ClampToEdgeWrapping,
    wrapT: THREE.ClampToEdgeWrapping,
  });
}
function createDoubleFBO(w, h) {
  let a = createFBO(w, h), b = createFBO(w, h);
  return {
    width: w, height: h, texelX: 1 / w, texelY: 1 / h,
    get read() { return a; },
    get write() { return b; },
    swap() { const t = a; a = b; b = t; },
    dispose() { a.dispose(); b.dispose(); },
  };
}
function getResolution(res) {
  const w = renderer.domElement.width, h = renderer.domElement.height;
  let aspect = w / h; if (aspect < 1) aspect = 1 / aspect;
  const min = Math.round(res), max = Math.round(res * aspect);
  return w > h ? { width: max, height: min } : { width: min, height: max };
}

/* ---------- shaders (GLSL ES 1.00) ---------- */
const baseVert = /* glsl */ `
  varying vec2 vUv, vL, vR, vT, vB;
  uniform vec2 texelSize;
  void main() {
    vUv = uv;
    vL = uv - vec2(texelSize.x, 0.0);
    vR = uv + vec2(texelSize.x, 0.0);
    vT = uv + vec2(0.0, texelSize.y);
    vB = uv - vec2(0.0, texelSize.y);
    gl_Position = vec4(position, 1.0);
  }
`;

const advectionFrag = /* glsl */ `
  precision highp float;
  varying vec2 vUv;
  uniform sampler2D uVelocity;
  uniform sampler2D uSource;
  uniform vec2 texelSize;
  uniform float dt;
  uniform float dissipation;
  void main() {
    vec2 coord = vUv - dt * texture2D(uVelocity, vUv).xy * texelSize;
    vec4 result = texture2D(uSource, coord);
    float decay = 1.0 + dissipation * dt;
    gl_FragColor = result / decay;
  }
`;

const divergenceFrag = /* glsl */ `
  precision highp float;
  varying vec2 vUv, vL, vR, vT, vB;
  uniform sampler2D uVelocity;
  void main() {
    float L = texture2D(uVelocity, vL).x;
    float R = texture2D(uVelocity, vR).x;
    float T = texture2D(uVelocity, vT).y;
    float B = texture2D(uVelocity, vB).y;
    vec2 C = texture2D(uVelocity, vUv).xy;
    if (vL.x < 0.0) L = -C.x;
    if (vR.x > 1.0) R = -C.x;
    if (vT.y > 1.0) T = -C.y;
    if (vB.y < 0.0) B = -C.y;
    gl_FragColor = vec4(0.5 * (R - L + T - B), 0.0, 0.0, 1.0);
  }
`;

const curlFrag = /* glsl */ `
  precision highp float;
  varying vec2 vUv, vL, vR, vT, vB;
  uniform sampler2D uVelocity;
  void main() {
    float L = texture2D(uVelocity, vL).y;
    float R = texture2D(uVelocity, vR).y;
    float T = texture2D(uVelocity, vT).x;
    float B = texture2D(uVelocity, vB).x;
    gl_FragColor = vec4(0.5 * (R - L - T + B), 0.0, 0.0, 1.0);
  }
`;

const vorticityFrag = /* glsl */ `
  precision highp float;
  varying vec2 vUv, vL, vR, vT, vB;
  uniform sampler2D uVelocity;
  uniform sampler2D uCurl;
  uniform float curl;
  uniform float dt;
  void main() {
    float L = texture2D(uCurl, vL).x;
    float R = texture2D(uCurl, vR).x;
    float T = texture2D(uCurl, vT).x;
    float B = texture2D(uCurl, vB).x;
    float C = texture2D(uCurl, vUv).x;
    vec2 force = 0.5 * vec2(abs(T) - abs(B), abs(R) - abs(L));
    force /= length(force) + 0.0001;
    force *= curl * C;
    force.y *= -1.0;
    vec2 vel = texture2D(uVelocity, vUv).xy;
    gl_FragColor = vec4(vel + force * dt, 0.0, 1.0);
  }
`;

const pressureFrag = /* glsl */ `
  precision highp float;
  varying vec2 vUv, vL, vR, vT, vB;
  uniform sampler2D uPressure;
  uniform sampler2D uDivergence;
  void main() {
    float L = texture2D(uPressure, vL).x;
    float R = texture2D(uPressure, vR).x;
    float T = texture2D(uPressure, vT).x;
    float B = texture2D(uPressure, vB).x;
    float divergence = texture2D(uDivergence, vUv).x;
    gl_FragColor = vec4((L + R + B + T - divergence) * 0.25, 0.0, 0.0, 1.0);
  }
`;

const gradientFrag = /* glsl */ `
  precision highp float;
  varying vec2 vUv, vL, vR, vT, vB;
  uniform sampler2D uPressure;
  uniform sampler2D uVelocity;
  void main() {
    float L = texture2D(uPressure, vL).x;
    float R = texture2D(uPressure, vR).x;
    float T = texture2D(uPressure, vT).x;
    float B = texture2D(uPressure, vB).x;
    vec2 velocity = texture2D(uVelocity, vUv).xy;
    velocity -= 0.5 * vec2(R - L, T - B);
    gl_FragColor = vec4(velocity, 0.0, 1.0);
  }
`;

const clearFrag = /* glsl */ `
  precision highp float;
  varying vec2 vUv;
  uniform sampler2D uTexture;
  uniform float value;
  void main() { gl_FragColor = value * texture2D(uTexture, vUv); }
`;

const splatFrag = /* glsl */ `
  precision highp float;
  varying vec2 vUv;
  uniform sampler2D uTarget;
  uniform float aspectRatio;
  uniform vec3 color;
  uniform vec2 point;
  uniform float radius;
  void main() {
    vec2 p = vUv - point;
    p.x *= aspectRatio;
    vec3 splat = exp(-dot(p, p) / radius) * color;
    vec3 base = texture2D(uTarget, vUv).xyz;
    gl_FragColor = vec4(base + splat, 1.0);
  }
`;

const displayFrag = /* glsl */ `
  precision highp float;
  varying vec2 vUv;
  uniform sampler2D uTexture;
  uniform float uTime;
  uniform vec3 uBg;
  void main() {
    vec3 dye = texture2D(uTexture, vUv).rgb;
    float m = max(dye.r, max(dye.g, dye.b));
    float a = clamp(m, 0.0, 1.0);
    vec3 ink = dye / max(m, 0.0001);
    vec3 cream = uBg;
    vec3 col = mix(cream, ink, a * 0.94);
    // soft bloom-ish lift in dense ink
    col += smoothstep(0.6, 1.4, m) * ink * 0.12;
    // film grain
    float g = fract(sin(dot(gl_FragCoord.xy + uTime, vec2(12.9898, 78.233))) * 43758.5453);
    col += (g - 0.5) * 0.028;
    // vignette
    vec2 q = vUv - 0.5;
    col *= 1.0 - dot(q, q) * 0.22;
    gl_FragColor = vec4(col, 1.0);
  }
`;

/* ---------- materials ---------- */
const matOpts = { depthTest: false, depthWrite: false };
function mat(frag, uniforms) {
  return new THREE.ShaderMaterial({ vertexShader: baseVert, fragmentShader: frag, uniforms, ...matOpts });
}
const T2 = () => ({ value: new THREE.Vector2() });

const advectionMat = mat(advectionFrag, {
  texelSize: T2(), uVelocity: { value: null }, uSource: { value: null },
  dt: { value: 0 }, dissipation: { value: 0 },
});
const divergenceMat = mat(divergenceFrag, { texelSize: T2(), uVelocity: { value: null } });
const curlMat = mat(curlFrag, { texelSize: T2(), uVelocity: { value: null } });
const vorticityMat = mat(vorticityFrag, {
  texelSize: T2(), uVelocity: { value: null }, uCurl: { value: null },
  curl: { value: CFG.CURL }, dt: { value: 0 },
});
const pressureMat = mat(pressureFrag, { texelSize: T2(), uPressure: { value: null }, uDivergence: { value: null } });
const gradientMat = mat(gradientFrag, { texelSize: T2(), uPressure: { value: null }, uVelocity: { value: null } });
const clearMat = mat(clearFrag, { texelSize: T2(), uTexture: { value: null }, value: { value: CFG.PRESSURE } });
const splatMat = mat(splatFrag, {
  texelSize: T2(), uTarget: { value: null }, aspectRatio: { value: 1 },
  color: { value: new THREE.Vector3() }, point: { value: new THREE.Vector2() }, radius: { value: 0 },
});
const displayMat = mat(displayFrag, {
  texelSize: T2(), uTexture: { value: null }, uTime: { value: 0 },
  uBg: { value: new THREE.Vector3(0.927, 0.912, 0.884) },
});

/* ---------- buffers ---------- */
let velocity, dye, divergenceFBO, curlFBO, pressure;
function initFBOs() {
  const sim = getResolution(CFG.SIM_RES);
  const dyeRes = getResolution(CFG.DYE_RES);
  if (velocity) { velocity.dispose(); dye.dispose(); pressure.dispose(); divergenceFBO.dispose(); curlFBO.dispose(); }
  velocity = createDoubleFBO(sim.width, sim.height);
  pressure = createDoubleFBO(sim.width, sim.height);
  divergenceFBO = createFBO(sim.width, sim.height);
  curlFBO = createFBO(sim.width, sim.height);
  dye = createDoubleFBO(dyeRes.width, dyeRes.height);
}
initFBOs();

/* ---------- splats ---------- */
function correctRadius(r) {
  const aspect = canvas.width / canvas.height;
  return aspect > 1 ? r * aspect : r;
}
function splat(target, x, y, r, g, b, radius) {
  splatMat.uniforms.texelSize.value.set(target.texelX, target.texelY);
  splatMat.uniforms.uTarget.value = target.read.texture;
  splatMat.uniforms.aspectRatio.value = canvas.width / canvas.height;
  splatMat.uniforms.point.value.set(x, y);
  splatMat.uniforms.color.value.set(r, g, b);
  splatMat.uniforms.radius.value = correctRadius(radius / 100);
  run(splatMat, target.write);
  target.swap();
}
function HSVtoRGB(h, s, v) {
  const i = Math.floor(h * 6), f = h * 6 - i;
  const p = v * (1 - s), q = v * (1 - f * s), t = v * (1 - (1 - f) * s);
  const m = [[v, t, p], [q, v, p], [p, v, t], [p, q, v], [t, p, v], [v, p, q]][i % 6];
  return { r: m[0], g: m[1], b: m[2] };
}
function genColor(scale = 0.16) {
  const c = HSVtoRGB(Math.random(), 1.0, 1.0);
  return { r: c.r * scale, g: c.g * scale, b: c.b * scale };
}
function splatPointer(px, py, dx, dy) {
  splat(velocity, px, py, dx, dy, 0, CFG.SPLAT_RADIUS);
  const c = genColor();
  splat(dye, px, py, c.r, c.g, c.b, CFG.SPLAT_RADIUS);
}
function randomSplats(n) {
  for (let i = 0; i < n; i++) {
    const c = genColor(0.22);
    const x = Math.random(), y = Math.random();
    const dx = 1000 * (Math.random() - 0.5);
    const dy = 1000 * (Math.random() - 0.5);
    splat(velocity, x, y, dx, dy, 0, CFG.SPLAT_RADIUS);
    splat(dye, x, y, c.r, c.g, c.b, CFG.SPLAT_RADIUS);
  }
}

/* ---------- pointer input ---------- */
let lastX = null, lastY = null, lastMove = performance.now();
function onMove(clientX, clientY) {
  ensureAudio();
  hideHint();
  if (lastX === null) { lastX = clientX; lastY = clientY; return; }
  const dx = ((clientX - lastX) / window.innerWidth) * CFG.SPLAT_FORCE;
  const dy = ((lastY - clientY) / window.innerHeight) * CFG.SPLAT_FORCE;
  lastX = clientX; lastY = clientY;
  lastMove = performance.now();
  splatPointer(clientX / window.innerWidth, 1 - clientY / window.innerHeight, dx, dy);
}
window.addEventListener("pointermove", (e) => onMove(e.clientX, e.clientY));
window.addEventListener("touchmove", (e) => {
  if (e.touches[0]) onMove(e.touches[0].clientX, e.touches[0].clientY);
}, { passive: true });

// keep it alive when idle
setInterval(() => {
  if (performance.now() - lastMove > 1600) randomSplats(1);
}, 1400);

/* ---------- simulation step ---------- */
function step(dt) {
  const tx = velocity.texelX, ty = velocity.texelY;

  curlMat.uniforms.texelSize.value.set(tx, ty);
  curlMat.uniforms.uVelocity.value = velocity.read.texture;
  run(curlMat, curlFBO);

  vorticityMat.uniforms.texelSize.value.set(tx, ty);
  vorticityMat.uniforms.uVelocity.value = velocity.read.texture;
  vorticityMat.uniforms.uCurl.value = curlFBO.texture;
  vorticityMat.uniforms.dt.value = dt;
  run(vorticityMat, velocity.write); velocity.swap();

  divergenceMat.uniforms.texelSize.value.set(tx, ty);
  divergenceMat.uniforms.uVelocity.value = velocity.read.texture;
  run(divergenceMat, divergenceFBO);

  clearMat.uniforms.uTexture.value = pressure.read.texture;
  clearMat.uniforms.value.value = CFG.PRESSURE;
  run(clearMat, pressure.write); pressure.swap();

  pressureMat.uniforms.texelSize.value.set(tx, ty);
  pressureMat.uniforms.uDivergence.value = divergenceFBO.texture;
  for (let i = 0; i < CFG.PRESSURE_ITER; i++) {
    pressureMat.uniforms.uPressure.value = pressure.read.texture;
    run(pressureMat, pressure.write); pressure.swap();
  }

  gradientMat.uniforms.texelSize.value.set(tx, ty);
  gradientMat.uniforms.uPressure.value = pressure.read.texture;
  gradientMat.uniforms.uVelocity.value = velocity.read.texture;
  run(gradientMat, velocity.write); velocity.swap();

  // advect velocity
  advectionMat.uniforms.texelSize.value.set(tx, ty);
  advectionMat.uniforms.uVelocity.value = velocity.read.texture;
  advectionMat.uniforms.uSource.value = velocity.read.texture;
  advectionMat.uniforms.dt.value = dt;
  advectionMat.uniforms.dissipation.value = CFG.VELOCITY_DISSIPATION;
  run(advectionMat, velocity.write); velocity.swap();

  // advect dye
  advectionMat.uniforms.uVelocity.value = velocity.read.texture;
  advectionMat.uniforms.uSource.value = dye.read.texture;
  advectionMat.uniforms.dissipation.value = CFG.DENSITY_DISSIPATION;
  run(advectionMat, dye.write); dye.swap();
}

/* ---------- render ---------- */
let lastTime = performance.now();
function frame() {
  const now = performance.now();
  let dt = (now - lastTime) / 1000;
  dt = Math.min(dt, 0.016666);
  lastTime = now;

  step(dt);

  displayMat.uniforms.uTexture.value = dye.read.texture;
  displayMat.uniforms.uTime.value = now * 0.001;
  run(displayMat, null);

  requestAnimationFrame(frame);
}

window.addEventListener("resize", () => {
  renderer.setSize(window.innerWidth, window.innerHeight);
  initFBOs();
});

// opening burst of ink, then go
randomSplats(9);
frame();

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
    const initial = document.getElementById(fromHash)?.classList.contains("page") ? fromHash : "home";
    showPage(initial, { silent: true });
    randomSplats(6);
  }, 350);
}

/* =========================================================
   3. Custom cursor
   ========================================================= */
const cursor = document.getElementById("cursor");
let cx = innerWidth / 2, cy = innerHeight / 2, ctx = cx, cty = cy;
window.addEventListener("pointermove", (e) => { ctx = e.clientX; cty = e.clientY; });
(function cursorLoop() {
  cx += (ctx - cx) * 0.2;
  cy += (cty - cy) * 0.2;
  cursor.style.transform = `translate(${cx}px, ${cy}px) translate(-50%, -50%)`;
  requestAnimationFrame(cursorLoop);
})();
document.querySelectorAll("[data-cursor]").forEach((el) => {
  el.addEventListener("mouseenter", () => cursor.classList.add("is-hover"));
  el.addEventListener("mouseleave", () => cursor.classList.remove("is-hover"));
});

/* =========================================================
   4. Live clock (Manila)
   ========================================================= */
const clockEl = document.getElementById("clock");
function updateClock() {
  const now = new Date().toLocaleTimeString("en-US", {
    timeZone: "Asia/Manila", hour: "numeric", minute: "2-digit", hour12: true,
  });
  clockEl.textContent = `MNL ${now}`;
}
updateClock();
setInterval(updateClock, 1000);

/* =========================================================
   5. Page navigation + per-page reveal animations
   ========================================================= */
function showPage(id, opts = {}) {
  const target = document.getElementById(id);
  if (!target || !target.classList.contains("page")) return false;
  const current = document.querySelector(".page.is-active");
  if (current === target) { target.scrollTop = 0; return true; }

  if (current) current.classList.remove("is-active", "is-in");

  target.classList.add("is-active");
  target.scrollTop = 0;
  // reset + re-trigger child reveal animations every time the page opens
  target.classList.remove("is-in");
  void target.offsetWidth; // force reflow
  requestAnimationFrame(() => requestAnimationFrame(() => target.classList.add("is-in")));

  if (!opts.silent && location.hash !== "#" + id) {
    history.replaceState(null, "", "#" + id);
  }
  // a soft whoosh on page change (reuses the menu sound)
  if (!opts.silent && typeof playSwoosh === "function") playSwoosh(true);
  return true;
}

window.addEventListener("hashchange", () => {
  const id = location.hash.slice(1);
  if (id) showPage(id, { silent: true });
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
   7. In-page links → switch pages (with transition)
   ========================================================= */
document.querySelectorAll('a[href^="#"]').forEach((a) => {
  a.addEventListener("click", (e) => {
    const id = a.getAttribute("href").slice(1);
    if (document.getElementById(id)?.classList.contains("page")) {
      e.preventDefault();
      showPage(id);
    }
  });
});

/* =========================================================
   8. Audio — looping lofi track (your MP3) routed through a
   Web Audio low-pass so the menu can "muffle/duck" it.
   ========================================================= */
// add more tracks here — just drop the .mp3 in music/ and add a { name, url } line
const LOCAL_TRACKS = [
  { name: "Lo-fi Beats", url: "music/apalonbeats-lofi-lofi-music-549425.mp3" },
  { name: "Good Night (Cozy Chill)", url: "music/fassounds-good-night-lofi-cozy-chill-music-160166.mp3" },
  { name: "Leberch Lo-fi", url: "music/leberch-lofi-516620.mp3" },
  { name: "Lo-fi Hip-Hop", url: "music/leberch-lofi-hip-hop-519408.mp3" },
  { name: "Mirostar Beats", url: "music/mirostar-lofi-beats-531504.mp3" },
  { name: "Lo-fi Girl (Chill)", url: "music/mirostar-lofi-lofi-girl-lofi-chill-2-531491.mp3" },
  { name: "Mirostar Lo-fi", url: "music/mirostar-lofi-lofi-music-531487.mp3" },
  { name: "Lo-fi Girl", url: "music/mondamusic-lofi-lofi-girl-lofi-music-529555.mp3" },
  { name: "Monda Chill", url: "music/mondamusic-lofi-lofi-music-lofi-chill-529558.mp3" },
  { name: "Melody", url: "music/pulsebox-lofi-melody-522894.mp3" },
  { name: "Mood", url: "music/pulsebox-lofi-mood-522871.mp3" },
  { name: "Night", url: "music/pulsebox-lofi-night-522890.mp3" },
  { name: "Production", url: "music/pulsebox-lofi-production-522875.mp3" },
  { name: "Smooth", url: "music/pulsebox-lofi-smooth-522876.mp3" },
  { name: "The Mountain", url: "music/the_mountain-lofi-513863.mp3" },
  { name: "Mountain Lo-fi", url: "music/the_mountain-lofi-lofi-music-496553.mp3" },
  { name: "Vampire Night 🦇", url: "music/horrorsound.mp3" },
];
let onlineTracks = [];                       // filled from Jamendo (default lo-fi or search results)
let TRACKS = LOCAL_TRACKS.slice();           // local + online combined (rebuilt as online changes)
function rebuildTracks() { TRACKS = LOCAL_TRACKS.concat(onlineTracks); }
const MUSIC_URL = LOCAL_TRACKS[0].url;
let currentUrl = MUSIC_URL;
const MUSIC_VOL = 0.85;

// Jamendo (free, royalty-free) — paste your Client ID here to stream many more lo-fi tracks.
// Get one free at https://devportal.jamendo.com/  (leave "" to use local tracks only)
const JAMENDO_CLIENT_ID = "401b57bf";
let actx = null, master = null, musicGain = null, musicFilter = null, audioEl = null, soundOn = true;

function ensureAudio() {
  if (!actx) { initAudio(); return; }
  if (actx.state === "suspended") actx.resume();
  if (audioEl && audioEl.paused && soundOn) audioEl.play().catch(() => {});
}
function initAudio() {
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) { soundOn = false; return; }
  actx = new AC();
  master = actx.createGain(); master.gain.value = 1.0; master.connect(actx.destination);

  musicFilter = actx.createBiquadFilter();
  musicFilter.type = "lowpass";
  musicFilter.frequency.value = 22000;
  musicFilter.Q.value = 0.4;

  musicGain = actx.createGain(); musicGain.gain.value = 0.0001;
  musicFilter.connect(musicGain); musicGain.connect(master);

  // currentUrl (not MUSIC_URL) so a track picked before init — e.g. vampire
  // mode swapping in its own music at load — is what actually starts playing
  audioEl = new Audio(currentUrl);
  audioEl.loop = true;
  audioEl.preload = "auto";
  audioEl.crossOrigin = "anonymous"; // needed so external (Jamendo) audio works through Web Audio
  actx.createMediaElementSource(audioEl).connect(musicFilter);

  if (soundOn) {
    audioEl.play().catch(() => {});
    musicGain.gain.exponentialRampToValueAtTime(MUSIC_VOL, actx.currentTime + 1.2);
  }
}

// "natabunan" — muffle + dip the music briefly, then bring it back
function duckMusic() {
  if (!actx || !musicFilter || !soundOn) return;
  const t = actx.currentTime;
  musicFilter.frequency.cancelScheduledValues(t);
  musicFilter.frequency.setValueAtTime(musicFilter.frequency.value, t);
  musicFilter.frequency.linearRampToValueAtTime(350, t + 0.06);
  musicFilter.frequency.linearRampToValueAtTime(22000, t + 0.85);
  musicGain.gain.cancelScheduledValues(t);
  musicGain.gain.setValueAtTime(Math.max(musicGain.gain.value, 0.0002), t);
  musicGain.gain.linearRampToValueAtTime(MUSIC_VOL * 0.32, t + 0.06);
  musicGain.gain.linearRampToValueAtTime(MUSIC_VOL, t + 0.85);
}

// sustained muffle — stays "natabunan" while ON, restores when OFF
function setMusicMuffled(on) {
  if (!actx || !musicFilter || !musicGain) return;
  const t = actx.currentTime;
  musicFilter.frequency.cancelScheduledValues(t);
  musicFilter.frequency.setValueAtTime(musicFilter.frequency.value, t);
  musicFilter.frequency.linearRampToValueAtTime(on ? 900 : 22000, t + (on ? 0.25 : 0.55));
  if (!soundOn) return;
  musicGain.gain.cancelScheduledValues(t);
  musicGain.gain.setValueAtTime(Math.max(musicGain.gain.value, 0.0002), t);
  musicGain.gain.linearRampToValueAtTime(on ? MUSIC_VOL * 0.62 : MUSIC_VOL, t + (on ? 0.25 : 0.55));
}

// short "tick" UI sound (menu hover)
function playTick() {
  if (!soundOn || !actx || !master) return;
  const t = actx.currentTime;
  const o = actx.createOscillator(); o.type = "square"; o.frequency.value = 2100;
  const g = actx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(0.06, t + 0.003);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.05);
  o.connect(g); g.connect(master);
  o.start(t); o.stop(t + 0.06);
}

// "whoosh" — slide-over open/close sound (filtered noise sweep)
function playSwoosh(open) {
  if (!soundOn || !actx || !master) return;
  const t = actx.currentTime;
  const dur = 0.5;
  // short burst of white noise
  const buf = actx.createBuffer(1, Math.ceil(actx.sampleRate * dur), actx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  const src = actx.createBufferSource(); src.buffer = buf;

  const bp = actx.createBiquadFilter();
  bp.type = "bandpass"; bp.Q.value = 0.8;
  // open: sweep up (air rushing in) — close: sweep down (settling)
  bp.frequency.setValueAtTime(open ? 500 : 2400, t);
  bp.frequency.exponentialRampToValueAtTime(open ? 2600 : 380, t + dur);

  const g = actx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(0.16, t + 0.07);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);

  src.connect(bp); bp.connect(g); g.connect(master);
  src.start(t); src.stop(t + dur);
}

/* sound toggle + hint wiring */
const soundBtn = document.getElementById("soundToggle");
const hint = document.getElementById("hint");
let hintHidden = false;
function hideHint() {
  if (!hintHidden && hint) { hintHidden = true; hint.classList.add("is-hidden"); }
}
function setSound(on) {
  soundOn = on;
  soundBtn.classList.toggle("is-on", on);
  soundBtn.querySelector(".nav__sound-txt").textContent = on ? "Sound" : "Muted";
  if (on) {
    ensureAudio();
    if (audioEl) audioEl.play().catch(() => {});
    if (musicGain) musicGain.gain.linearRampToValueAtTime(MUSIC_VOL, actx.currentTime + 0.4);
  } else if (actx && musicGain) {
    musicGain.gain.linearRampToValueAtTime(0.0001, actx.currentTime + 0.4);
  }
}
/* ---- music picker popover ---- */
const soundMenu = document.getElementById("soundMenu");

function setTrack(url) {
  if (!url) return;
  currentUrl = url;
  ensureAudio();
  if (audioEl && audioEl.src.indexOf(url) === -1) { audioEl.src = url; audioEl.load(); }
  if (!soundOn) setSound(true);          // unmute + ramp up
  else if (audioEl) audioEl.play().catch(() => {});
  updateSoundMenu();
}

/* tiny bridge so vampire mode (js/vampire.js) can swap the music.
   Unlike setTrack, swap() never force-unmutes: a muted visitor stays
   muted — the new track simply becomes what plays when they unmute. */
window.yaxMusic = {
  current: () => currentUrl,
  swap(url) {
    if (!url) return;
    currentUrl = url;
    if (audioEl) {
      if (audioEl.src.indexOf(url) === -1) { audioEl.src = url; audioEl.load(); }
      if (soundOn) audioEl.play().catch(() => {});
    }
    updateSoundMenu();
  },
};

let soundSearchEl = null, soundListEl = null, soundSearchTimer = null;

// build the fixed parts once (search box + list container) so typing keeps focus
function initSoundMenu() {
  if (!soundMenu) return;
  soundMenu.innerHTML = "";
  const search = document.createElement("div");
  search.className = "sound-menu__search";
  search.innerHTML = `<input type="text" id="soundSearch" placeholder="Search music…" autocomplete="off" spellcheck="false" />`;
  soundMenu.appendChild(search);
  soundListEl = document.createElement("div");
  soundListEl.className = "sound-menu__list";
  soundMenu.appendChild(soundListEl);

  const credit = document.createElement("div");
  credit.className = "sound-menu__credit";
  credit.innerHTML = `Music via <a href="https://www.jamendo.com" target="_blank" rel="noopener">Jamendo</a> · royalty-free`;
  credit.addEventListener("click", (e) => e.stopPropagation());
  soundMenu.appendChild(credit);

  soundSearchEl = search.querySelector("input");
  soundSearchEl.addEventListener("input", () => {
    clearTimeout(soundSearchTimer);
    const qy = soundSearchEl.value.trim();
    soundSearchTimer = setTimeout(() => searchJamendo(qy), 350);
  });
  soundSearchEl.addEventListener("click", (e) => e.stopPropagation());

  renderSoundList();
}

function renderSoundList() {
  if (!soundListEl) return;
  soundListEl.innerHTML = "";
  const label = (txt) => {
    const l = document.createElement("span"); l.className = "sound-menu__label"; l.textContent = txt;
    soundListEl.appendChild(l);
  };
  const addItem = (tk) => {
    const b = document.createElement("button");
    b.className = "sound-menu__item"; b.type = "button"; b.dataset.url = tk.url;
    b.innerHTML = `<span class="sound-menu__name">${tk.name}</span><span class="sound-menu__dot"></span>`;
    b.addEventListener("mouseenter", playTick);
    b.addEventListener("click", () => { setTrack(tk.url); closeSoundMenu(); });
    soundListEl.appendChild(b);
  };
  const searching = soundSearchEl && soundSearchEl.value.trim();

  if (LOCAL_TRACKS.length) { label("On this site"); LOCAL_TRACKS.forEach(addItem); }
  if (onlineTracks.length) { label(searching ? "Search results" : "From Jamendo"); onlineTracks.forEach(addItem); }
  else if (searching) { const n = document.createElement("span"); n.className = "sound-menu__empty"; n.textContent = "No results found"; soundListEl.appendChild(n); }

  const mute = document.createElement("button");
  mute.className = "sound-menu__item sound-menu__item--mute"; mute.type = "button"; mute.dataset.mute = "1";
  mute.innerHTML = `<span class="sound-menu__name">Mute</span><span class="sound-menu__dot"></span>`;
  mute.addEventListener("mouseenter", playTick);
  mute.addEventListener("click", () => { setSound(false); updateSoundMenu(); closeSoundMenu(); });
  soundListEl.appendChild(mute);
  updateSoundMenu();
}

function updateSoundMenu() {
  if (!soundListEl) return;
  soundListEl.querySelectorAll(".sound-menu__item").forEach((el) => {
    const isMute = el.dataset.mute === "1";
    const active = isMute ? !soundOn : (soundOn && el.dataset.url === currentUrl);
    el.classList.toggle("is-active", active);
  });
}

let soundMenuOpen = false;
function openSoundMenu() {
  soundMenuOpen = true; soundMenu.classList.add("is-open");
  soundBtn.setAttribute("aria-expanded", "true"); updateSoundMenu();
}
function closeSoundMenu() {
  soundMenuOpen = false; soundMenu.classList.remove("is-open");
  soundBtn.setAttribute("aria-expanded", "false");
}

soundBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  ensureAudio();
  soundMenuOpen ? closeSoundMenu() : openSoundMenu();
});
document.addEventListener("click", (e) => {
  if (soundMenuOpen && !soundMenu.contains(e.target) && !soundBtn.contains(e.target)) closeSoundMenu();
});
window.addEventListener("keydown", (e) => { if (e.key === "Escape" && soundMenuOpen) closeSoundMenu(); });
initSoundMenu();

// fetch tracks from Jamendo — default popular lo-fi, or by search query (Client ID required)
async function searchJamendo(query) {
  if (!JAMENDO_CLIENT_ID || !soundListEl) return;
  try {
    const base = `https://api.jamendo.com/v3.0/tracks/?client_id=${JAMENDO_CLIENT_ID}&format=json&limit=120&audioformat=mp32`;
    const url = query
      ? `${base}&namesearch=${encodeURIComponent(query)}&order=popularity_total`
      : `${base}&fuzzytags=lofi+chill&order=popularity_total`;
    const res = await fetch(url);
    const data = await res.json();
    onlineTracks = (data.results || [])
      .filter((t) => t.audio)
      .map((t) => ({ name: `${t.name} — ${t.artist_name}`, url: t.audio }));
    rebuildTracks();
    renderSoundList();
  } catch (e) { /* offline / API error — keep current tracks */ }
}
searchJamendo("");   // initial default lo-fi list

window.addEventListener("pointerdown", ensureAudio);

/* =========================================================
   9. Theme toggle (light / dark) + menu "muffle" effect
   ========================================================= */
const themeInput = document.getElementById("input"); // Uiverse switch checkbox (checked = dark)
const BG_LIGHT = [0.927, 0.912, 0.884];
const BG_DARK = [0.052, 0.052, 0.060];
function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  localStorage.setItem("theme", theme);
  if (themeInput) themeInput.checked = theme === "dark";
  const c = theme === "dark" ? BG_DARK : BG_LIGHT;
  displayMat.uniforms.uBg.value.set(c[0], c[1], c[2]);
}
applyTheme(document.documentElement.dataset.theme || "light");
if (themeInput) {
  themeInput.addEventListener("change", () => {
    applyTheme(themeInput.checked ? "dark" : "light");
  });
}

/* =========================================================
   10. Full-screen menu — open/close + muffle ("natabunan")
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
  ensureAudio();
  playSwoosh(open);       // whoosh sound on open/close
  setMusicMuffled(open); // muffled while open, restores on close
}
menuToggle.addEventListener("click", () => setMenu(!menuOpen));
menu.querySelectorAll('a[href^="#"]').forEach((a) => {
  a.addEventListener("click", () => setMenu(false));
});
// "tiktik" sound when hovering menu items
menu.querySelectorAll(".menu__nav a").forEach((a) => {
  a.addEventListener("mouseenter", playTick);
});
// same "tick" sound when hovering each project card
document.querySelectorAll(".proj-card").forEach((card) => {
  card.addEventListener("mouseenter", playTick);
});
window.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && menuOpen) setMenu(false);
});

// brand click also ducks the music
document.querySelector(".nav__brand").addEventListener("click", duckMusic);

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
  const role = q(".resume__role")?.textContent.trim() || "Full-Stack Developer";
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
    if (photoData) {
      const ph = 80 * S;
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
    contacts.forEach((c, i) => t(c, RIGHT, y + 4 * S + i * 12.5 * S, { align: "right" }));
    const textBottom = y + Math.max((photoData ? 56 : 30) * S, 4 * S + contacts.length * 12.5 * S);
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
      const lines = doc.splitTextToSize(txt, RIGHT - M);
      doc.setFont("helvetica", "normal"); doc.setFontSize(10 * S); doc.setTextColor(...INK);
      t(lines, M, y); y += lines.length * LH + 7 * S;
    };
    const bullet = (txt) => {
      const lines = doc.splitTextToSize(txt, RIGHT - M - 13 * S);
      doc.setFont("helvetica", "normal"); doc.setFontSize(10 * S); doc.setTextColor(...INK);
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
  const RESUME_API_BASE = (
    location.hostname.endsWith(".test") ||
    location.hostname === "localhost" ||
    location.hostname === "127.0.0.1"
  ) ? "http://testimonials-api.test/api" : "https://testimonials-kappa-sable.vercel.app/api";
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

  resumeBtn.addEventListener("click", (e) => { e.preventDefault(); playTick(); openGate(); });
  gateClose.addEventListener("click", () => { playTick(); closeGate(); });
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
// Use the STABLE production alias (auto-points to the latest production deploy),
// NOT a per-deployment hash URL — hash URLs freeze to one build (so new backend
// features like the social badge silently disappear) and are gated behind Vercel
// SSO. This alias is public and always current.
const TM_PROD_API = "https://testimonials-kappa-sable.vercel.app/api/testimonials";
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
    s.addEventListener("mouseenter", () => { paint(Number(s.dataset.val)); playTick(); });
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
        body: JSON.stringify({ name, role, social, rating, message }),
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
