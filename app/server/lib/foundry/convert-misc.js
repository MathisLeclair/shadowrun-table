// Foundry journals → markdown documents, playlists → audio tracks.
import { htmlToMarkdown } from './html2md.js';
import { slug } from '../../../shared/util.js';

/** Windows-safe file name part. */
export function fileSafe(s) {
  return String(s || '')
    .replace(/[<>:"/\\|?*\u0000-\u001f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '')
    .slice(0, 90) || 'Sans titre';
}

/**
 * Convert journals. ctx: { folderPath(id), asset(src, kind), links }
 * Returns { docs: [{ file, title, folder, foundryId, content, pages }], pdfs: [{ title, folder, path }], index }.
 * PDF-only entries (rule books) are skipped and listed in the index.
 */
export function convertJournals(journals, ctx = {}) {
  const docs = [];
  const pdfs = [];
  const used = new Set();
  const sorted = [...(journals || [])].sort((a, b) => String(ctx.folderPath?.(a.folder) || '').localeCompare(String(ctx.folderPath?.(b.folder) || '')) || String(a.name).localeCompare(String(b.name)));
  for (const j of sorted) {
    const folder = ctx.folderPath ? ctx.folderPath(j.folder) : '';
    const pages = (j.pages || []).slice().sort((a, b) => (a.sort || 0) - (b.sort || 0));
    const pdfPages = pages.filter((p) => p.type === 'pdf');
    const contentPages = pages.filter((p) => p.type !== 'pdf');
    for (const p of pdfPages) pdfs.push({ title: j.name, page: p.name, folder, path: decodeSafe(p.src || '') });
    if (!contentPages.length) continue;
    const parts = [];
    for (const p of contentPages) {
      const multi = contentPages.length > 1;
      if (p.type === 'text') {
        let body = htmlToMarkdown(p.text?.content || '', { links: ctx.links, mapImage: (src) => (ctx.asset ? ctx.asset(src, 'journal') : src), shiftHeadings: multi ? 1 : 0 });
        if (p.text?.markdown && !body) body = p.text.markdown;
        if (multi) parts.push(`## ${p.name}`);
        if (body) parts.push(body);
      } else if (p.type === 'image') {
        const url = ctx.asset ? ctx.asset(p.src, 'journal') : p.src;
        if (multi || p.name !== j.name) parts.push(`## ${p.name}`);
        parts.push(url ? `![${p.name}](${url})` : `*(image introuvable : ${decodeSafe(p.src)})*`);
        if (p.image?.caption) parts.push(`*${p.image.caption}*`);
      } else if (p.type === 'video') {
        parts.push(`## ${p.name}`, `Vidéo : ${decodeSafe(p.src)}`);
      }
    }
    const content = parts.join('\n\n').trim();
    const hasTitle = /^#\s/.test(content);
    const header = `${hasTitle ? '' : `# ${j.name}\n\n`}`;
    const footer = `\n\n---\n*Importé de Foundry VTT${folder ? ` — dossier « ${folder} »` : ''}.*\n`;
    let file = `${fileSafe(folder ? `${folder.split('/').join(' - ')} - ${j.name}` : j.name)}.md`;
    if (used.has(file.toLowerCase())) {
      let i = 2;
      while (used.has(file.replace(/\.md$/, ` (${i}).md`).toLowerCase())) i++;
      file = file.replace(/\.md$/, ` (${i}).md`);
    }
    used.add(file.toLowerCase());
    docs.push({ file, title: j.name, folder, foundryId: j._id, content: header + content + footer, pages: contentPages.length });
  }
  const lines = ['# Journaux Foundry', '', `Importés du monde Foundry${ctx.worldTitle ? ` « ${ctx.worldTitle} »` : ''}. Relance l'import (Réglages → Foundry VTT) pour les mettre à jour.`, ''];
  let lastFolder = null;
  for (const d of docs) {
    if (d.folder !== lastFolder) {
      lines.push('', `## ${d.folder || 'Sans dossier'}`, '');
      lastFolder = d.folder;
    }
    lines.push(`- **${d.title}** — \`foundry/${d.file}\``);
  }
  if (pdfs.length) {
    lines.push('', '## Livres de règles (PDF, non importés)', '', 'Ces entrées pointent vers des PDF du dossier Foundry ; ouvre-les directement :', '');
    for (const p of pdfs) lines.push(`- **${p.title}**${p.page && p.page !== p.title && p.page !== 'PDF' ? ` (${p.page})` : ''} — \`${p.path}\``);
  }
  return { docs, pdfs, index: lines.join('\n') + '\n' };
}

function decodeSafe(s) {
  try {
    return decodeURIComponent(String(s || ''));
  } catch {
    return String(s || '');
  }
}

function playlistKind(p) {
  const n = String(p.name || '').toLowerCase();
  if (/sfx|effet|bruitage|sound ?fx/.test(n) || p.mode === -1) return 'sfx';
  if (/ambien|atmos|rain|pluie|city|ville|nature|wind/.test(n)) return 'ambient';
  return 'music';
}

/** Playlists → [{ playlist, kind, tracks: [track] }]. Track = audio module schema + volume/loop. */
export function convertPlaylists(playlists, ctx = {}) {
  const out = [];
  for (const p of playlists || []) {
    const sounds = (p.sounds || []).filter((s) => s && s.path);
    if (!sounds.length) continue;
    const kind = playlistKind(p);
    const seen = new Set();
    const tracks = [];
    for (const s of sounds) {
      const url = ctx.asset ? ctx.asset(s.path, 'audio', '', slug(p.name) || 'playlist') : s.path;
      if (!url || seen.has(url)) continue;
      seen.add(url);
      const track = {
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
