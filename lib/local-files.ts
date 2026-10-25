import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";

const execFileAsync = promisify(execFile);
const accepted = new Set([".jpg", ".jpeg", ".png", ".heic", ".webp"]);
export function isSupportedImageName(name: string) { return accepted.has(path.extname(name).toLowerCase()); }

export type LocalPhoto = { id: string; name: string; size: number; modified: number; thumbnail: string; filePath: string; thumbnailPath?: string };
type Session = { id: string; directory: string; name: string; photos: LocalPhoto[]; skipped: number; thumbnailsRemaining: number };
type Change = { id: string; to: string };
type UndoRecord = { id: string; folderId: string; directory: string; changes: { id: string; from: string; to: string; hash: string }[]; undone: boolean };

const globalState = globalThis as typeof globalThis & { weddingSorterSessions?: Map<string, Session>; weddingSorterUndo?: UndoRecord[] };
const sessions: Map<string, Session> = globalState.weddingSorterSessions ?? (globalState.weddingSorterSessions = new Map<string, Session>());
const undoRecords: UndoRecord[] = globalState.weddingSorterUndo ?? (globalState.weddingSorterUndo = []);

function assertMac() {
  if (process.platform !== "darwin") throw new Error("The native folder picker is available on macOS. Start this app on your Mac.");
}

async function chooseDirectory(): Promise<string | null> {
  assertMac();
  try {
    const { stdout } = await execFileAsync("/usr/bin/osascript", ["-e", 'POSIX path of (choose folder with prompt "Choose the folder containing your wedding photos")'], { timeout: 300_000, maxBuffer: 1024 * 1024 });
    return stdout.trim().replace(/\/$/, "") || "/";
  } catch (error) {
    const e = error as NodeJS.ErrnoException & { stderr?: string };
    if (e.code === "-128" || e.stderr?.includes("(-128)")) return null;
    throw new Error(e.stderr?.trim() || e.message || "Could not open the macOS folder picker.");
  }
}

async function createThumbnail(source: string, id: string): Promise<string> {
  const cache = path.join(os.tmpdir(), "wedding-photo-sorter-thumbnails");
  await fs.mkdir(cache, { recursive: true, mode: 0o700 });
  const output = path.join(cache, `${id}.jpg`);
  try {
    await execFileAsync("/usr/bin/sips", ["-s", "format", "jpeg", "-Z", "760", source, "--out", output], { timeout: 12_000, maxBuffer: 1024 * 1024 });
  } catch {
    // Some macOS releases cannot decode WebP in sips. The original remains available
    // through the local thumbnail route as a read-only preview fallback.
    return source;
  }
  return output;
}

export async function openFolder() {
  const directory = await chooseDirectory();
  if (!directory) throw new Error("Folder selection cancelled");
  const entries = await fs.readdir(/*turbopackIgnore: true*/ directory, { withFileTypes: true });
  const candidates = entries.filter((entry) => entry.isFile() && isSupportedImageName(entry.name));
  let skipped = entries.filter((entry) => entry.isFile() && !entry.name.startsWith(".") && !isSupportedImageName(entry.name)).length;
  const photos: LocalPhoto[] = [];
  for (const entry of candidates) {
    const filePath = path.join(/*turbopackIgnore: true*/ directory, entry.name);
    try {
      const stat = await fs.stat(/*turbopackIgnore: true*/ filePath);
      const id = randomUUID();
      photos.push({ id, name: entry.name, size: stat.size, modified: stat.mtimeMs, thumbnail: `/api/thumbnail?id=${id}`, filePath, thumbnailPath: filePath });
    } catch { skipped += 1; }
  }
  const result = registerFolderSession(directory, photos, skipped);
  scheduleThumbnails(sessions.get(result.id)!);
  return { ...result, thumbnailsPending: sessions.get(result.id)!.thumbnailsRemaining };
}

export function registerFolderSession(directory: string, photos: LocalPhoto[], skipped = 0) {
  const session: Session = { id: randomUUID(), directory, name: path.basename(directory) || directory, photos, skipped, thumbnailsRemaining: 0 };
  sessions.set(session.id, session);
  return { id: session.id, name: session.name, pathLabel: directory, photos: photos.map(({ id, name, size, modified, thumbnail }) => ({ id, name, size, modified, thumbnail })), skipped };
}

function scheduleThumbnails(session: Session, photos = session.photos) {
  session.thumbnailsRemaining += photos.length;
  let cursor = 0;
  const workers = Array.from({ length: Math.min(4, photos.length) }, async () => {
    while (cursor < photos.length) {
      const photo = photos[cursor++];
      try { photo.thumbnailPath = await createThumbnail(photo.filePath, photo.id); }
      catch { photo.thumbnailPath = photo.filePath; }
      finally { session.thumbnailsRemaining -= 1; }
    }
  });
  void Promise.all(workers);
}

export function getFolderStatus(folderId: string) {
  const session = sessions.get(folderId);
  if (!session) throw new Error("Folder session expired. Open the folder again.");
  return { thumbnailsRemaining: session.thumbnailsRemaining };
}

export async function addPhotos(folderId: string) {
  assertMac();
  const session = sessions.get(folderId);
  if (!session) throw new Error("Folder session expired. Open the folder again.");
  const directoryLiteral = session.directory.replace(/\\/g, "\\\\").replace(/"/g, "\\\"");
  const script = `set chosenFiles to choose file with prompt "Choose photos to add" default location (POSIX file "${directoryLiteral}") of type {"public.image"} with multiple selections allowed\nset filePaths to {}\nrepeat with currentFile in chosenFiles\nset end of filePaths to POSIX path of currentFile\nend repeat\nset AppleScript's text item delimiters to linefeed\nreturn filePaths as text`;
  let stdout = "";
  try { ({ stdout } = await execFileAsync("/usr/bin/osascript", ["-e", script], { timeout: 300_000, maxBuffer: 1024 * 1024 })); }
  catch (error) {
    const e = error as NodeJS.ErrnoException & { stderr?: string };
    if (e.code === "-128" || e.stderr?.includes("(-128)")) throw new Error("Photo selection cancelled");
    throw new Error(e.stderr?.trim() || e.message || "Could not select photos.");
  }
  const selectedPaths = stdout.trim().split(/\r?\n/).filter(Boolean);
  let skipped = 0;
  const added: LocalPhoto[] = [];
  const existingPaths = new Set(session.photos.map((photo) => path.join(session.directory, photo.name)));
  for (const filePath of selectedPaths) {
    if (path.dirname(filePath) !== session.directory || !isSupportedImageName(filePath) || existingPaths.has(filePath)) { skipped += 1; continue; }
    try {
      const stat = await fs.stat(filePath);
      if (!stat.isFile()) { skipped += 1; continue; }
      const id = randomUUID();
      const photo: LocalPhoto = { id, name: path.basename(filePath), size: stat.size, modified: stat.mtimeMs, thumbnail: `/api/thumbnail?id=${id}`, filePath, thumbnailPath: filePath };
      session.photos.push(photo);
      added.push(photo);
      existingPaths.add(filePath);
    } catch { skipped += 1; }
  }
  session.skipped += skipped;
  scheduleThumbnails(session, added);
  return { photos: added.map(({ id, name, size, modified, thumbnail }) => ({ id, name, size, modified, thumbnail })), skipped, thumbnailsPending: session.thumbnailsRemaining };
}

export async function getThumbnail(id: string) {
  for (const session of sessions.values()) {
    const photo = session.photos.find((item) => item.id === id);
    if (!photo) continue;
    const thumbnailPath = photo.thumbnailPath || photo.filePath;
    try { await fs.access(thumbnailPath); return { filePath: thumbnailPath, type: thumbnailPath === photo.filePath ? imageMime(photo.name) : "image/jpeg" }; }
    catch { throw new Error(`Preview is no longer available for ${photo.name}`); }
  }
  throw new Error("Photo preview expired. Open the folder again.");
}

function imageMime(name: string) {
  const extension = path.extname(name).slice(1).toLowerCase();
  return extension === "jpg" || extension === "jpeg" ? "image/jpeg" : `image/${extension}`;
}

async function sha256(filePath: string) {
  const hash = createHash("sha256");
  const stream = (await import("node:fs")).createReadStream(filePath);
  for await (const chunk of stream) hash.update(chunk);
  return hash.digest("hex");
}

function assertFilename(name: string) {
  if (!name || name === "." || name === ".." || name.includes("/") || name.includes("\\") || name.includes("\0")) throw new Error(`Invalid destination filename: ${name}`);
}

type RenameOps = { rename: typeof fs.rename; link: typeof fs.link; unlink: typeof fs.unlink };

export async function safeRename(directory: string, changes: { from: string; to: string; hash?: string }[], ops: RenameOps = { rename: fs.rename, link: fs.link, unlink: fs.unlink }) {
  const changed = changes.filter((item) => item.from !== item.to);
  const fromSet = new Set(changed.map((item) => item.from.toLocaleLowerCase()));
  const targets = new Set<string>();
  for (const item of changed) {
    assertFilename(item.to);
    const key = item.to.toLocaleLowerCase();
    if (targets.has(key)) throw new Error(`Two photos would use the filename “${item.to}”.`);
    targets.add(key);
    const stat = await fs.lstat(path.join(directory, item.from)).catch(() => null);
    if (!stat?.isFile() || stat.isSymbolicLink()) throw new Error(`Source file is missing or is not a regular file: ${item.from}`);
    if (item.hash && await sha256(path.join(directory, item.from)) !== item.hash) throw new Error(`File contents changed since the last save: ${item.from}`);
  }
  for (const item of changed) {
    try { await fs.lstat(path.join(directory, item.to)); if (!fromSet.has(item.to.toLocaleLowerCase())) throw new Error(`A file already exists with the name “${item.to}”.`); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  const staged: { from: string; to: string; temp: string }[] = [];
  try {
    for (const item of changed) {
      const temp = path.join(directory, `.wedding-sorter-${randomUUID()}.tmp`);
      await ops.rename(path.join(directory, item.from), temp);
      staged.push({ ...item, temp });
    }
    for (const item of staged) {
      const destination = path.join(directory, item.to);
      // link() claims the final path atomically and fails with EEXIST; plain rename()
      // would overwrite a file created after preflight on POSIX filesystems.
      await ops.link(item.temp, destination);
      await ops.unlink(item.temp);
    }
    for (const item of changed) if (item.hash && await sha256(path.join(directory, item.to)) !== item.hash) throw new Error(`Content verification failed after renaming ${item.to}.`);
  } catch (error) {
    const failures: string[] = [];
    for (const item of [...staged].reverse()) {
      const tempExists = await fs.access(item.temp).then(() => true, () => false);
      const destination = path.join(directory, item.to);
      const destinationExists = await fs.access(destination).then(() => true, () => false);
      if (tempExists && destinationExists) {
        const [tempStat, destinationStat] = await Promise.all([fs.stat(item.temp), fs.stat(destination)]);
        if (tempStat.dev === destinationStat.dev && tempStat.ino === destinationStat.ino) await ops.unlink(destination).catch(() => failures.push(`${item.to} (temporary link could not be removed)`));
      }
      const current = tempExists ? item.temp : destination;
      const original = path.join(directory, item.from);
      if (await fs.access(current).then(() => true, () => false)) {
        if (await fs.access(original).then(() => true, () => false)) failures.push(`${item.from} (original path is occupied)`);
        else await ops.rename(current, original).catch(() => failures.push(item.from));
      }
    }
    const message = (error as Error).message;
    throw new Error(failures.length ? `${message} Rollback could not restore: ${failures.join(", ")}` : `${message} Files were rolled back where possible.`);
  }
}

export async function savePlan(folderId: string, changes: Change[]) {
  const session = sessions.get(folderId);
  if (!session) throw new Error("Folder session expired. Open the folder again before saving.");
  if (!Array.isArray(changes) || changes.length !== session.photos.length) throw new Error("The rename plan does not match the loaded photo collection.");
  const ids = new Set<string>();
  const normalized = changes.map(({ id, to }) => {
    if (ids.has(id)) throw new Error("The rename plan contains a duplicate photo.");
    ids.add(id);
    const photo = session.photos.find((item) => item.id === id);
    if (!photo) throw new Error("The collection changed. Reopen the folder and try again.");
    return { id, from: photo.name, to };
  });
  if (ids.size !== session.photos.length) throw new Error("The rename plan is incomplete.");
  for (const photo of session.photos) {
    const stat = await fs.stat(path.join(session.directory, photo.name)).catch(() => null);
    if (!stat?.isFile() || stat.size !== photo.size) throw new Error(`Source file is missing or has changed: ${photo.name}`);
  }
  const changesWithHashes = await Promise.all(normalized.map(async (item) => ({ ...item, hash: await sha256(path.join(session.directory, item.from)) })));
  await safeRename(session.directory, changesWithHashes);
  const record: UndoRecord = { id: randomUUID(), folderId, directory: session.directory, changes: changesWithHashes.map(({ id, from, to, hash }) => ({ id, from, to, hash })), undone: false };
  undoRecords.push(record);
  for (const item of normalized) {
    const photo = session.photos.find((entry) => entry.id === item.id)!;
    photo.name = item.to;
    const stat = await fs.stat(path.join(session.directory, item.to)); photo.size = stat.size; photo.modified = stat.mtimeMs;
  }
  return { renamed: changesWithHashes.filter((item) => item.from !== item.to).length, recordId: record.id };
}

export async function undoLastSave() {
  const record = [...undoRecords].reverse().find((item) => !item.undone);
  if (!record) throw new Error("There is no saved rename operation to undo.");
  const inverse = record.changes.map(({ id, from, to, hash }) => ({ id, from: to, to: from, hash }));
  await safeRename(record.directory, inverse);
  record.undone = true;
  const session = sessions.get(record.folderId);
  if (!session) throw new Error("Rename was reversed, but the folder session expired. Reopen the folder to refresh thumbnails.");
  for (const item of record.changes) {
    const photo = session.photos.find((entry) => entry.id === item.id)!;
    photo.name = item.from;
    const stat = await fs.stat(path.join(session.directory, item.from)); photo.size = stat.size; photo.modified = stat.mtimeMs;
  }
  return { recordId: record.id, photos: session.photos.map((photo) => ({ id: photo.id, name: photo.name, size: photo.size, modified: photo.modified, thumbnail: photo.thumbnail })) };
}
