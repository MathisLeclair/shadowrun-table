// Square crop geometry for the portrait crop dialog (ImageCrop.tsx). Pure: no DOM, tested by tools/test-crop.ts.
//
// The image is drawn inside a square frame of `frame` display pixels, scaled by `cover × zoom` where `cover` makes its
// short side fill the frame (zoom 1 = the largest square that fits). `ox` / `oy` place the image's top-left corner
// relative to the frame's (always ≤ 0: the image keeps covering the frame).

export interface CropImage {
  /** Natural size of the image, in pixels. */
  w: number;
  h: number;
}
export interface CropView {
  zoom: number;
  ox: number;
  oy: number;
}
/** Part of the source image kept, in its own pixels. */
export interface CropRect {
  sx: number;
  sy: number;
  size: number;
}

export const MIN_ZOOM = 1;
export const MAX_ZOOM = 8;
/** Side of the saved portrait (px): sharp at every size the app shows (avatars ≤ 150 px, tokens, hi-DPI screens). */
export const OUTPUT_SIZE = 512;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Display scale at zoom 1: the image's short side fills the frame. */
export function coverScale(img: CropImage, frame: number): number {
  return frame / Math.max(1, Math.min(img.w, img.h));
}

/** Display scale of a view. */
export function viewScale(img: CropImage, frame: number, view: Pick<CropView, 'zoom'>): number {
  return coverScale(img, frame) * clamp(view.zoom, MIN_ZOOM, MAX_ZOOM);
}

/** A view kept valid: zoom within bounds, the image still covering the whole frame. */
export function clampView(img: CropImage, frame: number, view: CropView): CropView {
  const zoom = clamp(Number.isFinite(view.zoom) ? view.zoom : MIN_ZOOM, MIN_ZOOM, MAX_ZOOM);
  const s = coverScale(img, frame) * zoom;
  return {
    zoom,
    ox: clamp(Number.isFinite(view.ox) ? view.ox : 0, frame - img.w * s, 0),
    oy: clamp(Number.isFinite(view.oy) ? view.oy : 0, frame - img.h * s, 0),
  };
}

/** Starting view: zoom 1, centred. */
export function initialView(img: CropImage, frame: number): CropView {
  const s = coverScale(img, frame);
  return clampView(img, frame, { zoom: MIN_ZOOM, ox: (frame - img.w * s) / 2, oy: (frame - img.h * s) / 2 });
}

/** The view moved by (dx, dy) display pixels (a drag), clamped. */
export function panView(img: CropImage, frame: number, view: CropView, dx: number, dy: number): CropView {
  return clampView(img, frame, { ...view, ox: view.ox + dx, oy: view.oy + dy });
}

/**
 * The view zoomed to `zoom`, keeping the image point under (px, py) (frame coordinates, default: the centre) in place,
 * as a mouse wheel does.
 */
export function zoomView(img: CropImage, frame: number, view: CropView, zoom: number, px = frame / 2, py = frame / 2): CropView {
  const s = viewScale(img, frame, view);
  const z = clamp(zoom, MIN_ZOOM, MAX_ZOOM);
  const s2 = coverScale(img, frame) * z;
  const u = (px - view.ox) / s;
  const v = (py - view.oy) / s;
  return clampView(img, frame, { zoom: z, ox: px - u * s2, oy: py - v * s2 });
}

/** Source square kept by a view (whole pixels, inside the image). */
export function cropRect(img: CropImage, frame: number, view: CropView): CropRect {
  const v = clampView(img, frame, view);
  const s = viewScale(img, frame, v);
  const size = Math.max(1, Math.min(img.w, img.h, Math.round(frame / s)));
  return {
    sx: clamp(Math.round(-v.ox / s), 0, img.w - size),
    sy: clamp(Math.round(-v.oy / s), 0, img.h - size),
    size,
  };
}

/** Side of the saved image: OUTPUT_SIZE, or the crop's own size when smaller (no upscaling of small pictures). */
export function outputSize(rect: CropRect): number {
  return Math.max(1, Math.min(OUTPUT_SIZE, rect.size));
}
