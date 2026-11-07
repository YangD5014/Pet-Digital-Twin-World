// 猫咪探索 · 第三人称场景漫步
// 素材：data/scene.glb（Sketchfab 院子场景，厘米→米 ×0.01）
//      data/cat.glb（猫咪绑定_动画1.blend 导出：Walk 161f / Run 81f，原地循环）
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';

/* ---------------- 调参区（来自 Blender 测量） ---------------- */
const CFG = {
  sceneScale: 0.01,            // Sketchfab cm → m
  catScale: 0.25,              // 猫 5.19 glTF 单位 → 1.30m（鼻尖到尾尖）
  // Blender 实测步态（in-place，root 每周期位移≈0）：
  //   Walk: 步幅≈0.30-0.34u，速度 0.3689u/s；Run: 步幅≈0.57-0.72u，速度 3.4464u/s
  nativeWalk: 0.3689 * 0.25,   // m/s，动作 1x 速率下消除滑步的世界速度
  nativeRun: 3.4464 * 0.25,
  walkSpeed: 0.25,             // 走路速度 m/s（timeScale = speed/native，任意速度均无滑步）
  runSpeed: 1.4,               // 疾跑速度 m/s
  liftY: 0.02,                 // 模型高度偏移 m（修爪部/地面穿模）
  catRadius: 0.30,             // 墙面碰撞半径(m)
  glbFootY: 0.39,              // 导出器把猫整体上移后的静止脚底高度(glTF 单位)
  jumpV: 1.9, gravity: 7.5,
  turnRate: 9.0,               // 转向 rad/s
  camDist: 3.4, camMin: 1.5, camMax: 9.0,
};

/* ---------------- 全局错误钩子（抓 rAF 内的静默异常） ---------------- */
window.addEventListener('error', e => {
  const box = document.getElementById('errbox');
  if (box) {
    box.style.display = 'block';
    box.textContent = '⚠ ' + e.message + '\n' + (e.filename || '') + ':' + e.lineno;
  }
  window.__lastErr = e.message + ' @ ' + (e.filename || '') + ':' + e.lineno;
});

/* ---------------- 渲染器 / 场景 ---------------- */
const canvas = document.getElementById('app');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(55, innerWidth / innerHeight, 0.05, 500);

/* ---------------- 天空 / 环境光（程序化渐变 equirect） ---------------- */
function gradientEquirect() {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 128;
  const g = c.getContext('2d');
  const grad = g.createLinearGradient(0, 0, 0, 128);
  grad.addColorStop(0.00, '#5aa7e8');   // 天顶
  grad.addColorStop(0.45, '#a8d4f2');
  grad.addColorStop(0.55, '#e8eef2');   // 地平线
  grad.addColorStop(0.75, '#8a9a6d');
  grad.addColorStop(1.00, '#5e6b4f');   // 地面
  g.fillStyle = grad; g.fillRect(0, 0, 256, 128);
  // 太阳亮斑
  const sun = g.createRadialGradient(200, 38, 2, 200, 38, 26);
  sun.addColorStop(0, '#ffffff');
  sun.addColorStop(1, '#ffffff00');
  g.fillStyle = sun; g.fillRect(160, 0, 96, 80);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.mapping = THREE.EquirectangularReflectionMapping;
  return tex;
}
const skyTex = gradientEquirect();
scene.background = skyTex;
{
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromEquirectangular(skyTex).texture;
  pmrem.dispose();
}

/* ---------------- 光照 ---------------- */
const hemi = new THREE.HemisphereLight(0xbdd7ff, 0x6b7355, 0.55);
scene.add(hemi);
const sun = new THREE.DirectionalLight(0xfff2dd, 2.6);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.near = 0.5;
sun.shadow.camera.far = 60;
sun.shadow.camera.left = -8; sun.shadow.camera.right = 8;
sun.shadow.camera.top = 8; sun.shadow.camera.bottom = -8;
sun.shadow.bias = -0.0004;
sun.shadow.normalBias = 0.03;
scene.add(sun, sun.target);
const SUN_DIR = new THREE.Vector3(0.45, 1.0, 0.30).normalize();

/* ---------------- 加载 ---------------- */
const manager = new THREE.LoadingManager();
const bar = document.getElementById('bar'), pct = document.getElementById('pct');
// 字节级进度：scene.glb ≈12MB，cat.glb ≈5.3MB
const FILE_W = [0.72, 0.28];
const fileProg = [0, 0];
function setProgress(idx, p) {
  fileProg[idx] = p;
  const total = FILE_W[0] * fileProg[0] + FILE_W[1] * fileProg[1];
  bar.style.width = Math.round(total * 100) + '%';
  pct.textContent = Math.round(total * 100) + '%';
}
const loader = new GLTFLoader(manager);
const dracoLoader = new DRACOLoader();
dracoLoader.setDecoderPath('./vendor/draco/');
loader.setDRACOLoader(dracoLoader);   // 模型已用 KHR_draco_mesh_compression 压缩

const worldRoot = new THREE.Group();   // 场景（已缩放）
scene.add(worldRoot);
let sceneMeshes = [];                  // 碰撞/射线候选
const raycaster = new THREE.Raycaster();

function setShadow(o, cast, receive) {
  o.traverse(n => {
    if (n.isMesh) { n.castShadow = cast; n.receiveShadow = receive; }
  });
}

const loadP = (url, onBytes) => new Promise((res, rej) =>
  loader.load(url, res, xhr => { if (onBytes && xhr.total) onBytes(xhr.loaded / xhr.total); }, rej));
const loadingEl = document.getElementById('loading');

async function boot() {
  window.__bootStage = 'start';
  // 场景
  const sceneGltf = await loadP('./data/scene.glb', p => setProgress(0, p));
  window.__bootStage = 'scene-loaded';
  const sceneModel = sceneGltf.scene;
  sceneModel.scale.setScalar(CFG.sceneScale);
  setShadow(sceneModel, true, true);
  worldRoot.add(sceneModel);
  sceneModel.updateMatrixWorld(true);
  sceneMeshes = [];
  sceneModel.traverse(n => { if (n.isMesh) sceneMeshes.push(n); });

  // 猫
  const catGltf = await loadP('./data/cat.glb', p => setProgress(1, p));
  window.__bootStage = 'cat-loaded';
  const cat = catGltf.scene;
  setShadow(cat, true, true);
  cat.traverse(n => { if (n.isSkinnedMesh) n.frustumCulled = false; });

  initCat(catGltf);
  window.__bootStage = 'finding-spawn';
  const spawn = findSpawn();
  window.__bootStage = 'spawn-found';
  spawnPoint.copy(spawn);
  placeCat(spawn);
  setCameraBehind();
  snapCamera();
  window.__bootStage = 'placed';

  loadingEl.classList.add('hide');
  setTimeout(() => loadingEl.remove(), 700);
  clock.start();
  renderer.setAnimationLoop(tick);
  window.__bootStage = 'running';
}

/* ---------------- 猫：动画 / 状态机 / 待机摆动 ---------------- */
const player = new THREE.Group();      // 控制层：位置 + 朝向
const modelWrap = new THREE.Group();   // 模型层：缩放 + 贴地偏移
player.add(modelWrap);
scene.add(player);

let mixer, actWalk, actRun;
let state = 'idle';                    // idle | walk | run（静止=完全静止站姿）
let speed = 0, heading = 0, vy = 0, grounded = true;
let groundY = 0;

function initCat(catGltf) {
  modelWrap.scale.setScalar(CFG.catScale);
  modelWrap.add(catGltf.scene);

  mixer = new THREE.AnimationMixer(catGltf.scene);
  const walkClip = THREE.AnimationClip.findByName(catGltf.animations, 'Walk');
  const runClip = THREE.AnimationClip.findByName(catGltf.animations, 'Run');
  actWalk = mixer.clipAction(walkClip); actWalk.play();
  actRun = mixer.clipAction(runClip); actRun.play();
  actWalk.setEffectiveWeight(0);
  actRun.setEffectiveWeight(0);
}

function setAnimState(s) {
  if (s === state) return;
  state = s;
  const st = { idle: '站立', walk: '走路', run: '奔跑' }[s];
  document.getElementById('stateText').textContent = s === 'idle' ? '站立' : st;
  document.getElementById('stateDot').style.background =
    { idle: '#9fe6a0', walk: '#ffd97a', run: '#ff9f7a' }[s];
}

/* ---------------- 碰撞 / 地面 ---------------- */
function groundAt(x, z, fromY = 8) {
  raycaster.set(new THREE.Vector3(x, fromY, z), new THREE.Vector3(0, -1, 0));
  raycaster.far = 60;
  const hits = raycaster.intersectObjects(sceneMeshes, false);
  if (hits.length) return { y: hits[0].point.y, n: hits[0].face.normal.clone().transformDirection(hits[0].object.matrixWorld) };
  return null;
}
function wallRay(origin, dir, far) {
  raycaster.set(origin, dir);
  raycaster.far = far;
  return raycaster.intersectObjects(sceneMeshes, false)[0] || null;
}

function findSpawn() {
  // 网格采样：朝上法线 + 周围 1.2m 开阔（避开池子/岩壁）；中央区域里选最高的地面（池底低于铺装）
  const box = new THREE.Box3().setFromObject(worldRoot);
  const cx = (box.min.x + box.max.x) / 2, cz = (box.min.z + box.max.z) / 2;
  const sx = (box.max.x - box.min.x) / 2, sz = (box.max.z - box.min.z) / 2;
  const cands = [];
  // 第一步：全场景地面射线 + 高度分桶投票，票数最多的层级 = 主体步行面（铺装）
  //（池底/树冠/花盆顶都是少数派，直接排除）
  const groundHits = [];
  for (let gx = -6; gx <= 6; gx++) for (let gz = -6; gz <= 6; gz++) {
    const x = cx + gx * sx * 0.08, z = cz + gz * sz * 0.08;
    const g = groundAt(x, z, Math.min(box.max.y + 2, 20));
    if (!g || g.n.y < 0.8) continue;
    groundHits.push({ x, z, y: g.y, dist: Math.hypot(x - cx, z - cz) });
  }
  if (!groundHits.length) return new THREE.Vector3(cx, box.max.y, cz);
  const buckets = new Map();
  for (const c of groundHits) {
    const k = Math.round(c.y / 0.15);
    buckets.set(k, (buckets.get(k) || 0) + 1);
  }
  let topK = 0, topN = -1;
  for (const [k, n] of buckets) if (n > topN || (n === topN && k > topK)) { topN = n; topK = k; }
  // 第二步：只在主层级里做开阔检查，取离中心最近的开阔点
  const level = groundHits.filter(c => Math.round(c.y / 0.15) === topK)
    .sort((a, b) => a.dist - b.dist);
  for (const c of level) {
    let open = true;
    for (let a = 0; a < 8; a++) {
      const d = new THREE.Vector3(Math.cos(a * Math.PI / 4), 0, Math.sin(a * Math.PI / 4));
      if (wallRay(new THREE.Vector3(c.x, c.y + 0.25, c.z), d, 1.2)) { open = false; break; }
    }
    if (open) return new THREE.Vector3(c.x, c.y, c.z);
  }
  return new THREE.Vector3(level[0].x, level[0].y, level[0].z);
}

/* ---------------- 输入 ---------------- */
const keys = Object.create(null);
addEventListener('keydown', e => {
  keys[e.code] = true;
  if (e.code === 'Space') e.preventDefault();
  if (e.code === 'KeyR') placeCat(spawnPoint);
  if (e.code === 'KeyH') toggleSettings();
});
addEventListener('keyup', e => { keys[e.code] = false; });

let camYaw = Math.PI, camPitch = 0.38, camDist = CFG.camDist;
let dragging = false, lastX = 0, lastY = 0;
canvas.addEventListener('pointerdown', e => {
  dragging = true; lastX = e.clientX; lastY = e.clientY;
  canvas.classList.add('dragging');
});
addEventListener('pointermove', e => {
  if (!dragging) return;
  camYaw -= (e.clientX - lastX) * 0.005;
  camPitch = THREE.MathUtils.clamp(camPitch + (e.clientY - lastY) * 0.005, -0.12, 1.25);
  lastX = e.clientX; lastY = e.clientY;
});
addEventListener('pointerup', () => { dragging = false; canvas.classList.remove('dragging'); });
addEventListener('wheel', e => {
  camDist = THREE.MathUtils.clamp(camDist * Math.exp(e.deltaY * 0.001), CFG.camMin, CFG.camMax);
  window.__syncSliders && window.__syncSliders();
}, { passive: true });

function moveInput() {
  const f = (keys.KeyW || keys.ArrowUp ? 1 : 0) - (keys.KeyS || keys.ArrowDown ? 1 : 0);
  const r = (keys.KeyD || keys.ArrowRight ? 1 : 0) - (keys.KeyA || keys.ArrowLeft ? 1 : 0);
  if (!f && !r) return null;
  // 相机系前/右（yaw=0 时相机在 +Z 看向 -Z）
  const fx = -Math.sin(camYaw), fz = -Math.cos(camYaw);
  const rx = -fz, rz = fx;
  const dir = new THREE.Vector3(fx * f + rx * r, 0, fz * f + rz * r).normalize();
  return dir;
}

/* ---------------- H 设置面板 ---------------- */
const SETTINGS = [
  { key: 'walkSpeed', label: '走路速度', min: 0.05, max: 1.2, step: 0.01,  fmt: v => v.toFixed(2) + 'm/s' },
  { key: 'runSpeed',  label: '疾跑速度', min: 0.2,  max: 3.5, step: 0.05,  fmt: v => v.toFixed(2) + 'm/s' },
  { key: 'liftY',     label: '高度偏移', min: -0.05, max: 0.20, step: 0.005, fmt: v => (v * 100).toFixed(1) + 'cm' },
  { key: 'jumpV',     label: '跳起高度', min: 0.4,  max: 4,   step: 0.1,   fmt: v => (v * v / (2 * CFG.gravity)).toFixed(2) + 'm' },
  { key: 'gravity',   label: '重力',     min: 2,   max: 15,  step: 0.5,   fmt: v => v.toFixed(1) },
  { key: 'turnRate',  label: '转向速度', min: 2,   max: 20,  step: 0.5,   fmt: v => v.toFixed(1) },
  { key: 'camDist',   label: '相机距离', min: 1.5, max: 9,   step: 0.1,   fmt: v => v.toFixed(1) + 'm' },
];
const CFG_DEFAULTS = { walkSpeed: 0.25, runSpeed: 1.4, liftY: 0.02, jumpV: 1.9, gravity: 7.5, turnRate: 9.0, camDist: 3.4 };
const CFG_STORE_KEY = 'catgame-cfg-v2';

// 恢复上次调整（localStorage 记忆）
try {
  const saved = JSON.parse(localStorage.getItem(CFG_STORE_KEY) || '{}');
  for (const s of SETTINGS) {
    if (typeof saved[s.key] === 'number') {
      const v = THREE.MathUtils.clamp(saved[s.key], s.min, s.max);
      if (s.key === 'camDist') camDist = v; else CFG[s.key] = v;
    }
  }
} catch (e) { /* 坏数据忽略 */ }

function saveSettings() {
  const out = {};
  for (const s of SETTINGS) out[s.key] = (s.key === 'camDist') ? camDist : CFG[s.key];
  try { localStorage.setItem(CFG_STORE_KEY, JSON.stringify(out)); } catch (e) {}
}

const settingsEl = document.getElementById('settings');
const rowsEl = document.getElementById('settingsRows');
const rowRefs = [];
function sliderVal(key) { return key === 'camDist' ? camDist : CFG[key]; }
for (const s of SETTINGS) {
  const row = document.createElement('div');
  row.className = 'row';
  const lbl = document.createElement('span');
  lbl.className = 'lbl'; lbl.textContent = s.label;
  const input = document.createElement('input');
  input.type = 'range'; input.min = s.min; input.max = s.max; input.step = s.step;
  input.value = sliderVal(s.key);
  const val = document.createElement('span');
  val.className = 'val'; val.textContent = s.fmt(input.valueAsNumber);
  input.addEventListener('input', () => {
    const v = input.valueAsNumber;
    if (s.key === 'camDist') camDist = v; else CFG[s.key] = v;
    for (const r of rowRefs) r.val.textContent = r.s.fmt(sliderVal(r.s.key));
    saveSettings();
  });
  input.addEventListener('change', () => input.blur()); // 松手归还键盘焦点，方向键留给移动
  row.append(lbl, input, val);
  rowsEl.append(row);
  rowRefs.push({ s, input, val });
}
window.__syncSliders = () => {
  for (const { s, input, val } of rowRefs) {
    input.value = sliderVal(s.key);
    val.textContent = s.fmt(sliderVal(s.key));
  }
};
document.getElementById('cfgReset').addEventListener('click', () => {
  for (const { s, input, val } of rowRefs) {
    const v = CFG_DEFAULTS[s.key];
    if (s.key === 'camDist') camDist = v; else CFG[s.key] = v;
    input.value = v; val.textContent = s.fmt(v);
  }
  saveSettings();
});
function toggleSettings() { settingsEl.classList.toggle('open'); }

/* ---------------- 控制器 ---------------- */
let spawnPoint = new THREE.Vector3(0, 0, 0);

function placeCat(p) {
  player.position.set(p.x, p.y, p.z);
  const g = groundAt(p.x, p.z, p.y + 2);
  player.position.y = (g ? g.y : p.y);
  groundY = player.position.y;
  vy = 0; grounded = true; speed = 0; heading = player.rotation.y;
}

function updateCat(dt) {
  modelWrap.position.y = CFG.liftY;   // 高度偏移（修穿模）
  const dir = moveInput();
  const wantRun = (keys.ShiftLeft || keys.ShiftRight) && dir;
  const target = !dir ? 0 : wantRun ? CFG.runSpeed : CFG.walkSpeed;
  // 输入日志（调试用：置 window.__DBG = true 开启）
  if (window.__DBG) {
    (window.__inputLog = window.__inputLog || []).push({
      t: +swayT.toFixed(2), camYaw: +camYaw.toFixed(2),
      keys: Object.keys(keys).filter(k => keys[k]), dir: dir && [+dir.x.toFixed(2), +dir.z.toFixed(2)],
      speed: +speed.toFixed(3), target: +target.toFixed(3), state,
    });
    if (window.__inputLog.length > 240) window.__inputLog.splice(0, 120);
  }
  const acc = target > speed ? 4.2 : 6.5;
  speed = THREE.MathUtils.damp(speed, target, acc, dt);

  // 跳跃
  if (keys.Space && grounded) { vy = CFG.jumpV; grounded = false; }

  // 朝向 + 前进（先转身再走，转弯半径自然）
  if (dir) {
    const th = Math.atan2(dir.x, dir.z);
    let d = th - heading;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    heading += d * Math.min(1, CFG.turnRate * dt / Math.max(0.15, Math.abs(d) * 0.2));
  }
  player.rotation.y = heading;

  const fwd = new THREE.Vector3(Math.sin(heading), 0, Math.cos(heading));
  const step = fwd.clone().multiplyScalar(speed * dt);

  // 墙面碰撞：两个高度射线 + 贴墙滑移
  if (step.lengthSq() > 0) {
    const dirN = step.clone().normalize();
    let allowed = step.length();
    let wallN = null;
    for (const h of [0.10, 0.32]) {
      const o = player.position.clone().add(new THREE.Vector3(0, h, 0));
      const hit = wallRay(o, dirN, allowed + CFG.catRadius);
      if (hit && hit.distance - CFG.catRadius < allowed) {
        allowed = Math.max(0, hit.distance - CFG.catRadius);
        wallN = hit.face.normal.clone().transformDirection(hit.object.matrixWorld);
        wallN.y = 0; wallN.normalize();
      }
    }
    player.position.addScaledVector(dirN, allowed);
    if (wallN && allowed < step.length() - 1e-4) {
      const slide = dirN.clone().addScaledVector(wallN, -dirN.dot(wallN));
      player.position.addScaledVector(slide, (step.length() - allowed) * 0.85);
    }
  }

  // 地面 / 重力
  const g = groundAt(player.position.x, player.position.z, player.position.y + 1.2);
  if (g) groundY = g.y;
  if (!grounded) {
    vy -= CFG.gravity * dt;
    player.position.y += vy * dt;
    if (player.position.y <= groundY) {
      player.position.y = groundY;
      vy = 0; grounded = true;
    }
  } else {
    player.position.y = THREE.MathUtils.damp(player.position.y, groundY, 14, dt);
    if (player.position.y < groundY - 1.5) { player.position.y = groundY; } // 跌落保护
  }

  // 状态
  if (!dir && speed < 0.02) setAnimState('idle');
  else setAnimState(!grounded ? state : (speed > 0.45 ? 'run' : 'walk'));

  // 动画混合 + 无滑步 timeScale
  const wWalk = state === 'walk' ? 1 : 0;
  const wRun = state === 'run' ? 1 : 0;
  actWalk.setEffectiveWeight(THREE.MathUtils.damp(actWalk.getEffectiveWeight(), wWalk, 9, dt));
  actRun.setEffectiveWeight(THREE.MathUtils.damp(actRun.getEffectiveWeight(), wRun, 9, dt));
  actWalk.timeScale = speed > 0.01 ? speed / CFG.nativeWalk : actWalk.timeScale;
  actRun.timeScale = speed > 0.01 ? speed / CFG.nativeRun : actRun.timeScale;
}

/* ---------------- 相机 ---------------- */
const camTarget = new THREE.Vector3();
function setCameraBehind() { camYaw = Math.PI; }
function camOffsetDir() {
  return new THREE.Vector3(
    Math.sin(camYaw) * Math.cos(camPitch),
    Math.sin(camPitch) + 0.18,
    Math.cos(camYaw) * Math.cos(camPitch)
  ).normalize();
}
function snapCamera() {
  // 开局直接把相机放到目标位，避免从原点飞过来
  const focus = player.position.clone().add(new THREE.Vector3(0, 0.34, 0));
  camTarget.copy(focus);
  camera.position.copy(camTarget).addScaledVector(camOffsetDir(), camDist);
  camera.lookAt(camTarget);
}
function updateCamera(dt) {
  const focus = player.position.clone().add(new THREE.Vector3(0, 0.34, 0));
  camTarget.lerp(focus, 1 - Math.exp(-10 * dt));

  const offDir = camOffsetDir();

  // 相机入墙回拉
  const hit = wallRay(camTarget, offDir, camDist + 0.3);
  let d = camDist;
  if (hit) d = Math.max(0.6, hit.distance - 0.2);

  let desired = camTarget.clone().addScaledVector(offDir, d);
  // 相机贴地（正常地面）/ 进墙拉近（高墙顶部不算地面）
  const cg = groundAt(desired.x, desired.z, desired.y + 4);
  if (cg && desired.y < cg.y + 0.22) {
    if (cg.y <= groundY + 0.5) {
      desired.y = cg.y + 0.22;
    } else {
      d = Math.max(0.45, d * 0.5);
      desired = camTarget.clone().addScaledVector(offDir, d);
    }
  }

  camera.position.lerp(desired, 1 - Math.exp(-9 * dt));
  camera.lookAt(camTarget);
}

/* ---------------- 主循环 ---------------- */
const clock = new THREE.Clock(false);
let swayT = 0;
function tick() {
  const dt = Math.min(clock.getDelta(), 0.05);
  swayT += dt;

  // 调试：window.__scrub = { time: 秒 } 冻结输入，直接摆 Run 姿态（逐相检查用）
  const scrub = window.__scrub;
  if (scrub && actRun && actWalk) {
    actRun.paused = true; actWalk.paused = true;
    actRun.setEffectiveWeight(1); actWalk.setEffectiveWeight(0);
    actRun.time = scrub.time % actRun.getClip().duration;
  } else {
    updateCat(dt);
  }
  mixer.update(dt);
  updateCamera(dt);

  // 太阳阴影跟随
  sun.position.copy(player.position).addScaledVector(SUN_DIR, 22);
  sun.target.position.copy(player.position);
  sun.target.updateMatrixWorld();

  renderer.render(scene, camera);

  // 调试句柄
  window.__game = {
    pos: player.position.toArray().map(v => +v.toFixed(2)),
    heading: +heading.toFixed(2),
    speed: +speed.toFixed(2),
    groundY: +groundY.toFixed(2),
    grounded, state,
    cam: camera.position.toArray().map(v => +v.toFixed(2)),
    camDistActual: +camera.position.distanceTo(camTarget).toFixed(2),
    spawn: spawnPoint.toArray().map(v => +v.toFixed(2)),
    meshes: sceneMeshes.map(m => m.name),
    runTime: +actRun.time.toFixed(3),
    runW: +actRun.getEffectiveWeight().toFixed(2),
    runPaused: actRun.paused,
    scrub: window.__scrub || null,
  };
}

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

boot().catch(err => {
  console.error(err);
  window.__bootErr = (err && (err.stack || err.message)) || String(err);
  if (pct) pct.textContent = '加载失败：' + err.message;
});
