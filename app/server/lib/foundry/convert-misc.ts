// Foundry journals → markdown documents, playlists → audio tracks.
import { htmlToMarkdown } from './html2md.ts';
import { slug } from '../../../shared/util.ts';
import type { FoundryDoc } from './world.ts';
import type { AssetFn } from './assets.ts';
import type { HtmlLinks } from './html2md.ts';
import type { AudioTrack, Lang, TrackKind } from '../../../shared/types.ts';
import { importText } from './convert-actor.ts';

/** Marks an English key for tools/i18n-check.ts. */
const tk = (s: string): string => s;

/** A journal converted to a markdown document. */
export interface JournalDoc {
  file: string;
  title: string;
  folder: string;
  foundryId: string;
  content: string;
  pages: number;
}
/** A PDF page of a journal (rule books: not imported, listed in the index). */
export interface JournalPdf {
  title: string;
  page: string;
  folder: string;
  path: string;
}
/** convertJournals() result. */
export interface ConvertedJournals {
  docs: JournalDoc[];
  pdfs: JournalPdf[];
  index: string;
}
/** A playlist converted to audio tracks. */
export interface ConvertedPlaylist {
  id: string;
  name: string;
  kind: TrackKind;
  mode: unknown;
  tracks: AudioTrack[];
}

/** Windows-safe file name part. */
export function fileSafe(s: unknown): string {
  return String(s || '')
    .replace(/[<>:"/\\|?*\u0000-\u001f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '')
    .slice(0, 90) || 'Sans titre';
}

/**
 * Convert journals. ctx: { folderPath(id), asset(src, kind), links, worldTitle, lang (language of the texts the import adds: footer, index) }
 * The journal content itself is the world's text and stays as written.
 * Returns { docs: [{ file, title, folder, foundryId, content, pages }], pdfs: [{ title, folder, path }], index }.
 * PDF-only entries (rule books) are skipped and listed in the index.
 */
export function convertJournals(
  journals: FoundryDoc[] | null | undefined,
  ctx: { folderPath?: (id: string | null | undefined) => string; asset?: AssetFn; links?: HtmlLinks; worldTitle?: string; lang?: Lang } = {}
): ConvertedJournals {
  const { tr } = importText(ctx.lang);
  const docs: JournalDoc[] = [];
  const pdfs: JournalPdf[] = [];
  const used = new Set<string>();
  const sorted = [...(journals || [])].sort((a, b) => String(ctx.folderPath?.(a.folder) || '').localeCompare(String(ctx.folderPath?.(b.folder) || '')) || String(a.name).localeCompare(String(b.name)));
  for (const j of sorted) {
    const folder = ctx.folderPath ? ctx.folderPath(j.folder) : '';
    const pages: FoundryDoc[] = (j.pages || []).slice().sort((a: FoundryDoc, b: FoundryDoc) => (a.sort || 0) - (b.sort || 0));
    const pdfPages = pages.filter((p) => p.type === 'pdf');
    const contentPages = pages.filter((p) => p.type !== 'pdf');
    for (const p of pdfPages) pdfs.push({ title: j.name, page: p.name, folder, path: decodeSafe(p.src || '') });
    if (!contentPages.length) continue;
    const parts: string[] = [];
    for (const p of contentPages) {
      const multi = contentPages.length > 1;
      if (p.type === 'text') {
        let body = htmlToMarkdown(p.text?.content || '', { links: ctx.links, mapImage: (src: string) => (ctx.asset ? ctx.asset(src, 'journal') : src), shiftHeadings: multi ? 1 : 0 });
        if (p.text?.markdown && !body) body = p.text.markdown;
        if (multi) parts.push(`## ${p.name}`);
        if (body) parts.push(body);
      } else if (p.type === 'image') {
        const url = ctx.asset ? ctx.asset(p.src, 'journal') : p.src;
        if (multi || p.name !== j.name) parts.push(`## ${p.name}`);
        parts.push(url ? `![${p.name}](${url})` : `*(${tr(tk('image not found: {src}'), { src: decodeSafe(p.src) })})*`);
        if (p.image?.caption) parts.push(`*${p.image.caption}*`);
      } else if (p.type === 'video') {
        parts.push(`## ${p.name}`, tr(tk('Video: {src}'), { src: decodeSafe(p.src) }));
      }
    }
    const content = parts.join('\n\n').trim();
    const hasTitle = /^#\s/.test(content);
    const header = `${hasTitle ? '' : `# ${j.name}\n\n`}`;
    const footer = `\n\n---\n*${folder ? tr(tk('Imported from Foundry VTT — folder “{folder}”.'), { folder }) : tr(tk('Imported from Foundry VTT.'))}*\n`;
    let file = `${fileSafe(folder ? `${folder.split('/').join(' - ')} - ${j.name}` : j.name)}.md`;
    if (used.has(file.toLowerCase())) {
      let i = 2;
      while (used.has(file.replace(/\.md$/, ` (${i}).md`).toLowerCase())) i++;
      file = file.replace(/\.md$/, ` (${i}).md`);
    }
    used.add(file.toLowerCase());
    docs.push({ file, title: j.name, folder, foundryId: j._id, content: header + content + footer, pages: contentPages.length });
  }
  const intro = ctx.worldTitle
    ? tr(tk('Imported from the Foundry world “{world}”. Run the import again (Settings → Foundry VTT) to update them.'), { world: ctx.worldTitle })
    : tr(tk('Imported from the Foundry world. Run the import again (Settings → Foundry VTT) to update them.'));
  const lines = [`# ${tr(tk('Foundry journals'))}`, '', intro, ''];
  let lastFolder: string | null = null;
  for (const d of docs) {
    if (d.folder !== lastFolder) {
      lines.push('', `## ${d.folder || tr(tk('No folder'))}`, '');
      lastFolder = d.folder;
    }
    lines.push(`- **${d.title}** — \`foundry/${d.file}\``);
  }
  if (pdfs.length) {
    lines.push('', `## ${tr(tk('Rulebooks (PDF, not imported)'))}`, '', tr(tk('These entries point to PDFs in the Foundry folder; open them directly:')), '');
    for (const p of pdfs) lines.push(`- **${p.title}**${p.page && p.page !== p.title && p.page !== 'PDF' ? ` (${p.page})` : ''} — \`${p.path}\``);
  }
  return { docs, pdfs, index: lines.join('\n') + '\n' };
}

function decodeSafe(s: unknown): string {
  try {
    return decodeURIComponent(String(s || ''));
  } catch {
    return String(s || '');
  }
}

function playlistKind(p: FoundryDoc): TrackKind {
  const n = String(p.name || '').toLowerCase();
  if (/sfx|effet|bruitage|sound ?fx/.test(n) || p.mode === -1) return 'sfx';
  if (/ambien|atmos|rain|pluie|city|ville|nature|wind/.test(n)) return 'ambient';
  return 'music';
}

/** Playlists → [{ playlist, kind, tracks: [track] }]. Track = audio module schema + volume/loop. */
export function convertPlaylists(playlists: FoundryDoc[] | null | undefined, ctx: { asset?: AssetFn } = {}): ConvertedPlaylist[] {
  const out: ConvertedPlaylist[] = [];
  for (const p of playlists || []) {
    const sounds: FoundryDoc[] = (p.sounds || []).filter((s: FoundryDoc | null) => s && s.path);
    if (!sounds.length) continue;
    const kind = playlistKind(p);
    const seen = new Set<string>();
    const tracks: AudioTrack[] = [];
    for (const s of sounds) {
      const url = ctx.asset ? ctx.asset(s.path, 'audio', '', slug(p.name) || 'playlist') : s.path;
      if (!url || seen.has(url)) continue;
      seen.add(url);
      const track: AudioTrack = {
        id: `trk_fvtt_${s._id}`,
        name: String(s.name || 'Piste').slice(0, 120),
        kind: kind === 'music' && s.repeat && /ambien/i.test(s.name || '') ? 'ambient' : kind,
        source: 'url',
        url,
        tags: ['Foundry', p.name].filter(Boolean),
        volume: Math.round(Math.max(0, Math.min(1, Number(s.volume ?? 0.5))) * 100) / 100,
        loop: !!s.repeat || kind === 'ambient',
      };
      tracks.push(track);
    }
    out.push({ id: p._id, name: p.name, kind, mode: p.mode, tracks });
  }
  return out;
}
