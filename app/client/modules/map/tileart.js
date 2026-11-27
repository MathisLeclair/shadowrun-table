// Detailed tile art (« Détaillé » tile style): textured floors per theme, wall ambient occlusion, and furniture
// drawn as recognisable objects. A rectangle of identical tiles is ONE object: 4×2 `v` = a car, 1×3 `b` = a sofa,
// 2×2 `b` = a bed, 1×1 `T` = a round table with chairs… Same contract as drawStaticMap: ctx in pixels, S px per cell,
// returns the machinery cells that get animated LEDs.

const FLOOR_STYLE = { street: 'concrete', bar: 'planks', corp: 'tiles', lab: 'smalltiles', industrial: 'concrete', residential: 'planks', matrix: 'panels', club: 'polished' };
const MACHINE_STYLE = { street: 'shelf', bar: 'shelf', residential: 'shelf', industrial: 'machine', corp: 'rack', lab: 'rack', matrix: 'rack', club: 'rack' };
const CAR_COLORS = ['#5a6b82', '#8a3442', '#3a6a52', '#6a6e74', '#8a7238', '#2c4170', '#b8bcc4', '#3d434c'];
const BOTTLES = ['#c9a24a', '#4f8a4a', '#9fc4d6', '#8a3a3a', '#d0b080', '#6a4a8a'];
const BOXES = ['#6a5a44', '#4a5a6a', '#7a4a3a', '#4a6a4a', '#8a7a5a', '#5a4a6a'];

function hash(x, y, s = 0) {
  let h = (x * 374761393 + y * 668265263 + s * 2147483647) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}
function hexToRgb(hex) {
  let h = String(hex || '#ffffff').replace('#', '');
  if (h.length === 3 || h.length === 4) h = h.split('').slice(0, 3).map((c) => c + c).join('');
  const n = parseInt(h.slice(0, 6), 16);
  if (Number.isNaN(n)) return [255, 255, 255];
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function rgba(hex, a) {
  const [r, g, b] = hexToRgb(hex);
  return `rgba(${r},${g},${b},${a})`;
}
/** Lighten (f > 0, toward white) or darken (f < 0, toward black) a hex colour; returns hex. */
function tone(hex, f) {
  const t = f > 0 ? 255 : 0, k = Math.min(1, Math.abs(f));
  return '#' + hexToRgb(hex).map((v) => Math.round(v + (t - v) * k).toString(16).padStart(2, '0')).join('');
}
function rrect(ctx, x, y, w, h, r) {
  const [tl, tr, br, bl] = (Array.isArray(r) ? r : [r, r, r, r]).map((v) => Math.max(0, Math.min(v, w / 2, h / 2)));
  ctx.moveTo(x + tl, y);
  ctx.lineTo(x + w - tr, y);
  ctx.arcTo(x + w, y, x + w, y + tr, tr);
  ctx.lineTo(x + w, y + h - br);
  ctx.arcTo(x + w, y + h, x + w - br, y + h, br);
  ctx.lineTo(x + bl, y + h);
  ctx.arcTo(x, y + h, x, y + h - bl, bl);
  ctx.lineTo(x, y + tl);
  ctx.arcTo(x, y, x + tl, y, tl);
  ctx.closePath();
}

const WALLISH = (c) => c === '#' || c === 'W' || c === ' ' || c === 'D';
const OPEN_FOR_GLOW = (ch) => ch !== '#' && ch !== ' ';
const OBJECT_CHARS = new Set(['T', 'b', 'v', 'm', 's', 'e', 'x']);

export function drawDetailedMap(ctx, map, S, th, themeKey) {
  const w = map.width, h = map.height;
  const T = (x, y) => (x < 0 || y < 0 || x >= w || y >= h ? ' ' : (map.tiles[y] || '')[x] ?? ' ');
  const px = 1 / S;
  const floorStyle = FLOOR_STYLE[themeKey] || 'concrete';
  const machineStyle = MACHINE_STYLE[themeKey] || 'rack';
  const machinery = [];
  const outdoorish = (ch) => ch === ',' || ch === 'g' || ch === 't' || ch === '~';
  const isExt = (x, y) => {
    let o = 0, i = 0;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const c = T(x + dx, y + dy);
      if (outdoorish(c)) o++;
      else if (c === '.' || c === '_') i++;
    }
    return o > i;
  };
  const shadow = (blur = 0.16, off = 0.07, a = 0.55) => {
    ctx.shadowColor = `rgba(0,0,0,${a})`;
    ctx.shadowBlur = Math.max(1, S * blur);
    ctx.shadowOffsetX = S * off * 0.5;
    ctx.shadowOffsetY = S * off;
  };
  const noShadow = () => {
    ctx.shadowColor = 'transparent';
    ctx.shadowBlur = 0;
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 0;
  };
  const fillRR = (x, y, ww, hh, r, color) => {
    ctx.fillStyle = color;
    ctx.beginPath();
    rrect(ctx, x, y, ww, hh, r);
    ctx.fill();
  };
  const dot = (x, y, r, color) => {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  };
  const line = (x1, y1, x2, y2, color, lw) => {
    ctx.strokeStyle = color;
    ctx.lineWidth = lw;
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
  };

  ctx.save();
  ctx.scale(S, S);
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';

  // -------------------------------------------------------------------------
  // Ground materials
  // -------------------------------------------------------------------------
  const floorCell = (x, y) => {
    ctx.fillStyle = th.floor;
    ctx.fillRect(x, y, 1 + px, 1 + px);
    switch (floorStyle) {
      case 'planks': {
        for (let k = 0; k < 4; k++) {
          const row = y * 4 + k, off = hash(row, 7, 1) * 3;
          const v = hash(Math.floor((x + off) / 3), row, 2) - 0.5;
          ctx.fillStyle = v > 0 ? `rgba(255,225,180,${v * 0.06})` : `rgba(0,0,0,${-v * 0.16})`;
          ctx.fillRect(x, y + k * 0.25, 1 + px, 0.25);
          ctx.fillStyle = 'rgba(0,0,0,0.2)';
          ctx.fillRect(x, y + k * 0.25, 1 + px, Math.max(px, 0.015));
          const seam = 3 * Math.ceil((x + off) / 3) - off;
          if (seam < x + 1) ctx.fillRect(seam, y + k * 0.25, Math.max(px, 0.015), 0.25);
          if (hash(x, row, 3) > 0.6) line(x + hash(x, row, 4) * 0.5, y + k * 0.25 + 0.13, x + hash(x, row, 4) * 0.5 + 0.35, y + k * 0.25 + 0.12, 'rgba(0,0,0,0.08)', 0.018);
        }
        break;
      }
      case 'tiles': {
        ctx.fillStyle = `rgba(255,255,255,${0.006 + hash(x, y, 2) * 0.018})`;
        ctx.beginPath();
        ctx.moveTo(x, y); ctx.lineTo(x + 1, y); ctx.lineTo(x, y + 1);
        ctx.fill();
        ctx.fillStyle = 'rgba(0,0,0,0.38)';
        ctx.fillRect(x, y, 1, Math.max(px, 0.025));
        ctx.fillRect(x, y, Math.max(px, 0.025), 1);
        break;
      }
      case 'smalltiles': {
        for (let k = 0; k < 4; k++) {
          const v = hash(x * 2 + (k & 1), y * 2 + (k >> 1), 5) - 0.5;
          ctx.fillStyle = v > 0 ? `rgba(255,255,255,${v * 0.06})` : `rgba(0,0,0,${-v * 0.16})`;
          ctx.fillRect(x + (k & 1) * 0.5, y + (k >> 1) * 0.5, 0.5, 0.5);
        }
        ctx.fillStyle = 'rgba(255,255,255,0.05)';
        ctx.fillRect(x, y + 0.5, 1, Math.max(px, 0.02));
        ctx.fillRect(x + 0.5, y, Math.max(px, 0.02), 1);
        ctx.fillStyle = 'rgba(0,0,0,0.3)';
        ctx.fillRect(x, y, 1, Math.max(px, 0.02));
        ctx.fillRect(x, y, Math.max(px, 0.02), 1);
        break;
      }
      case 'panels': {
        ctx.fillStyle = 'rgba(255,255,255,0.05)';
        ctx.fillRect(x + 0.03, y + 0.03, 0.94, 0.03);
        ctx.fillRect(x + 0.03, y + 0.03, 0.03, 0.94);
        ctx.fillStyle = 'rgba(0,0,0,0.45)';
        ctx.fillRect(x + 0.03, y + 0.94, 0.94, 0.03);
        ctx.fillRect(x + 0.94, y + 0.03, 0.03, 0.94);
        if (S >= 14) for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) dot(x + 0.3 + i * 0.2, y + 0.3 + j * 0.2, 0.025, 'rgba(0,0,0,0.4)');
        break;
      }
      case 'polished': {
        for (let k = 0; k < 4; k++) dot(x + hash(x, y, k) , y + hash(x, y, k + 9), 0.02, `rgba(255,255,255,${0.04 + hash(x, y, k + 3) * 0.05})`);
        if ((x + y) % 9 === 0) {
          ctx.fillStyle = 'rgba(255,255,255,0.025)';
          ctx.beginPath();
          ctx.moveTo(x, y + 1); ctx.lineTo(x + 0.4, y + 1); ctx.lineTo(x + 1, y + 0.4); ctx.lineTo(x + 1, y);
          ctx.fill();
        }
        break;
      }
      default: {
        // concrete: mottling, expansion joints every 4 cells, the odd crack
        for (let k = 0; k < 2; k++) dot(x + hash(x, y, k + 20), y + hash(x, y, k + 22), 0.2 + hash(x, y, k + 24) * 0.25, hash(x, y, k + 26) > 0.5 ? 'rgba(255,255,255,0.012)' : 'rgba(0,0,0,0.045)');
        ctx.fillStyle = 'rgba(0,0,0,0.28)';
        if (x % 4 === 0) ctx.fillRect(x, y, Math.max(px, 0.025), 1);
        if (y % 4 === 0) ctx.fillRect(x, y, 1, Math.max(px, 0.025));
        if (hash(x, y, 30) > 0.95) crack(x, y);
      }
    }
  };
  const crack = (x, y) => {
    ctx.strokeStyle = 'rgba(0,0,0,0.28)';
    ctx.lineWidth = Math.max(px, 0.02);
    ctx.beginPath();
    let cx = x + hash(x, y, 31) * 0.6, cy = y + hash(x, y, 32) * 0.3;
    ctx.moveTo(cx, cy);
    for (let k = 0; k < 3; k++) {
      cx += 0.1 + hash(x, y, 33 + k) * 0.2;
      cy += 0.1 + hash(x, y, 36 + k) * 0.2;
      ctx.lineTo(Math.min(cx, x + 1), Math.min(cy, y + 1));
    }
    ctx.stroke();
  };
  const asphaltCell = (x, y) => {
    ctx.fillStyle = th.ext;
    ctx.fillRect(x, y, 1 + px, 1 + px);
    const n = hash(x, y, 40) - 0.5;
    ctx.fillStyle = n > 0 ? `rgba(255,255,255,${n * 0.03})` : `rgba(0,0,0,${-n * 0.12})`;
    ctx.fillRect(x, y, 1 + px, 1 + px);
    for (let k = 0; k < 6; k++) {
      ctx.fillStyle = k % 2 ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.22)';
      ctx.fillRect(x + hash(x, y, k + 41) * 0.95, y + hash(x, y, k + 48) * 0.95, 0.04, 0.04);
    }
    if (hash(x, y, 55) > 0.955) crack(x, y);
    if (hash(x, y, 56) > 0.965) {
      ctx.fillStyle = 'rgba(0,0,0,0.3)';
      ctx.beginPath();
      ctx.ellipse(x + 0.5, y + 0.5, 0.32, 0.2, hash(x, y, 57) * 3, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = 'rgba(160,110,255,0.08)';
      ctx.lineWidth = 0.03;
      ctx.stroke();
    } else if (hash(x, y, 58) > 0.992) {
      dot(x + 0.5, y + 0.5, 0.32, '#22272e');
      ctx.strokeStyle = 'rgba(0,0,0,0.6)';
      ctx.lineWidth = 0.04;
      ctx.stroke();
      ctx.strokeStyle = 'rgba(255,255,255,0.07)';
      ctx.lineWidth = 0.02;
      ctx.beginPath();
      for (let k = -2; k <= 2; k++) {
        ctx.moveTo(x + 0.5 + k * 0.1, y + 0.24); ctx.lineTo(x + 0.5 + k * 0.1, y + 0.76);
      }
      ctx.stroke();
    }
  };
  const grassCell = (x, y) => {
    ctx.fillStyle = '#142a1b';
    ctx.fillRect(x, y, 1 + px, 1 + px);
    for (let k = 0; k < 3; k++) dot(x + hash(x, y, k + 60), y + hash(x, y, k + 63), 0.18 + hash(x, y, k + 66) * 0.2, hash(x, y, k + 69) > 0.5 ? 'rgba(40,90,50,0.35)' : 'rgba(5,15,8,0.35)');
    ctx.lineWidth = 0.035;
    for (let k = 0; k < 9; k++) {
      const gx = x + 0.05 + hash(x, y, k) * 0.9, gy = y + 0.2 + hash(x, y, k + 9) * 0.75;
      const a = (hash(x, y, k + 18) - 0.5) * 1.4, l = 0.1 + hash(x, y, k + 27) * 0.1;
      ctx.strokeStyle = k % 3 === 0 ? '#3a7a45' : k % 3 === 1 ? '#2a5c34' : '#1f4628';
      ctx.beginPath();
      ctx.moveTo(gx, gy);
      ctx.quadraticCurveTo(gx + Math.sin(a) * l * 0.3, gy - l * 0.6, gx + Math.sin(a) * l, gy - Math.cos(a) * l);
      ctx.stroke();
    }
    if (hash(x, y, 72) > 0.96) dot(x + hash(x, y, 73) * 0.8 + 0.1, y + hash(x, y, 74) * 0.8 + 0.1, 0.05, '#d7c95a');
  };
  const waterCell = (x, y) => {
    ctx.fillStyle = '#0b2536';
    ctx.fillRect(x, y, 1 + px, 1 + px);
    const sameW = (dx, dy) => T(x + dx, y + dy) === '~';
    if (sameW(1, 0) && sameW(-1, 0) && sameW(0, 1) && sameW(0, -1)) {
      ctx.fillStyle = 'rgba(0,0,0,0.2)';
      ctx.fillRect(x, y, 1 + px, 1 + px);
    }
    ctx.strokeStyle = 'rgba(150,220,255,0.35)';
    ctx.lineWidth = 0.05;
    ctx.beginPath();
    if (!sameW(0, -1)) { ctx.moveTo(x, y + 0.04); ctx.lineTo(x + 1, y + 0.04); }
    if (!sameW(0, 1)) { ctx.moveTo(x, y + 0.96); ctx.lineTo(x + 1, y + 0.96); }
    if (!sameW(-1, 0)) { ctx.moveTo(x + 0.04, y); ctx.lineTo(x + 0.04, y + 1); }
    if (!sameW(1, 0)) { ctx.moveTo(x + 0.96, y); ctx.lineTo(x + 0.96, y + 1); }
    ctx.stroke();
    ctx.strokeStyle = 'rgba(110,200,255,0.22)';
    ctx.lineWidth = 0.035;
    ctx.beginPath();
    for (let k = 0; k < 2; k++) {
      const wy = y + 0.3 + k * 0.4 + (hash(x, y, k) - 0.5) * 0.1;
      ctx.moveTo(x + 0.12, wy);
      ctx.quadraticCurveTo(x + 0.3, wy - 0.08, x + 0.5, wy);
      ctx.quadraticCurveTo(x + 0.7, wy + 0.08, x + 0.88, wy);
    }
    ctx.stroke();
    if (hash(x, y, 80) > 0.6) dot(x + hash(x, y, 81) * 0.8 + 0.1, y + hash(x, y, 82) * 0.8 + 0.1, 0.025, 'rgba(200,240,255,0.5)');
  };
  const carpetCell = (x, y) => {
    ctx.fillStyle = th.carpet;
    ctx.fillRect(x, y, 1 + px, 1 + px);
    for (let k = 0; k < 5; k++) {
      ctx.fillStyle = k % 2 ? 'rgba(255,255,255,0.035)' : 'rgba(0,0,0,0.12)';
      ctx.fillRect(x + hash(x, y, k + 90) * 0.95, y + hash(x, y, k + 95) * 0.95, 0.05, 0.05);
    }
    // border only against the room (walls / bare floor), not around furniture standing on the carpet
    const same = (dx, dy) => { const c = T(x + dx, y + dy); return c !== '.' && c !== ',' && c !== '#' && c !== 'D' && c !== 'W' && c !== ' '; };
    ctx.strokeStyle = rgba(th.accent, 0.5);
    ctx.lineWidth = 0.05;
    ctx.beginPath();
    for (const ins of [0.1, 0.2]) {
      if (!same(0, -1)) { ctx.moveTo(x, y + ins); ctx.lineTo(x + 1, y + ins); }
      if (!same(0, 1)) { ctx.moveTo(x, y + 1 - ins); ctx.lineTo(x + 1, y + 1 - ins); }
      if (!same(-1, 0)) { ctx.moveTo(x + ins, y); ctx.lineTo(x + ins, y + 1); }
      if (!same(1, 0)) { ctx.moveTo(x + 1 - ins, y); ctx.lineTo(x + 1 - ins, y + 1); }
    }
    ctx.stroke();
    ctx.fillStyle = rgba(th.accent, 0.14);
    ctx.beginPath();
    ctx.moveTo(x + 0.5, y + 0.28); ctx.lineTo(x + 0.72, y + 0.5); ctx.lineTo(x + 0.5, y + 0.72); ctx.lineTo(x + 0.28, y + 0.5);
    ctx.fill();
  };

  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const ch = T(x, y);
      if (ch === ' ') continue;
      if (ch === '#') {
        ctx.fillStyle = th.wall;
        ctx.fillRect(x, y, 1 + px, 1 + px);
      } else if (ch === '.') floorCell(x, y);
      else if (ch === ',') asphaltCell(x, y);
      else if (ch === 'g' || ch === 't') grassCell(x, y);
      else if (ch === '~') waterCell(x, y);
      else if (ch === '_') carpetCell(x, y);
      else if (isExt(x, y)) asphaltCell(x, y);
      else floorCell(x, y);
    }

  // -------------------------------------------------------------------------
  // Ambient occlusion: floors darken toward the walls that enclose them
  // -------------------------------------------------------------------------
  const AO = 0.42;
  const aoGrad = (x0, y0, x1, y1) => {
    const g = ctx.createLinearGradient(x0, y0, x1, y1);
    g.addColorStop(0, 'rgba(0,0,0,0.5)');
    g.addColorStop(0.45, 'rgba(0,0,0,0.18)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    return g;
  };
  const aoTop = aoGrad(0, 0, 0, AO), aoBot = aoGrad(0, 1, 0, 1 - AO), aoLeft = aoGrad(0, 0, AO, 0), aoRight = aoGrad(1, 0, 1 - AO, 0);
  const occludes = (c) => c === '#' || c === 'W';
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const ch = T(x, y);
      if (ch === '#' || ch === ' ' || ch === 'W' || ch === 'D') continue;
      const t = occludes(T(x, y - 1)), b = occludes(T(x, y + 1)), l = occludes(T(x - 1, y)), r = occludes(T(x + 1, y));
      if (!t && !b && !l && !r) continue;
      ctx.save();
      ctx.translate(x, y);
      if (t) { ctx.fillStyle = aoTop; ctx.fillRect(0, 0, 1, AO); }
      if (b) { ctx.fillStyle = aoBot; ctx.fillRect(0, 1 - AO, 1, AO); }
      if (l) { ctx.fillStyle = aoLeft; ctx.fillRect(0, 0, AO, 1); }
      if (r) { ctx.fillStyle = aoRight; ctx.fillRect(1 - AO, 0, AO, 1); }
      ctx.restore();
    }

  // -------------------------------------------------------------------------
  // Objects: rectangles of identical tiles
  // -------------------------------------------------------------------------
  const rects = { T: [], b: [], v: [], m: [], s: [], e: [], x: [] };
  {
    const used = new Uint8Array(w * h);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const ch = T(x, y);
        if (!OBJECT_CHARS.has(ch) || used[y * w + x]) continue;
        let rw = 1;
        while (x + rw < w && T(x + rw, y) === ch && !used[y * w + x + rw]) rw++;
        let rh = 1;
        grow: while (y + rh < h) {
          for (let i = 0; i < rw; i++) if (T(x + i, y + rh) !== ch || used[(y + rh) * w + x + i]) break grow;
          rh++;
        }
        for (let j = 0; j < rh; j++) for (let i = 0; i < rw; i++) used[(y + j) * w + x + i] = 1;
        rects[ch].push({ x0: x, y0: y, w: rw, h: rh });
      }
  }
  /** Chars just outside one side of a rect: side 0 top, 1 right, 2 bottom, 3 left. */
  const outside = (r, side) => {
    const out = [];
    if (side === 0 || side === 2) for (let i = 0; i < r.w; i++) out.push(T(r.x0 + i, side === 0 ? r.y0 - 1 : r.y0 + r.h));
    else for (let j = 0; j < r.h; j++) out.push(T(side === 3 ? r.x0 - 1 : r.x0 + r.w, r.y0 + j));
    return out;
  };
  const SIDE_ANGLE = [0, Math.PI / 2, Math.PI, -Math.PI / 2];

  // flat features first (they sit on the ground), then the grid, then raised objects
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const ch = T(x, y);
      if (ch === 'r') {
        ctx.fillStyle = 'rgba(120,110,100,0.08)';
        ctx.beginPath();
        ctx.ellipse(x + 0.5, y + 0.5, 0.45, 0.38, hash(x, y, 1) * 3, 0, Math.PI * 2);
        ctx.fill();
        for (let k = 0; k < 5; k++) {
          const rx = x + 0.1 + hash(x, y, k) * 0.7, ry = y + 0.1 + hash(x, y, k + 5) * 0.7, s = 0.09 + hash(x, y, k + 11) * 0.15;
          ctx.fillStyle = k % 2 ? '#4f555e' : '#3a3f47';
          ctx.beginPath();
          ctx.moveTo(rx, ry); ctx.lineTo(rx + s, ry + s * 0.3); ctx.lineTo(rx + s * 0.7, ry + s); ctx.lineTo(rx - s * 0.2, ry + s * 0.7);
          ctx.closePath();
          ctx.fill();
          ctx.strokeStyle = 'rgba(255,255,255,0.1)';
          ctx.lineWidth = 0.02;
          ctx.beginPath();
          ctx.moveTo(rx - s * 0.2, ry + s * 0.7); ctx.lineTo(rx, ry); ctx.lineTo(rx + s, ry + s * 0.3);
          ctx.stroke();
        }
      } else if (ch === 'x') {
        const same = (dx, dy) => T(x + dx, y + dy) === 'x';
        ctx.save();
        ctx.beginPath();
        ctx.rect(x, y, 1, 1);
        ctx.clip();
        ctx.fillStyle = '#2a1608';
        ctx.fillRect(x, y, 1, 1);
        ctx.strokeStyle = 'rgba(224,166,63,0.6)';
        ctx.lineWidth = 0.13;
        ctx.beginPath();
        for (let k = -1; k < 4; k++) { ctx.moveTo(x + k * 0.33, y + 1); ctx.lineTo(x + k * 0.33 + 1, y); }
        ctx.stroke();
        ctx.restore();
        ctx.strokeStyle = 'rgba(224,92,92,0.6)';
        ctx.lineWidth = 0.05;
        ctx.beginPath();
        if (!same(0, -1)) { ctx.moveTo(x, y + 0.03); ctx.lineTo(x + 1, y + 0.03); }
        if (!same(0, 1)) { ctx.moveTo(x, y + 0.97); ctx.lineTo(x + 1, y + 0.97); }
        if (!same(-1, 0)) { ctx.moveTo(x + 0.03, y); ctx.lineTo(x + 0.03, y + 1); }
        if (!same(1, 0)) { ctx.moveTo(x + 0.97, y); ctx.lineTo(x + 0.97, y + 1); }
        ctx.stroke();
      }
    }
  for (const r of rects.x) {
    // warning sign in the middle of each hazard zone
    const cx = r.x0 + r.w / 2, cy = r.y0 + r.h / 2, s = Math.min(0.42, 0.2 + Math.min(r.w, r.h) * 0.1);
    ctx.save();
    ctx.shadowColor = '#e0a63f';
    ctx.shadowBlur = S * 0.3;
    ctx.fillStyle = '#e0a63f';
    ctx.beginPath();
    ctx.moveTo(cx, cy - s); ctx.lineTo(cx + s * 1.1, cy + s * 0.8); ctx.lineTo(cx - s * 1.1, cy + s * 0.8);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
    ctx.fillStyle = '#1a0e04';
    ctx.fillRect(cx - s * 0.08, cy - s * 0.45, s * 0.16, s * 0.75);
    dot(cx, cy + s * 0.52, s * 0.09, '#1a0e04');
  }
  for (const r of rects.s) {
    const horiz = r.w > r.h || (r.w === r.h && T(r.x0 - 1, r.y0) !== '#' && T(r.x0 + r.w, r.y0) !== '#');
    const L = horiz ? r.w : r.h, up = hash(r.x0, r.y0, 13) > 0.5;
    ctx.save();
    ctx.translate(r.x0 + r.w / 2, r.y0 + r.h / 2);
    if (!horiz) ctx.rotate(Math.PI / 2);
    if (up) ctx.rotate(Math.PI);
    const W = horiz ? r.h : r.w;
    ctx.fillStyle = tone(th.floor, 0.06);
    ctx.fillRect(-L / 2, -W / 2, L, W);
    const n = Math.max(3, Math.round(L * 4));
    for (let i = 0; i < n; i++) {
      const x0 = -L / 2 + (i * L) / n;
      ctx.fillStyle = `rgba(0,0,0,${0.04 + (0.42 * i) / n})`;
      ctx.fillRect(x0, -W / 2, L / n + px, W);
      ctx.fillStyle = 'rgba(220,230,240,0.16)';
      ctx.fillRect(x0, -W / 2, Math.max(px, 0.03), W);
    }
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.fillRect(-L / 2, -W / 2, L, 0.07);
    ctx.fillRect(-L / 2, W / 2 - 0.07, L, 0.07);
    // chevron pointing up the stairs (toward the light end)
    ctx.strokeStyle = 'rgba(230,240,250,0.4)';
    ctx.lineWidth = 0.06;
    const c = Math.min(0.22, W * 0.25);
    ctx.beginPath();
    ctx.moveTo(c * 0.6, -c); ctx.lineTo(-c * 0.6, 0); ctx.lineTo(c * 0.6, c);
    ctx.stroke();
    ctx.restore();
  }
  for (const r of rects.e) {
    ctx.fillStyle = '#262d36';
    ctx.fillRect(r.x0, r.y0, r.w, r.h);
    ctx.strokeStyle = 'rgba(255,255,255,0.06)';
    ctx.lineWidth = 0.03;
    ctx.beginPath();
    for (let j = 0; j < r.h * 5; j++)
      for (let i = 0; i < r.w * 5; i++) {
        const xx = r.x0 + (i + 0.5) / 5, yy = r.y0 + (j + 0.5) / 5, d = (i + j) % 2 ? 0.05 : -0.05;
        ctx.moveTo(xx - 0.04, yy - d); ctx.lineTo(xx + 0.04, yy + d);
      }
    ctx.stroke();
    ctx.strokeStyle = 'rgba(160,180,200,0.45)';
    ctx.lineWidth = 0.06;
    ctx.strokeRect(r.x0 + 0.07, r.y0 + 0.07, r.w - 0.14, r.h - 0.14);
    const cx = r.x0 + r.w / 2, cy = r.y0 + r.h / 2, s = Math.min(0.2, 0.1 + Math.min(r.w, r.h) * 0.05);
    ctx.save();
    ctx.shadowColor = th.glow;
    ctx.shadowBlur = S * 0.25;
    ctx.fillStyle = rgba(th.glow, 0.85);
    ctx.beginPath();
    ctx.moveTo(cx, cy - s * 1.5); ctx.lineTo(cx + s, cy - s * 0.3); ctx.lineTo(cx - s, cy - s * 0.3); ctx.closePath();
    ctx.moveTo(cx, cy + s * 1.5); ctx.lineTo(cx + s, cy + s * 0.3); ctx.lineTo(cx - s, cy + s * 0.3); ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  // grid over everything walkable-ish, under the furniture so objects read as solid
  const grid = new Path2D();
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const ch = T(x, y);
      if (ch !== '#' && ch !== ' ') grid.rect(x, y, 1, 1);
    }
  ctx.strokeStyle = th.grid || 'rgba(170,200,220,0.08)';
  ctx.lineWidth = px;
  ctx.stroke(grid);

  // ---- crates / barrels / containers (per cell)
  const crate = (x, y) => {
    const k = hash(x, y, 4);
    if (k < 0.5) {
      const s = 0.74 + hash(x, y, 6) * 0.12, a = (hash(x, y, 5) - 0.5) * 0.3;
      ctx.save();
      ctx.translate(x + 0.5, y + 0.5);
      ctx.rotate(a);
      shadow();
      ctx.fillStyle = '#6b5230';
      ctx.fillRect(-s / 2, -s / 2, s, s);
      noShadow();
      ctx.strokeStyle = 'rgba(40,25,10,0.5)';
      ctx.lineWidth = 0.025;
      ctx.beginPath();
      for (let i = 1; i < 4; i++) { ctx.moveTo(-s / 2, -s / 2 + (i * s) / 4); ctx.lineTo(s / 2, -s / 2 + (i * s) / 4); }
      ctx.stroke();
      ctx.strokeStyle = '#3b2a15';
      ctx.lineWidth = 0.06;
      ctx.strokeRect(-s / 2 + 0.03, -s / 2 + 0.03, s - 0.06, s - 0.06);
      line(-s / 2 + 0.06, s / 2 - 0.06, s / 2 - 0.06, -s / 2 + 0.06, '#4a3519', 0.07);
      ctx.strokeStyle = 'rgba(255,220,160,0.2)';
      ctx.lineWidth = 0.03;
      ctx.beginPath();
      ctx.moveTo(-s / 2 + 0.02, s / 2 - 0.02); ctx.lineTo(-s / 2 + 0.02, -s / 2 + 0.02); ctx.lineTo(s / 2 - 0.02, -s / 2 + 0.02);
      ctx.stroke();
      ctx.restore();
    } else if (k < 0.75) {
      const ins = 0.09;
      shadow();
      fillRR(x + ins, y + ins, 1 - 2 * ins, 1 - 2 * ins, 0.04, th.metal);
      noShadow();
      ctx.strokeStyle = 'rgba(0,0,0,0.35)';
      ctx.lineWidth = 0.025;
      ctx.beginPath();
      for (let i = 1; i < 7; i++) { ctx.moveTo(x + ins + i * 0.118, y + ins + 0.04); ctx.lineTo(x + ins + i * 0.118, y + 1 - ins - 0.04); }
      ctx.stroke();
      ctx.strokeStyle = 'rgba(200,220,240,0.25)';
      ctx.lineWidth = 0.03;
      ctx.strokeRect(x + ins, y + ins, 1 - 2 * ins, 1 - 2 * ins);
      ctx.fillStyle = rgba(th.accent, 0.55);
      ctx.fillRect(x + 0.2, y + 0.42, 0.22, 0.12);
    } else {
      const barrel = (cx, cy, r, col) => {
        shadow(0.12, 0.06);
        dot(cx, cy, r, col);
        noShadow();
        ctx.strokeStyle = tone(col, -0.45);
        ctx.lineWidth = 0.04;
        ctx.beginPath(); ctx.arc(cx, cy, r - 0.02, 0, Math.PI * 2); ctx.stroke();
        ctx.strokeStyle = 'rgba(0,0,0,0.3)';
        ctx.lineWidth = 0.025;
        ctx.beginPath(); ctx.arc(cx, cy, r * 0.66, 0, Math.PI * 2); ctx.stroke();
        ctx.strokeStyle = 'rgba(255,255,255,0.22)';
        ctx.lineWidth = 0.03;
        ctx.beginPath(); ctx.arc(cx, cy, r * 0.82, Math.PI * 1.05, Math.PI * 1.6); ctx.stroke();
        dot(cx + r * 0.38, cy - r * 0.2, r * 0.12, tone(col, -0.5));
      };
      const col = ['#5a6b3a', '#7a3a2a', '#3a4a6a', '#8a6a2a'][Math.floor(hash(x, y, 7) * 4)];
      if (hash(x, y, 8) > 0.6) {
        barrel(x + 0.3, y + 0.32, 0.22, col);
        barrel(x + 0.68, y + 0.62, 0.22, ['#5a6b3a', '#7a3a2a', '#3a4a6a', '#8a6a2a'][Math.floor(hash(x, y, 9) * 4)]);
      } else barrel(x + 0.5, y + 0.5, 0.35, col);
    }
  };

  // ---- counters (indoors) / railings and fences (outdoors), connected per cell
  const counterCell = (x, y) => {
    const same = (dx, dy) => T(x + dx, y + dy) === '=';
    if (isExt(x, y)) {
      const col = tone(th.metal, 0.2);
      ctx.beginPath();
      let any = false;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]])
        if (same(dx, dy)) {
          ctx.moveTo(x + 0.5, y + 0.5);
          ctx.lineTo(x + 0.5 + dx * 0.5, y + 0.5 + dy * 0.5);
          any = true;
        }
      if (any) {
        shadow(0.08, 0.05, 0.6);
        ctx.strokeStyle = col;
        ctx.lineWidth = 0.09;
        ctx.stroke();
        noShadow();
        ctx.strokeStyle = 'rgba(255,255,255,0.2)';
        ctx.lineWidth = 0.025;
        ctx.stroke();
      }
      shadow(0.08, 0.05, 0.6);
      fillRR(x + 0.4, y + 0.4, 0.2, 0.2, 0.04, tone(th.metal, -0.1));
      noShadow();
      return;
    }
    const ins = 0.2;
    const l = same(-1, 0) ? 0 : ins, r = same(1, 0) ? 0 : ins, t = same(0, -1) ? 0 : ins, b = same(0, 1) ? 0 : ins;
    const R = [!l || !t ? 0 : 0.06, !r || !t ? 0 : 0.06, !r || !b ? 0 : 0.06, !l || !b ? 0 : 0.06];
    const x0 = x + l, y0 = y + t, cw = 1 - l - r, chh = 1 - t - b;
    shadow(0.12, 0.06);
    ctx.fillStyle = tone(th.wood, -0.15);
    ctx.beginPath(); rrect(ctx, x0, y0, cw + (r ? 0 : px), chh + (b ? 0 : px), R); ctx.fill();
    noShadow();
    ctx.fillStyle = tone(th.wood, 0.1);
    ctx.beginPath(); rrect(ctx, x0 + (l ? 0.05 : 0), y0 + (t ? 0.05 : 0), cw - (l ? 0.05 : 0) - (r ? 0.05 : 0) + (r ? 0 : px), chh - (t ? 0.05 : 0) - (b ? 0.05 : 0) + (b ? 0 : px), R); ctx.fill();
    ctx.strokeStyle = rgba(th.glow, 0.4);
    ctx.lineWidth = 0.03;
    ctx.beginPath();
    if (t) { ctx.moveTo(x0, y0 + 0.08); ctx.lineTo(x0 + cw, y0 + 0.08); }
    if (b) { ctx.moveTo(x0, y0 + chh - 0.08); ctx.lineTo(x0 + cw, y0 + chh - 0.08); }
    if (l) { ctx.moveTo(x0 + 0.08, y0); ctx.lineTo(x0 + 0.08, y0 + chh); }
    if (r) { ctx.moveTo(x0 + cw - 0.08, y0); ctx.lineTo(x0 + cw - 0.08, y0 + chh); }
    ctx.stroke();
    const k = hash(x, y, 31);
    if (k > 0.94) {
      fillRR(x + 0.37, y + 0.4, 0.26, 0.2, 0.03, '#15191f');
      ctx.fillStyle = rgba(th.glow, 0.8);
      ctx.fillRect(x + 0.41, y + 0.44, 0.18, 0.05);
    } else if (k > 0.7) {
      const gx = x + 0.35 + hash(x, y, 32) * 0.3, gy = y + 0.35 + hash(x, y, 33) * 0.3;
      dot(gx, gy, 0.07, 'rgba(180,230,255,0.22)');
      ctx.strokeStyle = 'rgba(220,240,255,0.55)';
      ctx.lineWidth = 0.02;
      ctx.beginPath(); ctx.arc(gx, gy, 0.07, 0, Math.PI * 2); ctx.stroke();
    }
  };

  // ---- chairs, tables
  const chair = (cx, cy, ang) => {
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(ang); // back of the chair toward -y
    shadow(0.08, 0.04, 0.5);
    fillRR(-0.15, -0.12, 0.3, 0.24, 0.06, tone(th.fabric, 0.18));
    noShadow();
    fillRR(-0.15, -0.12, 0.3, 0.08, 0.05, tone(th.fabric, -0.2));
    ctx.fillStyle = 'rgba(255,255,255,0.1)';
    ctx.fillRect(-0.1, -0.02, 0.2, 0.04);
    ctx.restore();
  };
  const tableTop = () => (themeKey === 'lab' || themeKey === 'matrix' ? th.metal : th.wood);
  const tableItem = (x, y) => {
    const k = hash(x, y, 41);
    if (k < 0.55) return;
    const cx = x + 0.5 + (hash(x, y, 42) - 0.5) * 0.3, cy = y + 0.5 + (hash(x, y, 43) - 0.5) * 0.15;
    if (themeKey === 'corp' || themeKey === 'matrix' || themeKey === 'lab') {
      fillRR(cx - 0.14, cy - 0.09, 0.28, 0.18, 0.02, '#14181e');
      ctx.fillStyle = rgba(th.glow, 0.55);
      ctx.fillRect(cx - 0.11, cy - 0.07, 0.22, 0.08);
    } else if (themeKey === 'bar' || themeKey === 'club') {
      dot(cx, cy, 0.07, 'rgba(180,230,255,0.25)');
      ctx.strokeStyle = 'rgba(220,240,255,0.6)';
      ctx.lineWidth = 0.02;
      ctx.beginPath(); ctx.arc(cx, cy, 0.07, 0, Math.PI * 2); ctx.stroke();
      if (k > 0.85) dot(cx + 0.14, cy + 0.04, 0.05, rgba(BOTTLES[Math.floor(k * 60) % BOTTLES.length], 0.9));
    } else if (themeKey === 'industrial') {
      ctx.fillStyle = '#8a929c';
      ctx.fillRect(cx - 0.12, cy - 0.025, 0.24, 0.05);
      dot(cx + 0.12, cy, 0.045, '#8a929c');
    } else {
      dot(cx, cy, 0.11, '#c8ccd4');
      ctx.strokeStyle = 'rgba(0,0,0,0.25)';
      ctx.lineWidth = 0.015;
      ctx.beginPath(); ctx.arc(cx, cy, 0.07, 0, Math.PI * 2); ctx.stroke();
    }
  };
  const SEAT_BLOCK = new Set(['#', 'W', ' ', 'b', '=', 'm', 'T', 'c', 'v', 'o', '~', 't']);
  const table = (r) => {
    const top = tableTop();
    if (r.w === 1 && r.h === 1) {
      const { x0: x, y0: y } = r;
      [[0, -1, 0], [1, 0, Math.PI / 2], [0, 1, Math.PI], [-1, 0, -Math.PI / 2]].forEach(([dx, dy, a]) => {
        if (!SEAT_BLOCK.has(T(x + dx, y + dy))) chair(x + 0.5 + dx * 0.36, y + 0.5 + dy * 0.36, a);
      });
      shadow();
      dot(x + 0.5, y + 0.5, 0.27, top);
      noShadow();
      ctx.strokeStyle = 'rgba(255,255,255,0.12)';
      ctx.lineWidth = 0.025;
      ctx.beginPath(); ctx.arc(x + 0.5, y + 0.5, 0.22, Math.PI * 0.9, Math.PI * 1.7); ctx.stroke();
      ctx.strokeStyle = 'rgba(0,0,0,0.45)';
      ctx.beginPath(); ctx.arc(x + 0.5, y + 0.5, 0.27, 0, Math.PI * 2); ctx.stroke();
      if (hash(x, y, 41) > 0.4) dot(x + 0.5, y + 0.5, 0.06, 'rgba(180,230,255,0.35)');
      return;
    }
    const horiz = r.w >= r.h;
    const L = horiz ? r.w : r.h;
    const ins = 0.27, end = 0.1;
    // chairs on the long sides, where there is room
    for (let i = 0; i < L; i++) {
      for (const side of horiz ? [0, 2] : [3, 1]) {
        const o = outside(r, side)[i];
        if (SEAT_BLOCK.has(o)) continue;
        const cx = horiz ? r.x0 + i + 0.5 : side === 3 ? r.x0 + 0.14 : r.x0 + r.w - 0.14;
        const cy = horiz ? (side === 0 ? r.y0 + 0.14 : r.y0 + r.h - 0.14) : r.y0 + i + 0.5;
        chair(cx, cy, SIDE_ANGLE[side]);
      }
    }
    const tx = horiz ? r.x0 + end : r.x0 + ins, ty = horiz ? r.y0 + ins : r.y0 + end;
    const tw = horiz ? r.w - 2 * end : r.w - 2 * ins, thh = horiz ? r.h - 2 * ins : r.h - 2 * end;
    shadow();
    fillRR(tx, ty, tw, thh, 0.08, top);
    noShadow();
    // grain along the long axis
    ctx.save();
    ctx.beginPath(); rrect(ctx, tx, ty, tw, thh, 0.08); ctx.clip();
    ctx.strokeStyle = 'rgba(0,0,0,0.14)';
    ctx.lineWidth = 0.02;
    ctx.beginPath();
    const n = Math.max(3, Math.round((horiz ? thh : tw) * 6));
    for (let k = 1; k < n; k++) {
      const f = k / n + (hash(r.x0, r.y0, k) - 0.5) * 0.05;
      if (horiz) { const yy = ty + thh * f; ctx.moveTo(tx, yy); ctx.quadraticCurveTo(tx + tw / 2, yy + (hash(k, r.y0, 3) - 0.5) * 0.12, tx + tw, yy); }
      else { const xx = tx + tw * f; ctx.moveTo(xx, ty); ctx.quadraticCurveTo(xx + (hash(k, r.x0, 3) - 0.5) * 0.12, ty + thh / 2, xx, ty + thh); }
    }
    ctx.stroke();
    ctx.restore();
    ctx.strokeStyle = 'rgba(255,255,255,0.12)';
    ctx.lineWidth = 0.03;
    ctx.beginPath();
    ctx.moveTo(tx + 0.06, ty + thh - 0.06); ctx.lineTo(tx + 0.06, ty + 0.06); ctx.lineTo(tx + tw - 0.06, ty + 0.06);
    ctx.stroke();
    ctx.strokeStyle = 'rgba(0,0,0,0.5)';
    ctx.beginPath(); rrect(ctx, tx, ty, tw, thh, 0.08); ctx.stroke();
    for (let j = 0; j < r.h; j++) for (let i = 0; i < r.w; i++) tableItem(r.x0 + i, r.y0 + j);
  };

  // ---- beds (2+ cells both ways) and sofas / booths / armchairs (1 cell thick)
  const bed = (r) => {
    // head = the short side against a wall
    const score = (side) => outside(r, side).filter(WALLISH).length;
    const shortSides = r.w > r.h ? [3, 1] : r.h > r.w ? [0, 2] : [0, 3, 1, 2];
    let head = shortSides[0];
    for (const s of shortSides) if (score(s) > score(head)) head = s;
    const sideways = head === 1 || head === 3;
    const Lb = sideways ? r.w : r.h, Wb = sideways ? r.h : r.w;
    ctx.save();
    ctx.translate(r.x0 + r.w / 2, r.y0 + r.h / 2);
    ctx.rotate(SIDE_ANGLE[head]);
    shadow();
    fillRR(-Wb / 2 + 0.06, -Lb / 2 + 0.06, Wb - 0.12, Lb - 0.12, 0.08, tone(th.wood, -0.15));
    noShadow();
    fillRR(-Wb / 2 + 0.12, -Lb / 2 + 0.12, Wb - 0.24, Lb - 0.2, 0.08, '#7c8190');
    const np = Math.max(1, Math.round(Wb - 0.2));
    const pw = (Wb - 0.32) / np;
    for (let i = 0; i < np; i++) {
      fillRR(-Wb / 2 + 0.16 + i * pw + 0.03, -Lb / 2 + 0.17, pw - 0.06, 0.3, 0.09, '#b9bec9');
      ctx.strokeStyle = 'rgba(0,0,0,0.25)';
      ctx.lineWidth = 0.02;
      ctx.stroke();
    }
    const by = -Lb / 2 + 0.62;
    fillRR(-Wb / 2 + 0.12, by, Wb - 0.24, Lb / 2 - by - 0.08, [0, 0, 0.08, 0.08], tone(th.fabric, 0.15));
    ctx.fillStyle = tone(th.fabric, 0.32);
    ctx.fillRect(-Wb / 2 + 0.12, by, Wb - 0.24, 0.12);
    ctx.strokeStyle = 'rgba(0,0,0,0.18)';
    ctx.lineWidth = 0.025;
    ctx.beginPath();
    ctx.moveTo(-Wb / 2 + 0.25, by + 0.35); ctx.quadraticCurveTo(0, by + 0.5, Wb / 2 - 0.3, by + 0.3);
    ctx.moveTo(-Wb / 2 + 0.35, Lb / 2 - 0.35); ctx.quadraticCurveTo(0, Lb / 2 - 0.5, Wb / 2 - 0.25, Lb / 2 - 0.3);
    ctx.stroke();
    ctx.restore();
  };
  const sofa = (r) => {
    const sides = r.w === 1 && r.h === 1 ? [0, 1, 2, 3] : r.w > r.h ? [0, 2] : [3, 1];
    const sideScore = (side) =>
      outside(r, side).reduce((s, c) => s + (WALLISH(c) ? 3 : c === 'T' ? -6 : c === '=' || c === 'm' ? 2 : 1), 0);
    let back = sides[0];
    for (const s of sides) if (sideScore(s) > sideScore(back)) back = s;
    const L = back === 0 || back === 2 ? r.w : r.h;
    const fab = th.fabric;
    ctx.save();
    ctx.translate(r.x0 + r.w / 2, r.y0 + r.h / 2);
    ctx.rotate(SIDE_ANGLE[back]);
    shadow();
    fillRR(-L / 2 + 0.06, -0.42, L - 0.12, 0.82, 0.12, fab);
    noShadow();
    fillRR(-L / 2 + 0.06, -0.42, L - 0.12, 0.3, [0.12, 0.12, 0.05, 0.05], tone(fab, -0.35));
    ctx.fillStyle = 'rgba(255,255,255,0.08)';
    ctx.fillRect(-L / 2 + 0.16, -0.38, L - 0.32, 0.05);
    fillRR(-L / 2 + 0.06, -0.42, 0.2, 0.82, 0.08, tone(fab, -0.22));
    fillRR(L / 2 - 0.26, -0.42, 0.2, 0.82, 0.08, tone(fab, -0.22));
    const seats = Math.max(1, L);
    const sw = (L - 0.52) / seats;
    for (let i = 0; i < seats; i++) {
      fillRR(-L / 2 + 0.26 + i * sw + 0.02, -0.12, sw - 0.04, 0.48, 0.07, tone(fab, 0.12));
      ctx.fillStyle = 'rgba(255,255,255,0.08)';
      ctx.fillRect(-L / 2 + 0.26 + i * sw + 0.06, 0.24, sw - 0.12, 0.05);
    }
    ctx.restore();
  };

  // ---- vehicles
  const vehicle = (r) => {
    const vertical = r.h > r.w;
    const L = vertical ? r.h : r.w, Wd = vertical ? r.w : r.h;
    ctx.save();
    ctx.translate(r.x0 + r.w / 2, r.y0 + r.h / 2);
    ctx.rotate((vertical ? Math.PI / 2 : 0) + (hash(r.x0, r.y0, 12) > 0.5 ? Math.PI : 0)); // front toward +x
    const color = CAR_COLORS[Math.floor(hash(r.x0, r.y0, 2) * CAR_COLORS.length)];
    if (Wd === 1) {
      // motorbike
      const bl = Math.max(0.7, L - 0.3);
      fillRR(bl / 2 - 0.3, -0.06, 0.3, 0.12, 0.05, '#0c0e11');
      fillRR(-bl / 2, -0.07, 0.32, 0.14, 0.05, '#0c0e11');
      shadow(0.1, 0.05);
      fillRR(-bl / 2 + 0.18, -0.12, bl - 0.4, 0.24, 0.1, color);
      noShadow();
      fillRR(-bl / 2 + 0.22, -0.08, bl * 0.35, 0.16, 0.06, '#1a1d22');
      line(bl / 2 - 0.25, -0.24, bl / 2 - 0.25, 0.24, '#9aa4b0', 0.05);
      dot(bl / 2 - 0.12, 0, 0.05, '#fff3c4');
      ctx.restore();
      return;
    }
    const bl = L - 0.25, bw = Wd - 0.3;
    // wheels poke out from under the body
    for (const sx of [-1, 1]) for (const sy of [-1, 1]) fillRR(sx * bl * 0.3 - 0.18, sy * (bw / 2) - 0.07, 0.36, 0.14, 0.04, '#0c0e11');
    shadow(0.22, 0.1, 0.6);
    fillRR(-bl / 2, -bw / 2, bl, bw, bw * 0.3, color);
    noShadow();
    ctx.fillStyle = 'rgba(255,255,255,0.07)';
    ctx.beginPath(); rrect(ctx, -bl / 2 + 0.12, -bw * 0.22, bl - 0.24, bw * 0.44, 0.12); ctx.fill();
    const glass = (pts) => {
      const g = ctx.createLinearGradient(0, -bw / 2, 0, bw / 2);
      g.addColorStop(0, '#2b4256'); g.addColorStop(0.5, '#16212c'); g.addColorStop(1, '#2b4256');
      ctx.fillStyle = g;
      ctx.beginPath();
      pts.forEach(([a, b], i) => (i ? ctx.lineTo(a, b) : ctx.moveTo(a, b)));
      ctx.closePath();
      ctx.fill();
    };
    if (L >= 5 && Wd >= 3) {
      // van / truck: cab in front, cargo box behind
      const cab = Math.min(1.3, bl * 0.3);
      fillRR(-bl / 2 + 0.04, -bw / 2 + 0.04, bl - cab - 0.06, bw - 0.08, 0.06, tone(color, 0.12));
      ctx.strokeStyle = 'rgba(0,0,0,0.25)';
      ctx.lineWidth = 0.03;
      ctx.beginPath();
      for (let xx = -bl / 2 + 0.35; xx < bl / 2 - cab - 0.1; xx += 0.35) { ctx.moveTo(xx, -bw / 2 + 0.1); ctx.lineTo(xx, bw / 2 - 0.1); }
      ctx.stroke();
      const wx = bl / 2 - cab * 0.45;
      glass([[wx, -bw / 2 + 0.12], [wx + 0.22, -bw / 2 + 0.08], [wx + 0.22, bw / 2 - 0.08], [wx, bw / 2 - 0.12]]);
    } else {
      const hood = bl * 0.25, roof = bl * 0.3;
      const w1 = bl / 2 - hood, w0 = w1 - 0.3, r0 = w0 - roof;
      glass([[w1, -bw / 2 + 0.1], [w1, bw / 2 - 0.1], [w0, bw / 2 - 0.18], [w0, -bw / 2 + 0.18]]);
      fillRR(r0, -bw / 2 + 0.18, roof, bw - 0.36, 0.08, tone(color, 0.12));
      glass([[r0, -bw / 2 + 0.18], [r0, bw / 2 - 0.18], [r0 - 0.22, bw / 2 - 0.12], [r0 - 0.22, -bw / 2 + 0.12]]);
      line(w1 + 0.08, 0, bl / 2 - 0.08, 0, 'rgba(0,0,0,0.18)', 0.025);
      fillRR(w1 - 0.08, -bw / 2 - 0.06, 0.1, 0.08, 0.02, color);
      fillRR(w1 - 0.08, bw / 2 - 0.02, 0.1, 0.08, 0.02, color);
    }
    ctx.save();
    ctx.shadowColor = '#ffe9a0';
    ctx.shadowBlur = S * 0.2;
    fillRR(bl / 2 - 0.09, -bw / 2 + 0.08, 0.07, 0.18, 0.03, '#fff3c4');
    fillRR(bl / 2 - 0.09, bw / 2 - 0.26, 0.07, 0.18, 0.03, '#fff3c4');
    ctx.shadowColor = '#e05050';
    fillRR(-bl / 2 + 0.02, -bw / 2 + 0.08, 0.06, 0.2, 0.03, '#e05050');
    fillRR(-bl / 2 + 0.02, bw / 2 - 0.28, 0.06, 0.2, 0.03, '#e05050');
    ctx.restore();
    ctx.strokeStyle = 'rgba(255,255,255,0.18)';
    ctx.lineWidth = 0.03;
    ctx.beginPath(); rrect(ctx, -bl / 2, -bw / 2, bl, bw, bw * 0.3); ctx.stroke();
    ctx.restore();
  };

  // ---- machinery: server racks / shelves / industrial machines
  const machine = (r) => {
    const cells = [];
    for (let j = 0; j < r.h; j++) for (let i = 0; i < r.w; i++) cells.push([r.x0 + i, r.y0 + j]);
    if (machineStyle === 'shelf') {
      shadow();
      fillRR(r.x0 + 0.05, r.y0 + 0.05, r.w - 0.1, r.h - 0.1, 0.04, tone(th.wood, -0.3));
      noShadow();
      const bottles = themeKey === 'bar' || themeKey === 'club';
      for (const [x, y] of cells) {
        ctx.fillStyle = 'rgba(0,0,0,0.4)';
        ctx.fillRect(x + 0.12, y + 0.12, 0.76, 0.76);
        if (bottles) {
          for (let k = 0; k < 5; k++) {
            const bx = x + 0.22 + (k % 3) * 0.28, by = y + 0.3 + Math.floor(k / 3) * 0.38;
            dot(bx, by, 0.075, BOTTLES[Math.floor(hash(x, y, k + 50) * BOTTLES.length)]);
            dot(bx - 0.02, by - 0.02, 0.025, 'rgba(255,255,255,0.45)');
          }
        } else {
          for (let k = 0; k < 3; k++) {
            const bw = 0.14 + hash(x, y, k + 50) * 0.12;
            const bx = x + 0.15 + k * 0.24;
            ctx.fillStyle = BOXES[Math.floor(hash(x, y, k + 53) * BOXES.length)];
            ctx.fillRect(bx, y + 0.18 + hash(x, y, k + 56) * 0.1, Math.min(bw, 0.22), 0.55);
          }
        }
        ctx.fillStyle = rgba(th.wood, 0.9);
        ctx.fillRect(x + 0.05, y + 0.5 - 0.025, 0.9, 0.05);
      }
      return;
    }
    machinery.push(...cells);
    if (machineStyle === 'machine') {
      shadow();
      const g = ctx.createLinearGradient(r.x0, r.y0, r.x0 + r.w, r.y0 + r.h);
      g.addColorStop(0, tone(th.metal, 0.12));
      g.addColorStop(1, tone(th.metal, -0.25));
      ctx.fillStyle = g;
      ctx.beginPath(); rrect(ctx, r.x0 + 0.06, r.y0 + 0.06, r.w - 0.12, r.h - 0.12, 0.06); ctx.fill();
      noShadow();
      // hazard band along the bottom edge
      ctx.save();
      ctx.beginPath(); ctx.rect(r.x0 + 0.06, r.y0 + r.h - 0.2, r.w - 0.12, 0.12); ctx.clip();
      ctx.fillStyle = '#d9a030';
      ctx.fillRect(r.x0, r.y0 + r.h - 0.2, r.w, 0.12);
      ctx.strokeStyle = '#15120c';
      ctx.lineWidth = 0.06;
      ctx.beginPath();
      for (let xx = r.x0 - 0.2; xx < r.x0 + r.w; xx += 0.16) { ctx.moveTo(xx, r.y0 + r.h - 0.08); ctx.lineTo(xx + 0.12, r.y0 + r.h - 0.2); }
      ctx.stroke();
      ctx.restore();
      const fr = Math.min(r.w, r.h - 0.15) * 0.3;
      const fx = r.x0 + r.w / 2, fy = r.y0 + (r.h - 0.15) / 2;
      dot(fx, fy, fr, '#1a1e24');
      ctx.strokeStyle = tone(th.metal, 0.2);
      ctx.lineWidth = 0.03;
      ctx.beginPath(); ctx.arc(fx, fy, fr, 0, Math.PI * 2); ctx.stroke();
      ctx.strokeStyle = 'rgba(200,210,220,0.3)';
      ctx.lineWidth = 0.04;
      ctx.beginPath();
      for (let k = 0; k < 5; k++) {
        const a = (k / 5) * Math.PI * 2 + hash(r.x0, r.y0, 3);
        ctx.moveTo(fx, fy);
        ctx.quadraticCurveTo(fx + Math.cos(a) * fr * 0.7, fy + Math.sin(a) * fr * 0.7, fx + Math.cos(a + 0.6) * fr * 0.9, fy + Math.sin(a + 0.6) * fr * 0.9);
      }
      ctx.stroke();
      for (const [bx, by] of [[0.14, 0.14], [r.w - 0.14, 0.14], [0.14, r.h - 0.28], [r.w - 0.14, r.h - 0.28]]) dot(r.x0 + bx, r.y0 + by, 0.035, 'rgba(0,0,0,0.5)');
      return;
    }
    // server racks
    shadow();
    fillRR(r.x0 + 0.04, r.y0 + 0.04, r.w - 0.08, r.h - 0.08, 0.05, '#11161c');
    noShadow();
    ctx.strokeStyle = '#3a4656';
    ctx.lineWidth = 0.035;
    ctx.beginPath(); rrect(ctx, r.x0 + 0.04, r.y0 + 0.04, r.w - 0.08, r.h - 0.08, 0.05); ctx.stroke();
    for (const [x, y] of cells) {
      ctx.fillStyle = '#19212a';
      ctx.fillRect(x + 0.1, y + 0.1, 0.8, 0.8);
      ctx.strokeStyle = 'rgba(140,160,180,0.22)';
      ctx.lineWidth = 0.025;
      ctx.beginPath();
      for (let k = 1; k < 5; k++) { ctx.moveTo(x + 0.14, y + 0.1 + k * 0.16); ctx.lineTo(x + 0.86, y + 0.1 + k * 0.16); }
      ctx.stroke();
      if (S >= 16) for (let k = 0; k < 4; k++) dot(x + 0.62 + (k % 2) * 0.1, y + 0.34 + Math.floor(k / 2) * 0.32, 0.018, 'rgba(0,0,0,0.6)');
      ctx.fillStyle = 'rgba(0,0,0,0.55)';
      ctx.fillRect(x + 0.04, y + 0.96, 0.92, 0.04);
    }
    ctx.strokeStyle = rgba(th.glow, 0.25);
    ctx.lineWidth = 0.025;
    ctx.beginPath(); ctx.moveTo(r.x0 + 0.1, r.y0 + 0.07); ctx.lineTo(r.x0 + r.w - 0.1, r.y0 + 0.07); ctx.stroke();
  };

  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const ch = T(x, y);
      if (ch === 'c') crate(x, y);
      else if (ch === '=') counterCell(x, y);
      else if (ch === 'o') {
        shadow(0.18, 0.08);
        const g = ctx.createRadialGradient(x + 0.4, y + 0.38, 0.05, x + 0.5, y + 0.5, 0.4);
        g.addColorStop(0, '#9aa6b6'); g.addColorStop(1, th.wall);
        ctx.fillStyle = g;
        ctx.beginPath(); ctx.arc(x + 0.5, y + 0.5, 0.38, 0, Math.PI * 2); ctx.fill();
        noShadow();
        ctx.strokeStyle = rgba(th.glow, 0.5);
        ctx.lineWidth = 0.04;
        ctx.stroke();
      }
    }
  for (const r of rects.T) table(r);
  for (const r of rects.b) (r.w >= 2 && r.h >= 2 ? bed : sofa)(r);
  for (const r of rects.v) vehicle(r);
  for (const r of rects.m) machine(r);

  // ---- trees on top of their neighbours
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      if (T(x, y) !== 't') continue;
      const ox = x + 0.5 + (hash(x, y, 1) - 0.5) * 0.2, oy = y + 0.5 + (hash(x, y, 2) - 0.5) * 0.2;
      shadow(0.3, 0.12, 0.6);
      dot(ox, oy, 0.55, '#163620');
      noShadow();
      for (let k = 0; k < 6; k++) {
        const a = (k / 6) * Math.PI * 2 + hash(x, y, 3) * 2;
        dot(ox + Math.cos(a) * 0.3, oy + Math.sin(a) * 0.3, 0.24 + hash(x, y, k + 4) * 0.08, k % 2 ? '#1d4527' : '#21502c');
      }
      dot(ox - 0.08, oy - 0.08, 0.26, '#2a6236');
      dot(ox - 0.14, oy - 0.16, 0.12, 'rgba(120,220,140,0.22)');
    }

  // -------------------------------------------------------------------------
  // Walls: top bevel + glowing faces toward open cells (signature neon look)
  // -------------------------------------------------------------------------
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      if (T(x, y) !== '#') continue;
      ctx.fillStyle = th.wall;
      ctx.fillRect(x, y, 1 + px, 1 + px);
      ctx.fillStyle = th.wallTop;
      const l = T(x - 1, y) === '#' ? 0 : 0.12, r = T(x + 1, y) === '#' ? 0 : 0.12, t = T(x, y - 1) === '#' ? 0 : 0.12, b = T(x, y + 1) === '#' ? 0 : 0.12;
      ctx.fillRect(x + l, y + t, 1 - l - r + px, 1 - t - b + px);
      ctx.strokeStyle = 'rgba(255,255,255,0.035)';
      ctx.lineWidth = 0.03;
      ctx.beginPath();
      for (let k = -1; k < 3; k++) { ctx.moveTo(x + k * 0.5, y + 1); ctx.lineTo(x + k * 0.5 + 1, y); }
      ctx.save();
      ctx.beginPath(); ctx.rect(x + l, y + t, 1 - l - r, 1 - t - b); ctx.clip();
      ctx.beginPath();
      for (let k = -1; k < 3; k++) { ctx.moveTo(x + k * 0.5, y + 1); ctx.lineTo(x + k * 0.5 + 1, y); }
      ctx.stroke();
      ctx.restore();
    }
  const faces = new Path2D();
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      if (T(x, y) !== '#') continue;
      if (OPEN_FOR_GLOW(T(x, y - 1))) { faces.moveTo(x, y); faces.lineTo(x + 1, y); }
      if (OPEN_FOR_GLOW(T(x, y + 1))) { faces.moveTo(x, y + 1); faces.lineTo(x + 1, y + 1); }
      if (OPEN_FOR_GLOW(T(x - 1, y))) { faces.moveTo(x, y); faces.lineTo(x, y + 1); }
      if (OPEN_FOR_GLOW(T(x + 1, y))) { faces.moveTo(x + 1, y); faces.lineTo(x + 1, y + 1); }
    }
  ctx.save();
  ctx.lineCap = 'square';
  ctx.shadowColor = th.glow;
  ctx.shadowBlur = Math.max(2, S * 0.35);
  ctx.strokeStyle = rgba(th.glow, 0.55);
  ctx.lineWidth = 0.08;
  ctx.stroke(faces);
  ctx.shadowBlur = 0;
  ctx.strokeStyle = rgba(th.glow, 0.9);
  ctx.lineWidth = Math.max(px, 0.03);
  ctx.stroke(faces);
  ctx.restore();

  // ---- windows: dark sill, glass panes with mullions, cyan glow
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      if (T(x, y) !== 'W') continue;
      const solid = (c) => c === '#' || c === 'W' || c === 'D' || c === 'o' || c === 'm';
      const hz = (solid(T(x - 1, y)) ? 1 : 0) + (solid(T(x + 1, y)) ? 1 : 0) >= (solid(T(x, y - 1)) ? 1 : 0) + (solid(T(x, y + 1)) ? 1 : 0);
      ctx.save();
      ctx.translate(x + 0.5, y + 0.5);
      if (!hz) ctx.rotate(Math.PI / 2);
      ctx.fillStyle = th.wall;
      ctx.fillRect(-0.5, -0.2, 1 + px, 0.4);
      ctx.fillStyle = 'rgba(92,200,255,0.2)';
      ctx.fillRect(-0.5, -0.1, 1 + px, 0.2);
      ctx.shadowColor = '#5cc8ff';
      ctx.shadowBlur = S * 0.25;
      ctx.strokeStyle = '#7fd8ff';
      ctx.lineWidth = 0.05;
      ctx.beginPath(); ctx.moveTo(-0.5, 0); ctx.lineTo(0.5, 0); ctx.stroke();
      ctx.shadowBlur = 0;
      ctx.fillStyle = th.wallTop;
      ctx.fillRect(-0.04, -0.14, 0.08, 0.28);
      ctx.strokeStyle = 'rgba(255,255,255,0.35)';
      ctx.lineWidth = 0.02;
      ctx.beginPath(); ctx.moveTo(-0.38, -0.06); ctx.lineTo(-0.2, -0.06); ctx.moveTo(0.12, -0.06); ctx.lineTo(0.26, -0.06); ctx.stroke();
      ctx.restore();
    }

  ctx.restore();
  return machinery;
}
