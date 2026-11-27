// City map (« Seattle » tab): districts as polygons in cells, where a lifestyle's home is, and the security rating the
// source gives. Pure: used by the server (72-city.ts, 40-shop.ts shop/move), the client and tools/test-city.ts.
// District shapes are traced from the map image by tools/city-districts.ts into data/city/<id>.json.
import type { CityDistrict, CitySecurity, LifestylePlace, SecurityRating } from './types.ts';

type Pt = readonly [number, number];
type RingsLike = { rings: ReadonlyArray<ReadonlyArray<Pt>> };

/** Even-odd test over all rings: islands add, a ring inside another is a hole (lakes). */
export function inRings(rings: ReadonlyArray<ReadonlyArray<Pt>>, x: number, y: number): boolean {
  let inside = false;
  for (const r of rings) {
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
      const [xi, yi] = r[i], [xj, yj] = r[j];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
  }
  return inside;
}

/** District under a point (cells), or null (water, outside the city). */
export function districtAt<D extends RingsLike>(districts: readonly D[] | null | undefined, x: number, y: number): D | null {
  for (const d of districts || []) if (inRings(d.rings, x, y)) return d;
  return null;
}

/** Bounding box (cells). */
export function districtBBox(d: RingsLike): { x: number; y: number; w: number; h: number } {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const r of d.rings) for (const [x, y] of r) {
    if (x < x0) x0 = x;
    if (y < y0) y0 = y;
    if (x > x1) x1 = x;
    if (y > y1) y1 = y;
  }
  if (!Number.isFinite(x0)) return { x: 0, y: 0, w: 0, h: 0 };
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

const ringArea = (r: ReadonlyArray<Pt>) => {
  let a = 0;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += r[j][0] * r[i][1] - r[i][0] * r[j][1];
  return a / 2;
};

/** A point inside the district where its name can go: centroid of the largest ring, or the inside point nearest to it. */
export function districtLabelAt(d: RingsLike): { x: number; y: number } {
  let big: ReadonlyArray<Pt> | null = null, ba = 0;
  for (const r of d.rings) {
    const a = Math.abs(ringArea(r));
    if (a > ba) {
      ba = a;
      big = r;
    }
  }
  if (!big) return { x: 0, y: 0 };
  let cx = 0, cy = 0, a6 = 0;
  for (let i = 0, j = big.length - 1; i < big.length; j = i++) {
    const f = big[j][0] * big[i][1] - big[i][0] * big[j][1];
    cx += (big[j][0] + big[i][0]) * f;
    cy += (big[j][1] + big[i][1]) * f;
    a6 += f * 3;
  }
  const c = a6 ? { x: cx / a6, y: cy / a6 } : { x: big[0][0], y: big[0][1] };
  if (inRings(d.rings, c.x, c.y)) return c;
  // concave shape: nearest inside point on a half-cell grid, preferring points away from the edge
  const bb = districtBBox({ rings: [big] });
  let best = { x: big[0][0], y: big[0][1] }, bd = Infinity;
  for (let y = bb.y + 0.25; y < bb.y + bb.h; y += 0.5) for (let x = bb.x + 0.25; x < bb.x + bb.w; x += 0.5) {
    if (!inRings(d.rings, x, y) || !inRings(d.rings, x + 1.5, y) || !inRings(d.rings, x - 1.5, y)) continue;
    const dd = (x - c.x) ** 2 + (y - c.y) ** 2;
    if (dd < bd) {
      bd = dd;
      best = { x, y };
    }
  }
  return best;
}

const num = (v: unknown, lo: number, hi: number): number | null => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(Math.max(lo, Math.min(hi, n)) * 100) / 100 : null;
};

/**
 * Clean a stored place (GM edits, imports): numbers clamped, district kept as a short id, guests as actor ids.
 * Returns null when there is no usable point. The district is recomputed by placeAt() on every move.
 */
export function sanitizePlace(input: unknown, size: { width: number; height: number } = { width: 10000, height: 10000 }): LifestylePlace | null {
  if (!input || typeof input !== 'object') return null;
  const p = input as Record<string, unknown>;
  const x = num(p.x, 0, size.width), y = num(p.y, 0, size.height);
  if (x === null || y === null) return null;
  const out: LifestylePlace = {
    x,
    y,
    district: typeof p.district === 'string' && p.district ? p.district.slice(0, 40) : null,
    at: Number(p.at) > 0 ? Number(p.at) : 0,
  };
  if (Array.isArray(p.guests)) {
    const guests = [...new Set(p.guests.filter((g): g is string => typeof g === 'string' && !!g).map((g) => g.slice(0, 80)))].slice(0, 40);
    if (guests.length) out.guests = guests;
  }
  return out;
}

/** A new place at (x, y) on a city map: clamped to the map, district computed from the shapes (never from the client). */
export function placeAt(city: { width: number; height: number; districts: readonly CityDistrict[] }, x: unknown, y: unknown, at: number): LifestylePlace | null {
  const px = num(x, 0, city.width), py = num(y, 0, city.height);
  if (px === null || py === null) return null;
  return { x: px, y: py, district: districtAt(city.districts, px, py)?.id || null, at };
}

/** Same spot (to the cell)? A move to the same place is refused. */
export const samePlace = (a: Pick<LifestylePlace, 'x' | 'y'> | null | undefined, b: Pick<LifestylePlace, 'x' | 'y'> | null | undefined): boolean =>
  !!a && !!b && Math.floor(a.x) === Math.floor(b.x) && Math.floor(a.y) === Math.floor(b.y);

const fold = (s: unknown) =>
  String(s ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

/**
 * District named in a lifestyle's name or notes (« Seattle Downtown Outskirts » → downtown, « Studio à Renton » → renton),
 * to preselect it when placing the home. Longest district name found wins; null when none.
 */
export function guessDistrict(text: unknown, districts: readonly Pick<CityDistrict, 'id' | 'name'>[]): string | null {
  const hay = ` ${fold(text)} `;
  let best: string | null = null, bl = 0;
  for (const d of districts) {
    for (const n of [d.name, d.id.replace(/-/g, ' ')]) {
      const f = fold(n).replace(/\bft\b/, 'fort');
      const variants = [f, fold(n)];
      for (const v of variants) {
        if (v && hay.includes(` ${v} `) && v.length > bl) {
          bl = v.length;
          best = d.id;
        }
      }
    }
  }
  return best;
}

/**
 * HTR team response time per rating (SR5 p. 352, « HTR Team Response Time »). The table rates kinds of areas: AAA
 * (Downtown Seattle, megacorp HQ, military installation), AA luxury residential, A mid- to high-level residential,
 * B mid-level residential / industrial, C low-end residential / storage, Z (Redmond Barrens, Chicago Containment Zone).
 */
export const HTR_RESPONSE: Record<SecurityRating, string> = { AAA: '1D6 min', AA: '1D6+4 min', A: '2D6+3 min', B: '1D6×5 min', C: '1D6×10 min', Z: '2D6 h' };
export const HTR_REF = { source: 'SR5', page: 352 } as const;

/** Rating of the housing type of a lifestyle level (same table). Squatter / Street / others: none (the table has no row). */
const RATING_BY_BASE: Record<string, SecurityRating> = { Luxury: 'AA', High: 'A', Medium: 'B', Low: 'C' };
export function homeSecurity(base: unknown): SecurityRating | null {
  return RATING_BY_BASE[String(base ?? '')] || null;
}

/** Ratings the source gives for parts of a district (Downtown: AAA, Redmond: Redmond Barrens Z). */
export const districtSecurity = (d: Pick<CityDistrict, 'security'> | null | undefined): CitySecurity[] => d?.security || [];
