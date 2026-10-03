import { FilesetResolver, FaceLandmarker, ImageSegmenter } from './vendor/vision_bundle.mjs';
import { sampleFrame, sampleHair, combine, classify, hexToRgb } from './color.js';
import { TYPES } from './palettes.js';
import { MAIL_ENDPOINT, MAIL_KEY } from './config.js';

const $ = (id) => document.getElementById(id);
const HOLD_MS = 3000;      // 조건이 모두 맞은 뒤 3·2·1 카운트다운 시간
const STEP_MS = 650;       // 체크리스트 한 단계 최소 노출 시간
const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));

let fileset, videoLM, imageLM, segmenter;
let stream = null, state = 'start';

// ---------- 화면 전환 ----------
function show(id) {
  document.querySelectorAll('.screen').forEach((s) => s.classList.toggle('active', s.id === id));
  state = id;
  $(id).scrollTop = 0;
}
function toast(msg, ms = 1800) {
  const t = $('toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove('show'), ms);
}
function showError(msg) { const e = $('startError'); e.textContent = msg; e.hidden = false; }
function goHome() { stopCamera(); $('modal').hidden = true; show('start'); }
document.querySelectorAll('.home').forEach((b) => (b.onclick = goHome));

// 시작 화면: 8가지 타입 컬러가 도는 궤도
$('orbitRing').innerHTML = Object.values(TYPES).map((t, i) =>
  `<i style="transform:rotate(${i * 45}deg) translateY(calc(-1 * var(--r))) rotate(${-i * 45}deg);background:linear-gradient(135deg,${t.best[1][1]} 50%,${t.best[7][1]} 50%)"></i>`).join('');

// ---------- 모델 준비 ----------
const abs = (p) => new URL(p, location.href).href;
async function createLM(mode) {
  const opts = (delegate) => ({
    baseOptions: { modelAssetPath: abs('./models/face_landmarker.task'), delegate },
    runningMode: mode, numFaces: 1,
  });
  try { return await FaceLandmarker.createFromOptions(fileset, opts('GPU')); }
  catch { return await FaceLandmarker.createFromOptions(fileset, opts('CPU')); }
}
async function loadModels() {
  fileset = await FilesetResolver.forVisionTasks(abs('./vendor/wasm'));
  videoLM = await createLM('VIDEO');
}
async function ensureImageModels() {
  imageLM ??= await createLM('IMAGE');
  segmenter ??= await ImageSegmenter.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: abs('./models/selfie_multiclass.tflite'), delegate: 'CPU' },
    runningMode: 'IMAGE', outputCategoryMask: true, outputConfidenceMasks: true,
  });
}

loadModels().then(() => {
  $('btnStart').disabled = false; $('btnStart').textContent = '진단하기';
  ensureImageModels(); // 백그라운드에서 미리 준비
}).catch((e) => {
  console.error(e);
  $('btnStart').textContent = '준비 실패';
  showError('분석 도구를 불러오지 못했어요. 페이지를 새로고침해 주세요.');
});

// ---------- 답변 (화장 상태는 촬영 전, 머리·렌즈는 분석 중) ----------
let answers = { makeup: 'base', hair: 'natural', lens: 'no' };
function resetWaitAnswers() {
  answers.hair = 'natural'; answers.lens = 'no';
  document.querySelectorAll('.pills').forEach((g) => g.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.v === answers[g.dataset.key])));
}
document.querySelectorAll('.pills').forEach((g) => g.querySelectorAll('button').forEach((b) => (b.onclick = () => {
  answers[g.dataset.key] = b.dataset.v;
  g.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
})));

// 촬영 전 얼굴 상태 팝업
let nextAction = null;
function askMakeup(action) {
  $('startError').hidden = true;
  nextAction = action;
  $('modal').hidden = false;
}
$('modal').querySelectorAll('.opts button').forEach((b) => (b.onclick = () => {
  answers.makeup = b.dataset.v;
  $('modal').hidden = true;
  nextAction?.();
}));
$('modalCancel').onclick = () => { $('modal').hidden = true; };
$('modal').onclick = (e) => { if (e.target === $('modal')) $('modal').hidden = true; };

$('btnStart').onclick = () => askMakeup(startCamera);

// ---------- 카메라 ----------
const video = $('video'), overlay = $('overlay'), octx = overlay.getContext('2d');
const work = document.createElement('canvas'), wctx = work.getContext('2d', { willReadFrequently: true });
const checkEls = Object.fromEntries([...document.querySelectorAll('#checks li')].map((li) => [li.dataset.k, li]));
let lastT = -1, holdStart = null, frames = [], lastMsg = '', lastCount = '';

async function startCamera() {
  if (!navigator.mediaDevices?.getUserMedia) {
    showError('이 주소에서는 카메라를 켤 수 없어요. https 주소로 접속해 주세요.');
    return;
  }
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'user', width: { ideal: 1920 }, height: { ideal: 1440 } }, audio: false,
    });
  } catch {
    showError('카메라 권한이 필요해요. 설정 > Safari > 카메라에서 허용해 주세요.');
    return;
  }
  video.srcObject = stream;
  await video.play();
  work.width = video.videoWidth; work.height = video.videoHeight;
  holdStart = null; frames = []; lastT = -1; lastMsg = ''; setCount('');
  show('camera');
  requestAnimationFrame(tick);
}

function stopCamera() { stream?.getTracks().forEach((t) => t.stop()); stream = null; }

function layout() {
  const cw = overlay.clientWidth, ch = overlay.clientHeight, dpr = devicePixelRatio || 1;
  if (overlay.width !== Math.round(cw * dpr) || overlay.height !== Math.round(ch * dpr)) {
    overlay.width = Math.round(cw * dpr); overlay.height = Math.round(ch * dpr);
  }
  const vw = video.videoWidth, vh = video.videoHeight;
  const s = Math.max(cw / vw, ch / vh);
  const ry = Math.min(ch * 0.27, cw * 0.36), rx = ry * 0.76;
  return { cw, ch, dpr, s, ox: (cw - vw * s) / 2, oy: (ch - vh * s) / 2, cx: cw / 2, cy: ch * 0.5, rx, ry };
}

function tick() {
  if (state !== 'camera' || !stream) return;
  if (video.readyState >= 2 && video.currentTime !== lastT) {
    lastT = video.currentTime;
    const r = videoLM.detectForVideo(video, performance.now());
    evaluate(r.faceLandmarks?.[0]);
  }
  requestAnimationFrame(tick);
}

function evaluate(lm) {
  const g = layout();
  const D = (i) => [g.cw - (g.ox + lm[i].x * video.videoWidth * g.s), g.oy + lm[i].y * video.videoHeight * g.s];
  const c = { face: false, dist: false, pos: false, front: false, level: false, light: false };
  let msg = '얼굴을 원 안에 맞춰주세요', f = null;

  if (lm) {
    c.face = true;
    const top = D(10), chin = D(152), l = D(234), r = D(454), nose = D(1), e1 = D(33), e2 = D(263);
    const fx = (top[0] + chin[0]) / 2, fy = (top[1] + chin[1]) / 2;
    const size = Math.hypot(chin[0] - top[0], chin[1] - top[1]) / (2 * g.ry);
    const yaw = (nose[0] - (l[0] + r[0]) / 2) / Math.abs(r[0] - l[0]);
    const roll = Math.abs(Math.atan2(e2[1] - e1[1], e2[0] - e1[0]) * 180 / Math.PI);
    // 얼굴이 영상에서 너무 작으면 눈동자·피부 픽셀이 부족 → 최소 크기는 실제 픽셀 기준으로 확인
    const facePx = Math.hypot((lm[454].x - lm[234].x) * video.videoWidth, (lm[454].y - lm[234].y) * video.videoHeight);
    const tooFar = size < 0.45 || facePx < 160, tooClose = size > 1.15;
    c.dist = !tooFar && !tooClose;
    c.pos = Math.abs(fx - g.cx) <= g.rx * 0.5 && Math.abs(fy - g.cy) <= g.ry * 0.4;
    c.front = Math.abs(yaw) <= 0.2;
    c.level = Math.min(roll, 180 - roll) <= 14;

    // 이 프레임의 색 수집 (밝기 확인 겸)
    wctx.drawImage(video, 0, 0, work.width, work.height);
    const W = work.width, H = work.height;
    const xs = lm.map((p) => p.x * W), ys = lm.map((p) => p.y * H);
    const pad = (Math.max(...xs) - Math.min(...xs)) * 0.1;
    const x0 = Math.max(0, Math.floor(Math.min(...xs) - pad)), y0 = Math.max(0, Math.floor(Math.min(...ys) - pad));
    const x1 = Math.min(W, Math.ceil(Math.max(...xs) + pad)), y1 = Math.min(H, Math.ceil(Math.max(...ys) + pad));
    if (x1 > x0 && y1 > y0) {
      const id = wctx.getImageData(x0, y0, x1 - x0, y1 - y0);
      f = sampleFrame({ data: id.data, width: id.width, height: id.height, ox: x0, oy: y0 }, lm, W, H);
      c.light = f.skinL >= 32;
    }

    if (tooFar) msg = '조금 더 가까이 와주세요';
    else if (tooClose) msg = '조금만 뒤로 가주세요';
    else if (!c.pos) msg = '얼굴을 원 가운데로 맞춰주세요';
    else if (!c.front) msg = '정면을 바라봐 주세요';
    else if (!c.level) msg = '고개를 똑바로 세워주세요';
    else if (!c.light) msg = '조금 더 밝은 곳에서 해주세요';
  }
  const ok = Object.values(c).every(Boolean);
  for (const k in c) checkEls[k].classList.toggle('on', c[k]);

  if (ok) {
    if (holdStart == null) { holdStart = performance.now(); frames = []; }
    frames.push(f);
    msg = '좋아요, 그대로 유지해 주세요';
  } else { holdStart = null; frames = []; }

  const elapsed = holdStart ? performance.now() - holdStart : 0;
  setCount(holdStart ? String(Math.max(1, Math.ceil((HOLD_MS - elapsed) / 1000))) : '');
  drawOverlay(g, ok, Math.min(1, elapsed / HOLD_MS));
  if (msg !== lastMsg) { const t = $('guideText'); t.textContent = msg; t.classList.toggle('ok', ok); lastMsg = msg; }
  if (elapsed >= HOLD_MS && frames.length >= 8) capture(lm);
}

function setCount(n) {
  if (n === lastCount) return;
  lastCount = n;
  const el = $('count');
  el.textContent = n;
  el.classList.remove('pop'); void el.offsetWidth; if (n) el.classList.add('pop');
}

function drawOverlay(g, ok, p) {
  const c = octx;
  c.setTransform(g.dpr, 0, 0, g.dpr, 0, 0);
  c.clearRect(0, 0, g.cw, g.ch);
  c.fillStyle = 'rgba(14,16,30,.38)';
  c.beginPath(); c.rect(0, 0, g.cw, g.ch); c.ellipse(g.cx, g.cy, g.rx, g.ry, 0, 0, Math.PI * 2, true); c.fill();

  const col = ok ? '#7FE3C0' : 'rgba(255,255,255,.9)';
  c.lineWidth = 3; c.strokeStyle = col;
  c.beginPath(); c.ellipse(g.cx, g.cy, g.rx, g.ry, 0, 0, Math.PI * 2); c.stroke();

  // 모서리 브래킷
  const bx = g.rx * 1.45, by = g.ry * 1.18, L = Math.min(g.rx, g.ry) * 0.28;
  c.lineWidth = 4; c.lineCap = 'square';
  for (const [sx, sy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
    const x = g.cx + sx * bx, y = g.cy + sy * by;
    c.beginPath(); c.moveTo(x - sx * L, y); c.lineTo(x, y); c.lineTo(x, y - sy * L); c.stroke();
  }
  if (p > 0) {
    c.lineWidth = 6; c.lineCap = 'round'; c.strokeStyle = '#7FE3C0';
    c.beginPath(); c.ellipse(g.cx, g.cy, g.rx + 10, g.ry + 10, 0, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * p); c.stroke();
  }
}

function capture(lm) {
  const shot = document.createElement('canvas');
  shot.width = work.width; shot.height = work.height;
  shot.getContext('2d').drawImage(work, 0, 0);
  const fr = frames; frames = []; holdStart = null;
  stopCamera(); setCount('');
  const fl = $('flash'); fl.classList.remove('on'); void fl.offsetWidth; fl.classList.add('on');
  setTimeout(() => analyze(shot, lm, fr), 280);
}

// ---------- 분석 ----------
async function analyze(shot, lm, fr) {
  const W = shot.width, H = shot.height;
  const snap = $('snapshot');
  snap.width = 960; snap.height = Math.round((960 * H) / W);
  drawCrop(snap, shot, { x: 0, y: 0, w: W, h: H }, null);
  $('anTitle').textContent = '색을 읽는 중입니다';
  $('anSub').textContent = fr.length > 1 ? `연속 촬영 ${fr.length}프레임을 합치는 중…` : '사진 1장을 분석하는 중…';
  document.querySelector('.shot').classList.remove('done');
  const items = [...document.querySelectorAll('#checklist li')];
  const mark = (i) => items.forEach((li, k) => { li.classList.toggle('done', k < i); li.classList.toggle('now', k === i); });
  const btn = $('btnShowResult');
  btn.disabled = true; btn.textContent = '분석 중…'; btn.onclick = null;
  resetWaitAnswers();
  mark(0);
  show('analyzing');

  await sleep(STEP_MS);
  mark(1);
  await sleep(60);
  await ensureImageModels();

  const t1 = performance.now();
  const full = shot.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, W, H);
  let cat, hairConf, bgConf, mw, mh;
  segmenter.segment(shot, (res) => {
    mw = res.categoryMask.width; mh = res.categoryMask.height;
    cat = res.categoryMask.getAsUint8Array().slice();
    bgConf = res.confidenceMasks[0].getAsFloat32Array().slice();
    hairConf = res.confidenceMasks[1].getAsFloat32Array().slice();
  });
  const hair = sampleHair({ data: full.data, width: W, height: H, ox: 0, oy: 0 }, cat, hairConf, mw, mh, lm, W, H);
  const combined = combine(fr, hair);
  if (!combined) {
    show('start');
    return showError('피부 톤을 읽지 못했어요. 얼굴을 가리는 머리카락·손을 치우고 밝은 곳에서 다시 해주세요.');
  }
  await sleep(STEP_MS - (performance.now() - t1));
  mark(2);
  const ctx = { shot, cutout: makeCutout(shot, bgConf, mw, mh), crop: cropRect(lm, W, H, 1.25, 2.6, 0.7), hero: cropRect(lm, W, H, 0.75, 3.4, 0.95) };
  await sleep(STEP_MS);
  mark(3);
  await sleep(STEP_MS);
  mark(4);
  document.querySelector('.shot').classList.add('done');
  $('anTitle').textContent = '분석이 끝났어요';
  $('anSub').textContent = '아래 질문을 확인하고 결과를 열어보세요.';
  btn.disabled = false; btn.textContent = '결과 보기';
  btn.scrollIntoView({ behavior: 'smooth', block: 'end' });
  btn.onclick = () => {
    const opts = { hair: answers.hair, lens: answers.lens === 'yes', makeup: answers.makeup };
    renderResult(classify(combined, opts), ctx);
  };
}

// 얼굴 기준 크롭 영역 (ratio = 높이/너비, scale = 얼굴 너비 배수, top = 이마 위 여백)
function cropRect(lm, W, H, ratio, scale, top) {
  const L = (i) => [lm[i].x * W, lm[i].y * H];
  const fw = Math.hypot(L(454)[0] - L(234)[0], L(454)[1] - L(234)[1]);
  const cx = (L(234)[0] + L(454)[0]) / 2;
  let w = fw * scale, h = w * ratio;
  if (w > W) { w = W; h = w * ratio; }
  if (h > H) { h = H; w = h / ratio; }
  const fit = (v, size, max) => (size <= max ? Math.min(Math.max(v, 0), max - size) : v);
  return { x: fit(cx - w / 2, w, W), y: fit(L(10)[1] - fw * top, h, H), w, h };
}

// 셀카 방향(좌우 반전)으로 크롭해서 그리기
function drawCrop(canvas, src, cr, bg) {
  const c = canvas.getContext('2d');
  c.save();
  c.fillStyle = bg || '#E4E6F2'; c.fillRect(0, 0, canvas.width, canvas.height);
  c.translate(canvas.width, 0); c.scale(-1, 1);
  c.drawImage(src, cr.x, cr.y, cr.w, cr.h, 0, 0, canvas.width, canvas.height);
  c.restore();
}

function makeCutout(shot, bgConf, mw, mh) {
  const m = document.createElement('canvas'); m.width = mw; m.height = mh;
  const mc = m.getContext('2d'), id = mc.createImageData(mw, mh);
  for (let i = 0; i < bgConf.length; i++) id.data[i * 4 + 3] = Math.max(0, Math.min(1, (1 - bgConf[i] - 0.25) / 0.5)) * 255;
  mc.putImageData(id, 0, 0);
  const out = document.createElement('canvas'); out.width = shot.width; out.height = shot.height;
  const oc = out.getContext('2d');
  oc.drawImage(shot, 0, 0);
  oc.globalCompositeOperation = 'destination-in';
  oc.imageSmoothingQuality = 'high';
  oc.drawImage(m, 0, 0, shot.width, shot.height);
  return out;
}

// ---------- 결과 ----------
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const pct = (v) => Math.round(((v + 1) / 2) * 100);

function summary(res) {
  const t = TYPES[res.type], f = res.features;
  return {
    t,
    match: res.ranking[0].pct,
    second: TYPES[res.ranking[1].id],
    tagline: [t.season, `${t.tone}톤`, f.light >= 0 ? '밝음' : '깊음', f.clarity >= 0 ? '선명함' : '부드러움', f.contrast >= 0 ? '고대비' : '저대비'].join(' · '),
    scores: [
      [f.warmth >= 0 ? '웜 지수' : '쿨 지수', Math.round(50 + Math.abs(f.warmth) * 50)],
      ['명도', pct(f.light)],
      ['채도', pct(f.clarity)],
    ],
  };
}

function chip([name, hex]) {
  return `<button class="chip" data-hex="${hex}"><div class="sw" style="background:${hex}"></div>
    <div class="meta"><div class="nm">${esc(name)}</div><code>${hex}</code></div></button>`;
}
function row([name, hex], why) {
  return `<button class="row" data-hex="${hex}"><i style="background:${hex}"></i>
    <span class="nm">${esc(name)}<code>${hex}</code></span>${why ? `<span class="why">${esc(why)}</span>` : ''}</button>`;
}

let lastRender = null, lastCard = null;
function renderResult(res, ctx) {
  const s = summary(res), t = s.t, f = res.features, m = res.measured;
  const bar = (v, l, r, grad) => `<div class="metric"><div class="labels"><span>${l}</span><span>${r}</span></div>
    <div class="track" style="background:${grad}"><span class="knob" style="left:${((v + 1) / 2) * 100}%"></span></div></div>`;
  const meas = (label, hex) => hex ? `<div><i style="background:${hex}"></i><span><small>${label}</small><code>${hex}</code></span></div>` : '';

  $('resultBody').innerHTML = `
    <div class="card res-top">
      <div class="res-photo"><canvas id="heroCanvas" width="1200" height="900"></canvas></div>
      <div class="res-body">
        <p class="tagline">${s.tagline}</p>
        <h1 class="type-name">${t.name}</h1>
        <p class="en"><span class="badge">일치도 ${s.match}%</span><em>${t.en}</em></p>
        <p class="quote">“${t.quote}”</p>
        <div class="scores">${s.scores.map(([k, v]) => `<div><b>${v}</b><small>${k}</small></div>`).join('')}</div>
        <p class="type-desc">${t.desc}</p>
        <div class="hashtags">${t.tags.map((k) => `<span>${k}</span>`).join('')}</div>
        <div class="dots">${t.best.slice(0, 8).map(([, hex]) => `<i style="background:${hex}"></i>`).join('')}</div>
        <p class="second">두 번째로 가까운 타입 · <b>${s.second.name}</b></p>
      </div>
    </div>

    <div class="card">
      <div class="head"><p class="eyebrow">BEST COLORS</p><h2>어울리는 컬러</h2><p class="sub">색을 누르면 색상코드가 복사돼요</p></div>
      <div class="palette">${t.best.map(chip).join('')}</div>
    </div>

    <div class="card">
      <div class="head"><p class="eyebrow">AVOID</p><h2>피하면 좋은 컬러</h2></div>
      <div class="rows">${t.avoid.map((c, i) => row(c, t.avoidWhy[i])).join('')}</div>
    </div>

    <div class="card">
      <div class="head"><p class="eyebrow">PHOTO STUDIO</p><h2>찰떡 배경지로 사진 찍기</h2><p class="sub">${t.name} 얼굴이 가장 맑아 보이는 배경지예요</p></div>
      <div class="backdrops">${t.bdBest.map(([n, hex], i) => `<button class="bd" data-hex="${hex}">
        ${i === 0 ? '<span class="best">BEST</span>' : ''}<canvas id="bd${i}" width="480" height="600"></canvas>
        <div class="meta"><span class="nm">${esc(n)}</span><code>${hex}</code></div></button>`).join('')}</div>
      <p class="mini-title">피해야 할 배경지</p>
      <div class="bd-avoid">${t.bdAvoid.map(([n, hex]) => `<button data-hex="${hex}"><i style="background:${hex}"></i><span>${esc(n)}</span><code>${hex}</code></button>`).join('')}</div>
      <button id="btnToMail" class="btn primary">진단 결과 메일로 받기</button>
    </div>

    <div class="card">
      <div class="head"><p class="eyebrow">LIP · HAIR</p><h2>추천 립 · 헤어 컬러</h2></div>
      <div class="lip-hair">
        <div><p class="mini-title">립</p><div class="rows">${t.lip.map((c) => row(c)).join('')}</div></div>
        <div><p class="mini-title">헤어</p><div class="rows">${t.hair.map((c) => row(c)).join('')}</div></div>
      </div>
    </div>

    <div class="card">
      <div class="head"><p class="eyebrow">RETOUCH GUIDE</p><h2>보정 가이드</h2><p class="sub">라이트룸·포토샵 기준</p></div>
      <div class="retouch">${t.retouch.map(([k, v]) => `<div><b>${k}</b><span>${v}</span></div>`).join('')}</div>
    </div>

    <div class="card">
      <div class="head"><p class="eyebrow">ANALYSIS</p><h2>상세 분석</h2></div>
      <div class="metrics">
        ${bar(-f.warmth, '웜톤', '쿨톤', 'linear-gradient(90deg,#F2B27A,#EEEFF6,#A9B8DE)')}
        ${bar(f.light, '깊은', '밝은', 'linear-gradient(90deg,#3E3A48,#EEEFF6,#FFFFFF)')}
        ${bar(f.clarity, '부드러운', '선명한', 'linear-gradient(90deg,#B4B2BE,#EEEFF6,#FF5A7A)')}
        ${bar(f.contrast, '대비 낮음', '대비 높음', 'linear-gradient(90deg,#D9D9E3,#EEEFF6,#16161D)')}
      </div>
      <div class="measured">${meas('피부', m.skin)}${meas('머리카락', m.hair)}${meas('눈동자', m.iris)}${meas('입술', m.lip)}</div>
    </div>

    <div id="mailCard" class="card mail-card">
      <div class="head"><p class="eyebrow">SEND TO ME</p><h2>진단 결과 메일로 받기</h2><p class="sub">컬러·배경지·립·헤어 추천을 정리해서 보내드려요.</p></div>
      <div class="mail-row">
        <input id="mailTo" type="email" inputmode="email" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="이메일 주소를 입력해 주세요" />
        <button id="btnMail" class="btn primary">보내기</button>
      </div>
      <label class="check"><input id="mailAgree" type="checkbox" /><span>(필수) 결과 발송을 위해 메일 주소를 사용하는 데 동의해요. 메일 주소는 발송에만 쓰고 저장하지 않아요.</span></label>
      <label class="check"><input id="mailPhoto" type="checkbox" checked /><span>결과 이미지에 내 사진 포함하기</span></label>
    </div>

    <div class="actions">
      <button id="btnSave" class="btn ghost">결과 이미지 저장</button>
      <button id="btnRetry" class="btn primary">다음 분 진단하기</button>
    </div>
    <p class="disclaimer">조명과 메이크업에 따라 결과가 달라질 수 있어요. 자연광이나 밝은 흰 조명 아래에서 가장 정확해요.</p>`;

  drawCrop($('heroCanvas'), ctx.shot, ctx.hero, null);
  t.bdBest.forEach(([, hex], i) => drawCrop($('bd' + i), ctx.cutout, ctx.crop, hex));

  $('resultBody').querySelectorAll('[data-hex]').forEach((el) => {
    el.onclick = () => { navigator.clipboard?.writeText(el.dataset.hex).catch(() => {}); toast(`${el.dataset.hex} 복사됨`); };
  });
  $('btnToMail').onclick = () => { $('mailCard').scrollIntoView({ behavior: 'smooth', block: 'center' }); setTimeout(() => $('mailTo').focus(), 400); };
  $('btnMail').onclick = () => sendMail(res, ctx);
  $('btnRetry').onclick = goHome;
  $('btnSave').onclick = () => saveImage(res, ctx);
  lastCard = (photo = true) => buildCard(res, ctx, photo);
  lastRender = res;
  show('result');
}

// ---------- 메일 ----------
async function sendMail(res, ctx) {
  const to = $('mailTo').value.trim();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) { toast('메일 주소를 확인해 주세요'); $('mailTo').focus(); return; }
  if (!$('mailAgree').checked) { toast('메일 주소 사용에 동의해 주세요'); return; }
  const s = summary(res), btn = $('btnMail');
  const card = buildCard(res, ctx, $('mailPhoto').checked);
  const subject = `[아트제이크] 퍼스널컬러 진단 결과 — ${s.t.name}`;

  btn.disabled = true; btn.textContent = '보내는 중…';
  try {
    if (MAIL_ENDPOINT) {
      const image = card.toDataURL('image/jpeg', 0.85).split(',')[1];
      const r = await fetch(MAIL_ENDPOINT, {
        method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({ key: MAIL_KEY, to, subject, html: emailHtml(res), text: emailText(res), image }),
      });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || '발송 실패');
      toast(`메일을 보냈어요 · ${to}`, 2600);
      $('mailTo').value = '';
    } else {
      // 발송 서버 미설정: 아이패드 공유 창 → 메일 앱
      const blob = await new Promise((r) => card.toBlob(r, 'image/jpeg', 0.9));
      const file = new File([blob], `퍼스널컬러_${s.t.name.replace(/\s/g, '')}.jpg`, { type: 'image/jpeg' });
      navigator.clipboard?.writeText(to).catch(() => {});
      if (navigator.canShare?.({ files: [file] })) {
        toast('메일 앱을 골라 주세요 · 받는 주소는 복사해 뒀어요', 3200);
        await navigator.share({ files: [file], title: subject, text: emailText(res) });
      } else {
        location.href = `mailto:${encodeURIComponent(to)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(emailText(res))}`;
      }
    }
  } catch (e) {
    if (e.name !== 'AbortError') { console.error(e); toast('메일을 보내지 못했어요. 잠시 후 다시 시도해 주세요', 2600); }
  } finally {
    btn.disabled = false; btn.textContent = '보내기';
  }
}

function emailText(res) {
  const s = summary(res), t = s.t, list = (a) => a.map(([n, h]) => `${n} ${h}`).join(', ');
  return [
    `아트제이크 퍼스널컬러 진단 결과`,
    ``,
    `${t.name} (${t.en}) · 일치도 ${s.match}%`,
    s.tagline,
    `“${t.quote}”`,
    ``,
    t.desc,
    ``,
    `어울리는 컬러: ${list(t.best)}`,
    `피하면 좋은 컬러: ${list(t.avoid)}`,
    `추천 배경지: ${list(t.bdBest)}`,
    `립: ${list(t.lip)}`,
    `헤어: ${list(t.hair)}`,
  ].join('\n');
}

function emailHtml(res) {
  const s = summary(res), t = s.t;
  const font = "font-family:-apple-system,'Apple SD Gothic Neo','Malgun Gothic',sans-serif;";
  const h2 = (en, ko) => `<p style="margin:32px 0 2px;font:italic 18px Georgia,serif;color:#5A5E78">${en}</p><h2 style="margin:0 0 14px;font-size:20px;color:#16161D">${ko}</h2>`;
  const sw = (list, cols = 4) => {
    const cells = list.map(([n, h]) => `<td width="${Math.floor(100 / cols)}%" style="padding:4px;vertical-align:top">
      <div style="height:56px;border-radius:8px;background:${h};border:1px solid rgba(0,0,0,.06)"></div>
      <div style="font-size:12px;font-weight:700;margin-top:6px;color:#16161D">${esc(n)}</div>
      <div style="font-size:11px;color:#7C7F92;font-family:Menlo,monospace">${h}</div></td>`);
    let rows = '';
    for (let i = 0; i < cells.length; i += cols) rows += `<tr>${cells.slice(i, i + cols).join('')}${'<td></td>'.repeat(Math.max(0, cols - cells.slice(i, i + cols).length))}</tr>`;
    return `<table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse">${rows}</table>`;
  };
  const avoidRows = t.avoid.map(([n, h], i) => `<tr><td style="padding:6px 0;width:36px"><div style="width:28px;height:28px;border-radius:6px;background:${h}"></div></td>
    <td style="padding:6px 8px;font-size:14px;font-weight:700;color:#16161D">${esc(n)} <span style="font-weight:400;color:#7C7F92;font-size:12px;font-family:Menlo,monospace">${h}</span></td>
    <td style="padding:6px 0;font-size:13px;color:#D1435B;text-align:right">${esc(t.avoidWhy[i])}</td></tr>`).join('');
  const retouch = t.retouch.map(([k, v]) => `<tr><td style="padding:8px 0;width:96px;font-size:13px;color:#7C7F92;border-bottom:1px solid #E4E6F2">${k}</td><td style="padding:8px 0;font-size:14px;color:#16161D;border-bottom:1px solid #E4E6F2">${esc(v)}</td></tr>`).join('');

  return `<div style="background:#ECEEF8;padding:24px 12px;${font}">
  <div style="max-width:600px;margin:0 auto;background:#fff;border-radius:16px;padding:32px 28px">
    <p style="margin:0;font-size:13px;font-weight:800;letter-spacing:.04em;color:#16161D">ARTJAKE <span style="font:italic 400 18px Georgia,serif">Color</span></p>
    <p style="margin:28px 0 6px;font-size:13px;color:#7C7F92">${s.tagline}</p>
    <h1 style="margin:0;font-size:34px;letter-spacing:-.02em;color:#16161D">${t.name}</h1>
    <p style="margin:6px 0 0;font:italic 20px Georgia,serif;color:#5A5E78">${t.en} <span style="font:700 12px sans-serif;background:#16161D;color:#fff;padding:3px 8px;border-radius:5px;vertical-align:3px">일치도 ${s.match}%</span></p>
    <p style="margin:14px 0 0;font-size:15px;color:#3C4057">“${t.quote}”</p>
    <table width="100%" style="margin-top:18px;border-collapse:separate;border-spacing:6px 0"><tr>${s.scores.map(([k, v]) => `<td style="background:#F3F4FB;border-radius:10px;padding:12px;text-align:center"><div style="font:28px Georgia,serif;color:#16161D">${v}</div><div style="font-size:12px;color:#7C7F92">${k}</div></td>`).join('')}</tr></table>
    <p style="margin:18px 0 0;font-size:15px;line-height:1.7;color:#3C4057">${t.desc}</p>
    <p style="margin:12px 0 0;font-size:13px;color:#5A5E78">${t.tags.join(' ')}</p>
    <img src="cid:card" alt="${t.name} 진단 결과" width="544" style="display:block;width:100%;height:auto;margin-top:24px;border-radius:12px" />
    ${h2('Best colors', '어울리는 컬러')}${sw(t.best)}
    ${h2('Avoid', '피하면 좋은 컬러')}<table width="100%" cellpadding="0" cellspacing="0">${avoidRows}</table>
    ${h2('Photo studio', '찰떡 배경지')}${sw(t.bdBest, 3)}
    <p style="margin:10px 0 0;font-size:13px;color:#7C7F92">피해야 할 배경지: ${t.bdAvoid.map(([n, h]) => `${esc(n)} ${h}`).join(' · ')}</p>
    ${h2('Lip · Hair', '추천 립 · 헤어 컬러')}${sw([...t.lip, ...t.hair], 3)}
    ${h2('Retouch guide', '보정 가이드')}<table width="100%" cellpadding="0" cellspacing="0">${retouch}</table>
    <p style="margin:32px 0 0;font-size:12px;line-height:1.6;color:#9A9DB0">조명과 메이크업에 따라 결과가 달라질 수 있어요.<br />아트제이크에서 진단받아 주셔서 감사합니다.</p>
  </div></div>`;
}

// ---------- 결과 이미지 ----------
async function saveImage(res, ctx) {
  const s = summary(res);
  const out = buildCard(res, ctx, true);
  const blob = await new Promise((r) => out.toBlob(r, 'image/png'));
  const file = new File([blob], `퍼스널컬러_${s.t.name.replace(/\s/g, '')}.png`, { type: 'image/png' });
  if (navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file], title: s.t.name }); return; } catch (e) { if (e.name === 'AbortError') return; }
  }
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = file.name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  toast('이미지를 저장했어요');
}

function buildCard(res, ctx, photo) {
  const s = summary(res), t = s.t;
  const W = 1080, c = document.createElement('canvas');
  c.width = W; c.height = 2600;
  const x = c.getContext('2d');
  const font = (w, sz, fam = 'Pretendard, -apple-system, sans-serif') => `${w} ${sz}px ${fam}`;
  const serif = "'Instrument Serif', Georgia, serif";

  const L = 100, R = W - 100;
  x.fillStyle = '#16161D'; x.font = font(800, 26); x.textAlign = 'left';
  x.fillText('ARTJAKE', L, 124);
  x.font = `italic 36px ${serif}`; x.fillText('Color', L + 128, 124);

  let y = 170;
  if (photo) {
    const ph = Math.round((R - L) * 0.75);
    const pc = document.createElement('canvas'); pc.width = R - L; pc.height = ph;
    drawCrop(pc, ctx.shot, ctx.hero, null);
    x.save(); roundRect(x, L, y, R - L, ph, 20); x.clip(); x.drawImage(pc, L, y); x.restore();
    y += ph + 70;
  } else y += 30;

  x.fillStyle = '#7C7F92'; x.font = font(500, 26); x.fillText(s.tagline, L, y);
  y += 84; x.fillStyle = '#16161D'; x.font = font(800, 80); x.fillText(t.name, L, y);
  y += 56; x.fillStyle = '#5A5E78'; x.font = `italic 44px ${serif}`; x.fillText(t.en, L, y);
  const enW = x.measureText(t.en).width;
  x.font = font(700, 22); const badge = `일치도 ${s.match}%`, bw = x.measureText(badge).width + 28;
  x.fillStyle = '#16161D'; roundRect(x, L + enW + 20, y - 32, bw, 40, 8); x.fill();
  x.fillStyle = '#fff'; x.fillText(badge, L + enW + 34, y - 4);
  y += 58; x.fillStyle = '#3C4057'; x.font = font(500, 28); x.fillText(`“${t.quote}”`, L, y);

  // 점수 카드
  y += 40;
  const sw3 = (R - L - 32) / 3;
  s.scores.forEach(([k, v], i) => {
    const sx = L + i * (sw3 + 16);
    x.fillStyle = '#F3F4FB'; roundRect(x, sx, y, sw3, 130, 14); x.fill();
    x.textAlign = 'center'; x.fillStyle = '#16161D'; x.font = `56px ${serif}`; x.fillText(String(v), sx + sw3 / 2, y + 72);
    x.fillStyle = '#7C7F92'; x.font = font(600, 22); x.fillText(k, sx + sw3 / 2, y + 108);
  });
  x.textAlign = 'left'; y += 130;

  const title = (en, ko) => {
    y += 76; x.fillStyle = '#5A5E78'; x.font = `italic 30px ${serif}`; x.fillText(en, L, y);
    y += 44; x.fillStyle = '#16161D'; x.font = font(800, 36); x.fillText(ko, L, y); y += 26;
  };
  const swatches = (list, cols) => {
    const gap = 14, cw = (R - L - gap * (cols - 1)) / cols, sh = cw * 0.62;
    list.forEach(([n, hex], i) => {
      const cx = L + (i % cols) * (cw + gap), cy = y + Math.floor(i / cols) * (sh + 70);
      x.fillStyle = hex; roundRect(x, cx, cy, cw, sh, 10); x.fill();
      x.strokeStyle = 'rgba(0,0,0,.07)'; x.lineWidth = 2; x.stroke();
      x.fillStyle = '#16161D'; x.font = font(700, 20); x.fillText(n, cx, cy + sh + 28, cw);
      x.fillStyle = '#7C7F92'; x.font = font(500, 18); x.fillText(hex, cx, cy + sh + 52);
    });
    y += Math.ceil(list.length / cols) * (sh + 70) - 10;
  };

  title('Best colors', '어울리는 컬러');
  swatches(t.best, 6);

  title('Photo studio', '찰떡 배경지');
  const bw3 = (R - L - 28) / 3, bh = bw3 * 1.25;
  t.bdBest.forEach(([n, hex], i) => {
    const bx = L + i * (bw3 + 14);
    if (photo) {
      const b = document.createElement('canvas'); b.width = Math.round(bw3); b.height = Math.round(bh);
      drawCrop(b, ctx.cutout, ctx.crop, hex);
      x.save(); roundRect(x, bx, y, bw3, bh, 14); x.clip(); x.drawImage(b, bx, y, bw3, bh); x.restore();
    } else { x.fillStyle = hex; roundRect(x, bx, y, bw3, bh, 14); x.fill(); }
    if (i === 0) { x.fillStyle = '#16161D'; roundRect(x, bx + 14, y + 14, 84, 34, 6); x.fill(); x.fillStyle = '#fff'; x.font = font(800, 18); x.fillText('BEST', bx + 32, y + 38); }
    x.fillStyle = '#16161D'; x.font = font(700, 22); x.fillText(n, bx, y + bh + 34);
    x.fillStyle = '#7C7F92'; x.font = font(500, 18); x.fillText(hex, bx, y + bh + 60);
  });
  y += bh + 60;

  title('Lip · Hair', '추천 립 · 헤어');
  swatches([...t.lip, ...t.hair], 6);

  // 내용 길이에 맞춰 배경·카드를 깔고 내용을 얹기
  const out = document.createElement('canvas');
  out.width = W; out.height = Math.ceil(y + 110);
  const oc = out.getContext('2d');
  oc.fillStyle = '#ECEEF8'; oc.fillRect(0, 0, W, out.height);
  oc.fillStyle = '#FFFFFF'; roundRect(oc, 48, 48, W - 96, out.height - 96, 28); oc.fill();
  oc.drawImage(c, 0, 0);
  return out;
}

function roundRect(x, l, t, w, h, r) {
  x.beginPath(); x.moveTo(l + r, t); x.arcTo(l + w, t, l + w, t + h, r); x.arcTo(l + w, t + h, l, t + h, r);
  x.arcTo(l, t + h, l, t, r); x.arcTo(l, t, l + w, t, r); x.closePath();
}

window.__pc = { classify, combine, TYPES, get last() { return lastRender; }, card: (p) => lastCard?.(p), emailHtml: () => lastRender && emailHtml(lastRender) };
