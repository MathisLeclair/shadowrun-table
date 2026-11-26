// Streaming ZIP reader/writer (no dependency, constant memory): big Foundry worlds and table backups never sit in RAM.
// Reader: central directory + ZIP64, stored/deflate entries, CRC check, UTF-8 / CP437 / Info-ZIP unicode names,
//         zip-slip safe extraction (the whole archive is rejected on a dangerous path).
// Writer: stored or deflated entries with known sizes (no data descriptors), up to 4 GB.
// Also: receiveToFile() streams an HTTP request body to disk with a size cap.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export class ZipError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

const SIG_EOCD = 0x06054b50;
const SIG_EOCD64 = 0x06064b50;
const SIG_EOCD64_LOC = 0x07064b50;
const SIG_CEN = 0x02014b50;
const SIG_LOC = 0x04034b50;
const U32 = 0xffffffff;

// CP437 upper half (names of entries without the UTF-8 flag, e.g. old Windows "compressed folders").
const CP437 = 'ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ ';
function decodeName(buf, utf8) {
  if (utf8) return buf.toString('utf8');
  let s = '';
  for (const b of buf) s += b < 128 ? String.fromCharCode(b) : CP437[b - 128];
  return s;
}

function readAt(fd, pos, len) {
  const buf = Buffer.alloc(len);
  let off = 0;
  while (off < len) {
    const n = fs.readSync(fd, buf, off, len - off, pos + off);
    if (!n) break;
    off += n;
  }
  return off === len ? buf : buf.subarray(0, off);
}
const u64 = (buf, off) => Number(buf.readBigUInt64LE(off));

/**
 * Read the central directory of a zip file. Returns [{ name, method, flags, crc, compSize, size, localOffset, isDir, isLink }].
 * Throws ZipError on a damaged / unsupported archive.
 */
export function listZip(file, { maxEntries = 200000 } = {}) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    if (size < 22) throw new ZipError('Archive ZIP invalide (fichier trop court)');
    const tailLen = Math.min(size, 22 + 0xffff);
    const tail = readAt(fd, size - tailLen, tailLen);
    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === SIG_EOCD) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) throw new ZipError('Archive ZIP invalide (fin de répertoire introuvable)');
    let count = tail.readUInt16LE(eocd + 10);
    let cdSize = tail.readUInt32LE(eocd + 12);
    let cdOffset = tail.readUInt32LE(eocd + 16);
    if (count === 0xffff || cdSize === U32 || cdOffset === U32) {
      const locPos = size - tailLen + eocd - 20;
      const loc = locPos >= 0 ? readAt(fd, locPos, 20) : null;
      if (!loc || loc.readUInt32LE(0) !== SIG_EOCD64_LOC) throw new ZipError('Archive ZIP64 invalide');
      const e64 = readAt(fd, u64(loc, 8), 56);
      if (e64.readUInt32LE(0) !== SIG_EOCD64) throw new ZipError('Archive ZIP64 invalide');
      count = u64(e64, 32);
      cdSize = u64(e64, 40);
      cdOffset = u64(e64, 48);
    }
    if (count > maxEntries) throw new ZipError(`Archive trop volumineuse (${count} fichiers, ${maxEntries} max)`);
    if (cdOffset + cdSize > size) throw new ZipError('Archive ZIP tronquée (envoi interrompu ?)');
    const cd = readAt(fd, cdOffset, cdSize);
    const entries = [];
    let p = 0;
    for (let i = 0; i < count; i++) {
      if (p + 46 > cd.length || cd.readUInt32LE(p) !== SIG_CEN) throw new ZipError('Répertoire ZIP endommagé');
      const flags = cd.readUInt16LE(p + 8);
      const method = cd.readUInt16LE(p + 10);
      const crc = cd.readUInt32LE(p + 16);
      let compSize = cd.readUInt32LE(p + 20);
      let usize = cd.readUInt32LE(p + 24);
      const nameLen = cd.readUInt16LE(p + 28);
      const extraLen = cd.readUInt16LE(p + 30);
      const commentLen = cd.readUInt16LE(p + 32);
      const madeBy = cd.readUInt16LE(p + 4) >> 8;
      const extAttr = cd.readUInt32LE(p + 38);
      let localOffset = cd.readUInt32LE(p + 42);
      const nameBuf = cd.subarray(p + 46, p + 46 + nameLen);
      let name = decodeName(nameBuf, !!(flags & 0x800));
      const extra = cd.subarray(p + 46 + nameLen, p + 46 + nameLen + extraLen);
      for (let x = 0; x + 4 <= extra.length; ) {
        const id = extra.readUInt16LE(x);
        const len = extra.readUInt16LE(x + 2);
        const body = extra.subarray(x + 4, x + 4 + len);
        if (id === 0x0001) {
          let q = 0;
          if (usize === U32 && q + 8 <= body.length) (usize = u64(body, q)), (q += 8);
          if (compSize === U32 && q + 8 <= body.length) (compSize = u64(body, q)), (q += 8);
          if (localOffset === U32 && q + 8 <= body.length) (localOffset = u64(body, q)), (q += 8);
        } else if (id === 0x7075 && body.length > 5 && body[0] === 1) {
          // Info-ZIP Unicode Path: valid only if it was made from this very name.
          if ((zlib.crc32(nameBuf) >>> 0) === body.readUInt32LE(1)) name = body.subarray(5).toString('utf8');
        }
        x += 4 + len;
      }
      const unixMode = madeBy === 3 ? extAttr >>> 16 : 0;
      entries.push({
        name, method, flags, crc: crc >>> 0, compSize, size: usize, localOffset,
        isDir: name.endsWith('/') || name.endsWith('\\') || (extAttr & 0x10) === 0x10,
        isLink: (unixMode & 0o170000) === 0o120000,
      });
      p += 46 + nameLen + extraLen + commentLen;
    }
    return entries;
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Normalized relative path of an entry name ('a/b.png'), or null if it is dangerous
 * (absolute, drive letter, '..', NUL, empty segment tricks).
 */
export function safeEntryPath(name) {
  const n = String(name || '').replace(/\\/g, '/');
  if (!n || n.includes('\0')) return null;
  if (n.startsWith('/') || /^[a-zA-Z]:/.test(n)) return null;
  const parts = n.split('/').filter((s) => s !== '' && s !== '.');
  if (!parts.length || parts.some((s) => s === '..')) return null;
  return parts.join('/');
}

function crcCounter(expectedSize, label) {
  let crc = 0;
  let bytes = 0;
  const t = new Transform({
    transform(chunk, _enc, cb) {
      bytes += chunk.length;
      if (bytes > expectedSize) return cb(new ZipError(`Fichier « ${label} » plus gros qu’annoncé dans l’archive (archive piégée ?)`));
      crc = zlib.crc32(chunk, crc);
      cb(null, chunk);
    },
  });
  t.result = () => ({ crc: crc >>> 0, bytes });
  return t;
}

/**
 * Extract a zip into destDir. Options:
 *   map(relPath) → new relative path, or null to skip the entry (default: identity)
 *   maxTotal: max sum of uncompressed sizes (default 8 GB) · onProgress({ done, total, bytes })
 * Rejects the WHOLE archive (before writing anything) if any entry path is dangerous.
 * Returns { files, bytes, skipped }.
 */
export async function extractZip(file, destDir, { map = (p) => p, maxTotal = 8e9, onProgress } = {}) {
  const entries = listZip(file);
  const root = path.resolve(destDir);
  const plan = [];
  let total = 0;
  let skipped = 0;
  for (const e of entries) {
    const rel = safeEntryPath(e.name);
    if (!rel) throw new ZipError(`Chemin interdit dans l’archive : « ${String(e.name).slice(0, 120)} »`);
    if (e.isLink) {
      skipped++;
      continue;
    }
    const mapped = map(rel, e);
    if (!mapped) {
      skipped++;
      continue;
    }
    const safe = safeEntryPath(mapped);
    if (!safe) throw new ZipError(`Chemin interdit dans l’archive : « ${String(e.name).slice(0, 120)} »`);
    const dest = path.resolve(root, ...safe.split('/'));
    if (dest !== root && !dest.startsWith(root + path.sep)) throw new ZipError(`Chemin interdit dans l’archive : « ${String(e.name).slice(0, 120)} »`);
    if (e.isDir) {
      plan.push({ e, dest, dir: true });
      continue;
    }
    if (e.flags & 1) throw new ZipError('Archive chiffrée (mot de passe) : non supportée');
    if (e.method !== 0 && e.method !== 8) throw new ZipError(`Méthode de compression non supportée (${e.method}) pour « ${safe} » — recompresse l’archive en ZIP standard (Deflate)`);
    total += e.size;
    if (total > maxTotal) throw new ZipError('Archive trop volumineuse une fois décompressée', 413);
    plan.push({ e, dest, rel: safe });
  }
  fs.mkdirSync(root, { recursive: true });
  const fd = fs.openSync(file, 'r');
  let done = 0;
  let bytes = 0;
  const files = plan.filter((x) => !x.dir).length;
  try {
    for (const item of plan) {
      if (item.dir) {
        fs.mkdirSync(item.dest, { recursive: true });
        continue;
      }
      const { e } = item;
      if (!e.compSize && e.size) throw new ZipError(`Entrée ZIP endommagée : « ${item.rel} »`);
      const loc = readAt(fd, e.localOffset, 30);
      if (loc.length < 30 || loc.readUInt32LE(0) !== SIG_LOC) throw new ZipError(`Entrée ZIP endommagée : « ${item.rel} »`);
      const start = e.localOffset + 30 + loc.readUInt16LE(26) + loc.readUInt16LE(28);
      fs.mkdirSync(path.dirname(item.dest), { recursive: true });
      const counter = crcCounter(e.size, item.rel);
      const src = e.compSize > 0 ? fs.createReadStream(null, { fd, start, end: start + e.compSize - 1, autoClose: false }) : null;
      const out = fs.createWriteStream(item.dest);
      try {
        if (!src) {
          out.end();
          await new Promise((res, rej) => out.on('finish', res).on('error', rej));
        } else if (e.method === 8) await pipeline(src, zlib.createInflateRaw(), counter, out);
        else await pipeline(src, counter, out);
      } catch (err) {
        try {
          fs.rmSync(item.dest, { force: true });
        } catch {}
        if (err instanceof ZipError) throw err;
        throw new ZipError(`Décompression impossible de « ${item.rel} » : ${err.message}`);
      }
      const r = counter.result();
      if (src && (r.bytes !== e.size || r.crc !== e.crc)) throw new ZipError(`Fichier corrompu dans l’archive : « ${item.rel} » (CRC)`);
      bytes += r.bytes;
      done++;
      onProgress?.({ done, total: files, bytes });
    }
  } finally {
    fs.closeSync(fd);
  }
  return { files: done, bytes, skipped };
}

// ---------------------------------------------------------------------------
// Writer
// ---------------------------------------------------------------------------
const NO_DEFLATE = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.mp3', '.ogg', '.m4a', '.webm', '.mp4', '.zip', '.gz', '.woff', '.woff2', '.flac', '.opus']);
const MAX_ZIP = 0xfffffff0;

function dosDateTime(d) {
  const date = d instanceof Date && !Number.isNaN(d.getTime()) ? d : new Date();
  const y = Math.max(1980, date.getFullYear());
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((y - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

/** Recursively list files under dir → [{ rel: 'a/b.png', file, size, mtime }] (skips symlinks). */
export function walkFiles(dir, { exclude = () => false, base = '' } = {}) {
  const out = [];
  let list = [];
  try {
    list = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const d of list) {
    const rel = base ? `${base}/${d.name}` : d.name;
    if (exclude(rel, d)) continue;
    const full = path.join(dir, d.name);
    if (d.isDirectory()) out.push(...walkFiles(full, { exclude, base: rel }));
    else if (d.isFile()) {
      try {
        const st = fs.statSync(full);
        out.push({ rel, file: full, size: st.size, mtime: st.mtime });
      } catch {}
    }
  }
  return out;
}

/** Total size in bytes of a directory tree. */
export function dirSize(dir) {
  return walkFiles(dir).reduce((s, f) => s + f.size, 0);
}

/**
 * Stream a zip to `out` (a writable: file stream or HTTP response).
 * items: [{ name, file } | { name, data: Buffer|string }]. Throws ZipError(413) upfront when > 4 GB.
 */
export async function writeZip(out, items) {
  const estimate = items.reduce((s, it) => s + (it.data != null ? Buffer.byteLength(it.data) : fs.statSync(it.file).size) + 200, 22);
  if (estimate > MAX_ZIP) throw new ZipError('Archive de plus de 4 Go : non supportée', 413);
  let offset = 0;
  const central = [];
  const write = (buf) =>
    new Promise((res, rej) => {
      offset += buf.length;
      const onErr = (e) => rej(e);
      out.once('error', onErr);
      const ok = out.write(buf, () => {});
      const done = () => {
        out.off('error', onErr);
        res();
      };
      if (ok) done();
      else out.once('drain', done);
    });
  for (const it of items) {
    const nameBuf = Buffer.from(String(it.name).replace(/\\/g, '/'), 'utf8');
    let method = 0;
    let crc = 0;
    let size = 0;
    let payload = null; // Buffer (small/deflated) or null (stream the file)
    let mtime = new Date();
    if (it.data != null) {
      const raw = Buffer.isBuffer(it.data) ? it.data : Buffer.from(String(it.data), 'utf8');
      size = raw.length;
      crc = zlib.crc32(raw) >>> 0;
      const def = zlib.deflateRawSync(raw);
      if (def.length < raw.length) (method = 8), (payload = def);
      else payload = raw;
    } else {
      const st = fs.statSync(it.file);
      size = st.size;
      mtime = st.mtime;
      const ext = path.extname(it.file).toLowerCase();
      if (size <= 48e6) {
        const raw = fs.readFileSync(it.file);
        size = raw.length;
        crc = zlib.crc32(raw) >>> 0;
        if (!NO_DEFLATE.has(ext) && size > 64) {
          const def = zlib.deflateRawSync(raw);
          if (def.length < raw.length) (method = 8), (payload = def);
        }
        if (!payload) payload = raw;
      } else {
        // Big file: CRC pre-pass, then stored and streamed.
        let c = 0;
        for await (const chunk of fs.createReadStream(it.file)) c = zlib.crc32(chunk, c);
        crc = c >>> 0;
      }
    }
    const compSize = payload ? payload.length : size;
    const { time, date } = dosDateTime(mtime);
    const localOffset = offset;
    const loc = Buffer.alloc(30);
    loc.writeUInt32LE(SIG_LOC, 0);
    loc.writeUInt16LE(20, 4);
    loc.writeUInt16LE(0x800, 6); // UTF-8 names
    loc.writeUInt16LE(method, 8);
    loc.writeUInt16LE(time, 10);
    loc.writeUInt16LE(date, 12);
    loc.writeUInt32LE(crc, 14);
    loc.writeUInt32LE(compSize, 18);
    loc.writeUInt32LE(size, 22);
    loc.writeUInt16LE(nameBuf.length, 26);
    loc.writeUInt16LE(0, 28);
    await write(Buffer.concat([loc, nameBuf]));
    if (payload) await write(payload);
    else for await (const chunk of fs.createReadStream(it.file)) await write(chunk);
    if (offset > MAX_ZIP) throw new ZipError('Archive de plus de 4 Go : non supportée', 413);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(SIG_CEN, 0);
    cen.writeUInt16LE(0x031e, 4); // made by: unix, 3.0
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(0x800, 8);
    cen.writeUInt16LE(method, 10);
    cen.writeUInt16LE(time, 12);
    cen.writeUInt16LE(date, 14);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(compSize, 20);
    cen.writeUInt32LE(size, 24);
    cen.writeUInt16LE(nameBuf.length, 28);
    cen.writeUInt32LE((0o100644 << 16) >>> 0, 38);
    cen.writeUInt32LE(localOffset, 42);
    central.push(Buffer.concat([cen, nameBuf]));
  }
  const cdOffset = offset;
  const cd = Buffer.concat(central);
  await write(cd);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(SIG_EOCD, 0);
  end.writeUInt16LE(Math.min(central.length, 0xffff), 8);
  end.writeUInt16LE(Math.min(central.length, 0xffff), 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(cdOffset, 16);
  await write(end);
  return { bytes: offset, files: central.length };
}

/** writeZip() into a file (atomic: tmp + rename). */
export async function writeZipFile(file, items) {
  const tmp = `${file}.part`;
  const out = fs.createWriteStream(tmp);
  try {
    const r = await writeZip(out, items);
    await new Promise((res, rej) => out.end((err) => (err ? rej(err) : res())));
    fs.renameSync(tmp, file);
    return r;
  } catch (err) {
    out.destroy();
    try {
      fs.rmSync(tmp, { force: true });
    } catch {}
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Streamed uploads
// ---------------------------------------------------------------------------
/**
 * Stream an HTTP request body into `dest` (never buffered in memory). Rejects with ZipError(413) above maxBytes,
 * (400) when the client aborts. Resolves { bytes }.
 */
export function receiveToFile(req, dest, { maxBytes = 1.5e9 } = {}) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > maxBytes) {
      req.resume();
      return reject(new ZipError(`Fichier trop volumineux (${Math.round(maxBytes / 1e6)} Mo max)`, 413));
    }
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const out = fs.createWriteStream(dest);
    let bytes = 0;
    let finished = false;
    const fail = (err) => {
      if (finished) return;
      finished = true;
      req.unpipe(out);
      out.destroy();
      try {
        fs.rmSync(dest, { force: true });
      } catch {}
      req.resume();
      reject(err);
    };
    req.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > maxBytes) fail(new ZipError(`Fichier trop volumineux (${Math.round(maxBytes / 1e6)} Mo max)`, 413));
    });
    req.on('aborted', () => fail(new ZipError('Envoi interrompu')));
    req.on('error', (e) => fail(new ZipError(`Envoi interrompu (${e.message})`)));
    out.on('error', (e) => fail(new ZipError(`Écriture impossible sur le serveur (${e.code || e.message})`, 500)));
    out.on('finish', () => {
      if (finished) return;
      finished = true;
      if (!bytes) {
        try {
          fs.rmSync(dest, { force: true });
        } catch {}
        return reject(new ZipError('Fichier vide'));
      }
      resolve({ bytes });
    });
    req.pipe(out);
  });
}
