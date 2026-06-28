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
const MUSIC_URL = "music/apalonbeats-lofi-lofi-music-549425.mp3";
const MUSIC_VOL = 0.85;
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

  audioEl = new Audio(MUSIC_URL);
  audioEl.loop = true;
  audioEl.preload = "auto";
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
soundBtn.addEventListener("click", () => setSound(!soundOn));
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
  const M = 50;                    // page margin
  const RIGHT = PAGE_W - M;
  const INK = [22, 20, 15];
  const MUTED = [120, 115, 105];
  let y = M;

  const ensure = (needed) => { if (y + needed > PAGE_H - M) { doc.addPage(); y = M; } };
  const rule = () => { doc.setDrawColor(210, 205, 196); doc.setLineWidth(0.6); doc.line(M, y, RIGHT, y); };

  // ---- header ----
  const email = (document.querySelector('a[href^="mailto:"]')?.getAttribute("href") || "").replace("mailto:", "") || "boyet@creativedevlabs.dev";
  doc.setTextColor(...INK);
  doc.setFont("times", "bold"); doc.setFontSize(30);
  doc.text("Boyet", M, y + 6);
  doc.setFont("helvetica", "normal"); doc.setFontSize(11); doc.setTextColor(...MUTED);
  doc.text("Creative Developer — Front-end · WebGL · Motion", M, y + 26);
  doc.text(`${email}   ·   Philippines (GMT+8)`, M, y + 42);
  y += 60; rule(); y += 26;

  // ---- a titled block of bullet items ----
  const block = (title, items) => {
    if (!items.length) return;
    ensure(28 + items.length * 16);
    doc.setFont("helvetica", "bold"); doc.setFontSize(9); doc.setTextColor(...MUTED);
    doc.text(title.toUpperCase(), M, y, { charSpace: 1.2 });
    y += 16;
    doc.setFont("helvetica", "normal"); doc.setFontSize(11); doc.setTextColor(...INK);
    items.forEach((it) => {
      ensure(16);
      doc.text("•", M, y);
      doc.text(doc.splitTextToSize(it, RIGHT - M - 14), M + 14, y);
      y += 16;
    });
    y += 14;
  };

  // pull the three résumé columns straight from the DOM (stays in sync)
  document.querySelectorAll(".resume__col").forEach((col) => {
    const title = col.querySelector("h4")?.textContent.trim() || "";
    const items = [...col.querySelectorAll("li")].map((li) => li.textContent.trim());
    block(title, items);
  });

  // ---- experience ----
  const exps = [...document.querySelectorAll(".exp__item")];
  if (exps.length) {
    ensure(30);
    doc.setFont("helvetica", "bold"); doc.setFontSize(9); doc.setTextColor(...MUTED);
    doc.text("EXPERIENCE", M, y, { charSpace: 1.2 });
    y += 20;
    exps.forEach((item) => {
      const year = item.querySelector(".exp__year")?.textContent.trim() || "";
      const role = item.querySelector(".exp__body h3")?.textContent.trim() || "";
      const company = item.querySelector(".exp__body > p")?.textContent.trim() || "";
      const desc = item.querySelector(".exp__desc")?.textContent.trim() || "";
      const descLines = doc.splitTextToSize(desc, RIGHT - M);
      ensure(20 + 16 + descLines.length * 14 + 12);

      doc.setFont("times", "bold"); doc.setFontSize(13); doc.setTextColor(...INK);
      doc.text(role, M, y);
      doc.setFont("helvetica", "normal"); doc.setFontSize(9); doc.setTextColor(...MUTED);
      doc.text(year, RIGHT, y, { align: "right" });
      y += 15;
      doc.setFontSize(10);
      doc.text(company, M, y);
      y += 15;
      doc.setFontSize(10.5); doc.setTextColor(...INK);
      doc.text(descLines, M, y);
      y += descLines.length * 14 + 16;
    });
  }

  doc.save("Boyet-Resume.pdf");
}

const resumeBtn = document.getElementById("resumeBtn");
if (resumeBtn) {
  resumeBtn.addEventListener("click", (e) => {
    e.preventDefault();
    playTick();
    buildResumePDF();
  });
}
