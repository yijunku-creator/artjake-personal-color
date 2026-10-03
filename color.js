// 색 계산 + 얼굴 부위 샘플링 + 퍼스널 컬러 분류 (모두 기기 안에서 처리)
import { TYPES } from './palettes.js?v=20261003211257';

// ---------- 색공간 변환 ----------
const toLin = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
const LIN = new Float32Array(256).map((_, i) => toLin(i));
const toSrgb = (l) => { l = Math.min(1, Math.max(0, l)); return 255 * (l <= 0.0031308 ? 12.92 * l : 1.055 * Math.pow(l, 1 / 2.4) - 0.055); };

export function linToLab([r, g, b]) {
  const x = (0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047;
  const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const z = (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883;
  const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const fx = f(x), fy = f(y), fz = f(z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}
export const linToHex = (rgb) => '#' + rgb.map((v) => Math.round(toSrgb(v)).toString(16).padStart(2, '0')).join('').toUpperCase();
export const hexToRgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const lum = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

// ---------- 픽셀 샘플링 ----------
// img: {data, width, height, ox, oy} — 프레임 일부를 잘라온 ImageData + 원본 기준 오프셋
function collect(img, cx, cy, r, rIn = 0, keep = null) {
  const out = [];
  const x0 = Math.max(0, Math.floor(cx - r - img.ox)), x1 = Math.min(img.width - 1, Math.ceil(cx + r - img.ox));
  const y0 = Math.max(0, Math.floor(cy - r - img.oy)), y1 = Math.min(img.height - 1, Math.ceil(cy + r - img.oy));
  const r2 = r * r, ri2 = rIn * rIn, d = img.data;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const dx = x + img.ox - cx, dy = y + img.oy - cy, dd = dx * dx + dy * dy;
      if (dd > r2 || dd < ri2) continue;
      const i = (y * img.width + x) * 4;
      const p = [LIN[d[i]], LIN[d[i + 1]], LIN[d[i + 2]]];
      p.l = lum(p[0], p[1], p[2]);
      if (!keep || keep(p)) out.push(p);
    }
  }
  return out;
}

// 피부처럼 보이는 픽셀만 (머리카락·손가락 그림자·소품 제외): R ≥ G ≥ B 경향 + 너무 어둡지 않음
const isSkin = (p) => p.l > 0.05 && p[0] > p[1] * 0.98 && p[1] > p[2] * 0.8 && p[0] - p[2] > 0.03;
const skinLike = (lab) => lab[0] > 30 && lab[1] > 2 && lab[2] > 4 && lab[1] < 35 && lab[2] < 40;

// 밝기 기준으로 양끝을 잘라내고 평균 (하이라이트·그림자 제거)
function trimmedMean(px, lo = 0.15, hi = 0.1) {
  if (px.length < 6) return null;
  px.sort((a, b) => a.l - b.l);
  const s = px.slice(Math.floor(px.length * lo), Math.ceil(px.length * (1 - hi)));
  const m = [0, 0, 0];
  for (const p of s) { m[0] += p[0]; m[1] += p[1]; m[2] += p[2]; }
  return m.map((v) => v / s.length);
}

const median = (arr) => { const s = [...arr].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : 0; };
const medRGB = (list) => { const v = list.filter(Boolean); return v.length ? [0, 1, 2].map((k) => median(v.map((p) => p[k]))) : null; };

const P = (lm, i, W, H) => [lm[i].x * W, lm[i].y * H];
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const mid = (a, b, t = 0.5) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];

// 프레임 한 장에서 부위별 평균색(선형 RGB) 추출
export function sampleFrame(img, lm, W, H) {
  const L = (i) => P(lm, i, W, H);
  const fw = dist(L(234), L(454));
  const res = {};

  // 피부: 양 볼(여러 지점), 이마, 턱 — 피부가 아닌 픽셀·영역은 제외
  const spots = [
    [L(205), 0.06], [L(425), 0.06], [L(50), 0.05], [L(280), 0.05], [L(187), 0.045], [L(411), 0.045],
    [mid(L(151), L(9), 0.3), 0.05], [L(199), 0.04],
  ];
  const skin = spots.map(([c, r]) => {
    const px = collect(img, c[0], c[1], fw * r, 0, isSkin);
    return px.length > 12 ? trimmedMean(px, 0.2, 0.12) : null;
  }).filter((m) => m && skinLike(linToLab(m)));
  res.skinParts = skin;
  const skinLum = skin.length ? lum(...medRGB(skin)) : 0.3;

  // 눈동자: 홍채 링 (동공·반사광 제외)
  const iris = [];
  for (const [c, e] of [[468, 469], [473, 474]]) {
    const ctr = L(c), r = dist(ctr, L(e));
    const px = collect(img, ctr[0], ctr[1], r * 0.85, r * 0.35, (p) => p.l < skinLum * 0.6);
    px.sort((a, b) => a.l - b.l);
    const keep = px.slice(Math.floor(px.length * 0.1), Math.floor(px.length * 0.7));
    keep.forEach((p) => iris.push(p));
  }
  res.iris = iris.length > 10 ? trimmedMean(iris, 0, 0) : null;

  // 흰자: 홍채와 눈꼬리 사이 — 화이트밸런스 기준
  const sclera = [];
  for (const [c, e, a, b] of [[468, 469, 33, 133], [473, 474, 263, 362]]) {
    const ctr = L(c), r = dist(ctr, L(e));
    for (const corner of [a, b]) {
      const v = L(corner), d = dist(ctr, v);
      if (d < r * 1.3) continue;
      const pos = mid(ctr, v, Math.min(0.75, (r * 1.45) / d + 0.12));
      const white = (p) => p.l > skinLum * 0.6 && (Math.max(...p) - Math.min(...p)) / Math.max(...p) < 0.4;
      collect(img, pos[0], pos[1], r * 0.32, 0, white).forEach((p) => sclera.push(p));
    }
  }
  res.sclera = sclera.length > 12 ? trimmedMean(sclera, 0.5, 0.05) : null;

  // 입술: 윗입술·아랫입술 가운데
  const lipPx = [];
  const lr = dist(L(14), L(17));
  collect(img, ...mid(L(14), L(17)), lr * 0.3).forEach((p) => lipPx.push(p));
  collect(img, ...mid(L(0), L(13)), lr * 0.22).forEach((p) => lipPx.push(p));
  res.lip = trimmedMean(lipPx, 0.2, 0.2);

  // 눈썹 (머리색 대체용)
  const brow = [];
  for (const i of [105, 334, 66, 296]) collect(img, ...L(i), fw * 0.025).forEach((p) => brow.push(p));
  res.brow = trimmedMean(brow, 0.05, 0.5);

  // 밝기 확인용
  res.skinL = skin.length ? linToLab(medRGB(skin))[0] : 0;
  return res;
}

// 머리카락: 세그멘테이션 마스크(카테고리 1)에서 추출
export function sampleHair(img, cat, conf, mw, mh, lm, W, H) {
  const L = (i) => P(lm, i, W, H);
  const fw = dist(L(234), L(454)), chinY = L(152)[1], cx = (L(234)[0] + L(454)[0]) / 2;
  const px = [], d = img.data;
  const step = Math.max(1, Math.round(W / 640));
  for (let y = 0; y < H; y += step) {
    if (y > chinY) break;
    for (let x = Math.max(0, cx - fw * 1.4); x < Math.min(W, cx + fw * 1.4); x += step) {
      const mx = Math.floor((x / W) * mw), my = Math.floor((y / H) * mh), mi = my * mw + mx;
      if (cat[mi] !== 1 || (conf && conf[mi] < 0.75)) continue;
      const ix = Math.floor(x) - img.ox, iy = y - img.oy;
      if (ix < 0 || iy < 0 || ix >= img.width || iy >= img.height) continue;
      const i = (iy * img.width + ix) * 4;
      const p = [LIN[d[i]], LIN[d[i + 1]], LIN[d[i + 2]]];
      p.l = lum(...p);
      px.push(p);
    }
  }
  return px.length > 200 ? trimmedMean(px, 0.1, 0.25) : null;
}

// ---------- 여러 프레임 합치기 + 화이트밸런스 ----------

export function combine(frames, hair) {
  const skin = medRGB(frames.flatMap((f) => (f.skinParts.length ? [medRGB(f.skinParts)] : [])));
  if (!skin) return null;
  const raw = {
    skin, iris: medRGB(frames.map((f) => f.iris)), sclera: medRGB(frames.map((f) => f.sclera)),
    lip: medRGB(frames.map((f) => f.lip)), brow: medRGB(frames.map((f) => f.brow)), hair,
  };
  // 흰자를 중립색 기준으로 삼아 조명 색을 60%만 보정 (과보정 방지)
  let gains = [1, 1, 1];
  if (raw.sclera) {
    const s = raw.sclera, g = (s[0] + s[1] + s[2]) / 3;
    gains = s.map((c) => Math.min(1.12, Math.max(0.88, 1 + 0.6 * (g / c - 1))));
  }
  const fix = (c) => (c ? c.map((v, i) => v * gains[i]) : null);
  const out = { gains };
  for (const k of ['skin', 'iris', 'lip', 'brow', 'hair']) out[k] = fix(raw[k]);
  if (!out.hair) out.hair = out.brow;
  return out;
}

// ---------- 분류 ----------
const clamp = (v) => Math.max(-1, Math.min(1, v));

// 가중 평균 (값이 없는 항목은 빼고 나머지로 다시 나눔)
const wavg = (pairs) => {
  const v = pairs.filter(([x, w]) => x != null && w > 0);
  const tw = v.reduce((t, [, w]) => t + w, 0);
  return tw ? clamp(v.reduce((t, [x, w]) => t + x * w, 0) / tw) : 0;
};

// opts: { hair: 'natural'|'dyed', lens: false|true, makeup: 'none'|'base'|'full' }
export function classify(c, opts = {}) {
  const lab = {};
  for (const k of ['skin', 'iris', 'lip', 'hair', 'brow']) lab[k] = c[k] ? linToLab(c[k]) : null;
  const [sL, sa, sb] = lab.skin;
  const sHue = (Math.atan2(sb, sa) * 180) / Math.PI;
  const sC = Math.hypot(sa, sb);

  // 염색했으면 머리카락 대신 눈썹을 타고난 모발색으로 사용, 렌즈 꼈으면 눈동자 제외
  const dyed = opts.hair === 'dyed';
  const hair = dyed ? lab.brow : lab.hair;
  const eye = opts.lens ? null : lab.iris;
  const lipW8 = opts.makeup === 'full' ? 0 : opts.makeup === 'base' ? 0.08 : 0.15;

  // 웜/쿨: 피부 색상각(노랑↔분홍) 중심, 머리·눈동자·입술 보조
  const warmth = wavg([
    [clamp((sHue - 54) / 9), 0.6],
    [hair && !dyed ? clamp((hair[2] - 4) / 6) : null, 0.15],
    [eye ? clamp((eye[2] - 6) / 6) : null, 0.1],
    [lab.lip ? clamp(((Math.atan2(lab.lip[2], lab.lip[1]) * 180) / Math.PI - 28) / 10) : null, lipW8],
  ]);

  // 밝기
  const light = wavg([
    [clamp((sL - 64) / 9), 0.6],
    [hair ? clamp((hair[0] - 22) / 12) : null, dyed ? 0.15 : 0.25],
    [eye ? clamp((eye[0] - 28) / 10) : null, 0.15],
  ]);

  // 대비 (피부 vs 머리·눈동자)
  const contrast = wavg([
    [hair ? clamp((sL - hair[0] - 42) / 12) : null, 0.65],
    [eye ? clamp((sL - eye[0] - 36) / 12) : null, 0.35],
  ]);

  // 선명도 (피부 채도 + 대비) — 풀메이크업이면 피부 채도는 덜 믿음
  const clarity = wavg([[clamp((sC - 21) / 5), opts.makeup === 'full' ? 0.3 : 0.6], [contrast, 0.4]]);

  const f = [warmth, light, clarity, contrast];
  const W = [1.6, 1, 1, 0.8];
  const scored = Object.entries(TYPES).map(([id, t]) => {
    const d2 = t.proto.reduce((s, p, i) => s + W[i] * (p - f[i]) ** 2, 0);
    return { id, d2 };
  });
  const ex = scored.map((s) => Math.exp(-s.d2 / 0.35));
  const sum = ex.reduce((a, b) => a + b, 0);
  scored.forEach((s, i) => (s.pct = Math.round((ex[i] / sum) * 100)));
  scored.sort((a, b) => a.d2 - b.d2);

  return {
    type: scored[0].id, ranking: scored, features: { warmth, light, clarity, contrast },
    measured: {
      skin: linToHex(c.skin), hair: c.hair ? linToHex(c.hair) : null,
      iris: c.iris ? linToHex(c.iris) : null, lip: c.lip ? linToHex(c.lip) : null,
    },
    lab,
  };
}
