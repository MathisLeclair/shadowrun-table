// Portrait crop dialog: a square frame (round guide = the map token) over the picked image; drag to move, wheel /
// slider / keys to zoom. Saves a square WebP (PNG where the browser can't encode WebP) of at most 512 px.
// usePortraitCrop() wires it to a file input and the uploads: sheet header, chargen Concept step, NPC template editor.
import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react';
import { Button, Modal } from './ui.tsx';
import { t } from './i18n.ts';
import { toast } from './ui-store.ts';
import { upload } from './net.ts';
import { cropRect, initialView, MAX_ZOOM, MIN_ZOOM, outputSize, panView, viewScale, zoomView, type CropImage, type CropView } from './crop.ts';
import './image-crop.css';

/** Side of the crop frame on screen (px). */
const FRAME = 300;

/** What the dialog returns: the cropped square, or 'original' (« Keep original »: the file as picked, an animated GIF…). */
export type CropResult = Blob | 'original';

interface CropDialogProps {
  /** Image to crop: an object URL of a picked file, or the current portrait's URL. */
  src: string;
  /** Offer « Keep original » (a freshly picked file). */
  allowOriginal?: boolean;
  busy?: boolean;
  onCancel: () => void;
  onDone: (result: CropResult) => void;
}

/** Encode a canvas: WebP, else PNG (Safari cannot encode WebP and silently returns PNG). */
function encode(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => {
      if (b && b.type === 'image/webp') return resolve(b);
      canvas.toBlob((p) => (p ? resolve(p) : reject(new Error(t('Could not save the cropped image')))), 'image/png');
    }, 'image/webp', 0.9);
  });
}

export function CropDialog({ src, allowOriginal, busy, onCancel, onDone }: CropDialogProps) {
  const imgRef = useRef<HTMLImageElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const [img, setImg] = useState<CropImage | null>(null);
  const [view, setView] = useState<CropView>({ zoom: 1, ox: 0, oy: 0 });
  const [failed, setFailed] = useState(false);
  const drag = useRef<{ id: number; x: number; y: number } | null>(null);
  const live = useRef({ img, view });
  live.current = { img, view };

  // Wheel zoom around the pointer: a native listener, React's onWheel is passive and cannot stop the page scrolling.
  useEffect(() => {
    const el = frameRef.current;
    if (!el) return;
    const wheel = (e: WheelEvent) => {
      const { img: im, view: v } = live.current;
      if (!im) return;
      e.preventDefault();
      const r = el.getBoundingClientRect();
      setView(zoomView(im, FRAME, v, v.zoom * Math.exp(-e.deltaY * 0.0015), e.clientX - r.left, e.clientY - r.top));
    };
    el.addEventListener('wheel', wheel, { passive: false });
    return () => el.removeEventListener('wheel', wheel);
  }, []);

  const loaded = () => {
    const el = imgRef.current;
    if (!el || !el.naturalWidth || !el.naturalHeight) return setFailed(true);
    const im = { w: el.naturalWidth, h: el.naturalHeight };
    setImg(im);
    setView(initialView(im, FRAME));
  };

  const down = (e: PointerEvent<HTMLDivElement>) => {
    if (!img || e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { id: e.pointerId, x: e.clientX, y: e.clientY };
  };
  const move = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!img || !d || d.id !== e.pointerId) return;
    setView((v) => panView(img, FRAME, v, e.clientX - d.x, e.clientY - d.y));
    drag.current = { ...d, x: e.clientX, y: e.clientY };
  };
  const up = (e: PointerEvent<HTMLDivElement>) => {
    if (drag.current?.id === e.pointerId) drag.current = null;
  };
  const key = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!img) return;
    const step = e.shiftKey ? 40 : 10;
    const moves: Record<string, [number, number]> = { ArrowLeft: [step, 0], ArrowRight: [-step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] };
    if (moves[e.key]) setView((v) => panView(img, FRAME, v, ...moves[e.key]));
    else if (e.key === '+' || e.key === '=') setView((v) => zoomView(img, FRAME, v, v.zoom * 1.1));
    else if (e.key === '-') setView((v) => zoomView(img, FRAME, v, v.zoom / 1.1));
    else return;
    e.preventDefault();
  };

  const save = async () => {
    const el = imgRef.current;
    if (!img || !el) return;
    const r = cropRect(img, FRAME, view);
    const size = outputSize(r);
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext('2d');
    if (!ctx) return toast(t('Could not save the cropped image'), 'error');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(el, r.sx, r.sy, r.size, r.size, 0, 0, size, size);
    try {
      onDone(await encode(canvas));
    } catch (err) {
      // A picture from another site without CORS taints the canvas (SecurityError).
      toast((err as Error)?.name === 'SecurityError' ? t('This image comes from another site and cannot be cropped: download it, then upload it here.') : (err as Error).message, 'error');
    }
  };

  const s = img ? viewScale(img, FRAME, view) : 1;
  const sameOrigin = (() => {
    try {
      return new URL(src, location.href).origin === location.origin || /^(blob|data):/.test(src);
    } catch {
      return true;
    }
  })();
  const footer: ReactNode = <div className="crop-actions">
    {allowOriginal && <Button variant="ghost" disabled={busy} onClick={() => onDone('original')} title={t('Upload the file as it is (an animated GIF stays animated)')}>{t('Keep original')}</Button>}
    <span className="grow" />
    <Button disabled={busy} onClick={onCancel}>{t('Cancel')}</Button>
    <Button variant="primary" disabled={!img || busy} onClick={save}>{busy ? t('Uploading…') : t('Use this crop')}</Button>
  </div>;

  return <Modal title={t('Crop the portrait')} width={420} onClose={busy ? undefined : onCancel}>
    <div className="crop">
      <div ref={frameRef} className={'crop-frame' + (img ? '' : ' loading')} style={{ width: FRAME, height: FRAME }} tabIndex={0}
        role="application" aria-label={t('Crop area: drag to move, wheel or + / − to zoom, arrows to nudge')}
        onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} onKeyDown={key}>
        <img ref={imgRef} src={src} alt="" draggable={false} crossOrigin={sameOrigin ? undefined : 'anonymous'} onLoad={loaded} onError={() => setFailed(true)}
          style={img ? { width: img.w * s, height: img.h * s, transform: `translate(${view.ox}px, ${view.oy}px)` } : { visibility: 'hidden' }} />
        <div className="crop-guide" aria-hidden="true" />
        {!img && <div className="crop-msg">{failed ? t('Could not load this image') : t('Loading…')}</div>}
      </div>
      <div className="crop-zoom">
        <span aria-hidden="true">−</span>
        <input type="range" min={MIN_ZOOM} max={MAX_ZOOM} step={0.01} value={view.zoom} disabled={!img} aria-label={t('Zoom')}
          onChange={(e) => img && setView(zoomView(img, FRAME, view, Number(e.target.value)))} />
        <span aria-hidden="true">+</span>
        <Button small variant="ghost" disabled={!img} onClick={() => img && setView(initialView(img, FRAME))}>{t('Reset')}</Button>
      </div>
      <p className="faint small crop-hint">{t('Drag to frame the face; the circle shows the map token. Saved as a square image.')}</p>
      {footer}
    </div>
  </Modal>;
}

/** File name of the cropped upload: the picked file's base name (or « portrait ») with the encoder's extension. */
function cropName(base: string | undefined, blob: Blob): string {
  const stem = String(base || 'portrait').replace(/\.[^.]*$/, '').replace(/[^\w-]+/g, '_').slice(0, 40) || 'portrait';
  return `${stem}-crop.${blob.type === 'image/webp' ? 'webp' : 'png'}`;
}

/**
 * Crop-then-upload for a portrait: `pick(file)` (a file input's file) or `recrop(url)` (the current portrait) opens the
 * dialog; the uploaded URL goes to `onUploaded`. Render `dialog` somewhere in the component.
 */
export function usePortraitCrop(onUploaded: (url: string) => void | Promise<void>) {
  const [job, setJob] = useState<{ src: string; file?: File } | null>(null);
  const [busy, setBusy] = useState(false);
  const close = () => setJob(null);
  // The picked file's object URL lives as long as its dialog.
  useEffect(() => () => {
    if (job?.file) URL.revokeObjectURL(job.src);
  }, [job]);
  const pick = (file: File | null | undefined) => {
    if (!file) return;
    if (!/^image\//.test(file.type)) return toast(t('Choose an image (png, jpg, webp…)'), 'warn');
    setJob({ src: URL.createObjectURL(file), file });
  };
  const recrop = (url: string | null | undefined) => url && setJob({ src: url });
  const done = async (result: CropResult) => {
    if (!job) return;
    setBusy(true);
    try {
      const body = result === 'original' ? job.file : new File([result], cropName(job.file?.name || job.src.split('/').pop(), result), { type: result.type });
      if (body) {
        const { url } = await upload(body);
        await onUploaded(url);
      }
      close();
    } catch (err) {
      toast((err as Error)?.message || t('Upload failed'), 'error');
    } finally {
      setBusy(false);
    }
  };
  const dialog = job ? <CropDialog key={job.src} src={job.src} allowOriginal={!!job.file} busy={busy} onCancel={close} onDone={done} /> : null;
  return { pick, recrop, busy, dialog };
}
