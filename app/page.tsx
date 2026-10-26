"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Image from "next/image";
import { generateRenamePlan, movePhoto } from "@/lib/rename-plan";

type Photo = { id: string; name: string; size: number; modified: number; thumbnail: string };
type Folder = { id: string; name: string; pathLabel: string; photos: Photo[]; skipped: number; thumbnailsPending?: number };
type RenameRow = { id: string; from: string; to: string; position: number };
type BinPhoto = { photo: Photo; orderIndex: number; previousId?: string; nextId?: string };

const initialSettings = { prefix: "Wedding", start: 100, interval: 100, width: 5 };

function distanceToSegment(pointX: number, pointY: number, x1: number, y1: number, x2: number, y2: number) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lengthSquared = dx * dx + dy * dy;
  const projection = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, ((pointX - x1) * dx + (pointY - y1) * dy) / lengthSquared));
  return Math.hypot(pointX - (x1 + projection * dx), pointY - (y1 + projection * dy));
}

function Icon({ name, size = 18 }: { name: string; size?: number }) {
  const common = { width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.7, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, "aria-hidden": true as const };
  const paths: Record<string, React.ReactNode> = {
    folder: <><path d="M3 7.5A2.5 2.5 0 0 1 5.5 5H10l2 2h6.5A2.5 2.5 0 0 1 21 9.5v8a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5z"/><path d="M3.5 10h17"/></>,
    search: <><circle cx="10.8" cy="10.8" r="6.8"/><path d="m16 16 4.5 4.5"/></>,
    undo: <><path d="M9 14 4 9l5-5"/><path d="M4 9h9a7 7 0 0 1 0 14h-2"/></>,
    redo: <><path d="m15 14 5-5-5-5"/><path d="M20 9h-9a7 7 0 0 0 0 14h2"/></>,
    more: <><circle cx="5" cy="12" r="1" fill="currentColor"/><circle cx="12" cy="12" r="1" fill="currentColor"/><circle cx="19" cy="12" r="1" fill="currentColor"/></>,
    grid: <><rect x="3" y="3" width="8" height="8" rx="1.5"/><rect x="13" y="3" width="8" height="8" rx="1.5"/><rect x="3" y="13" width="8" height="8" rx="1.5"/><rect x="13" y="13" width="8" height="8" rx="1.5"/></>,
    list: <><path d="M9 6h12M9 12h12M9 18h12"/><circle cx="4" cy="6" r=".7" fill="currentColor"/><circle cx="4" cy="12" r=".7" fill="currentColor"/><circle cx="4" cy="18" r=".7" fill="currentColor"/></>,
    check: <path d="m5 12 4 4L19 6"/>,
    close: <><path d="m18 6-12 12M6 6l12 12"/></>,
    image: <><rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/></>,
    chevron: <path d="m9 18 6-6-6-6"/>,
  };
  return <svg {...common}>{paths[name]}</svg>;
}

async function api<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, { method: body ? "POST" : "GET", headers: body ? { "Content-Type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "Something went wrong");
  return result as T;
}

export default function Home() {
  const [folder, setFolder] = useState<Folder | null>(null);
  const [order, setOrder] = useState<string[]>([]);
  const [baseline, setBaseline] = useState<string[]>([]);
  const [search, setSearch] = useState("");
  const [density, setDensity] = useState<"comfortable" | "compact">("comfortable");
  const [settings, setSettings] = useState(initialSettings);
  const [savedSettings, setSavedSettings] = useState(initialSettings);
  const [history, setHistory] = useState<string[][]>([]);
  const [redoStack, setRedoStack] = useState<string[][]>([]);
  const [dragId, setDragId] = useState<string | null>(null);
  const [dragIds, setDragIds] = useState<string[]>([]);
  const [busy, setBusy] = useState("");
  const [progress, setProgress] = useState(0);
  const [thumbnailsRemaining, setThumbnailsRemaining] = useState(0);
  const [thumbnailRevision, setThumbnailRevision] = useState(0);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [preview, setPreview] = useState(false);
  const [selected, setSelected] = useState<Photo | null>(null);
  const [temporaryBin, setTemporaryBin] = useState<BinPhoto[]>([]);
  const [showTemporaryBin, setShowTemporaryBin] = useState(false);
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [activeMenu, setActiveMenu] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const indicatorRef = useRef<HTMLSpanElement>(null);
  const dragGhostRef = useRef<HTMLDivElement>(null);
  const [insertIndex, setInsertIndex] = useState<number | null>(null);
  const insertIndexRef = useRef<number | null>(null);
  const updateStoredInsertIndex = useCallback((index: number | null) => {
    insertIndexRef.current = index;
    setInsertIndex(index);
    if (index === null && indicatorRef.current) {
      indicatorRef.current.style.display = "none";
      delete indicatorRef.current.dataset.insertIndex;
    }
    if (index === null && dragGhostRef.current) dragGhostRef.current.style.display = "none";
  }, []);

  const updateInsertIndex = useCallback((clientX: number, clientY: number) => {
    const grid = gridRef.current;
    if (!grid) { updateStoredInsertIndex(null); return; }
    const cards = Array.from(grid.querySelectorAll<HTMLElement>("[data-photo-id]"));
    if (!cards.length) { updateStoredInsertIndex(null); return; }
    const rects = cards.map((card) => card.getBoundingClientRect());
    const horizontal = density === "compact";
    const computed = window.getComputedStyle(grid);
    const columnGap = Number.parseFloat(computed.columnGap) || 0;
    const rowGap = Number.parseFloat(computed.rowGap) || 0;
    const gaps = rects.map((rect, index) => {
      const next = rects[index + 1];
      if (horizontal) {
        const left = rect.left;
        const right = rect.right;
        const y = next ? (rect.bottom + next.top) / 2 : rect.bottom + rowGap / 2;
        return { index: index + 1, orientation: "horizontal" as const, left, right, top: y, bottom: y, distance: distanceToSegment(clientX, clientY, left, y, right, y) };
      }
      const nextRow = next && Math.abs(rect.top - next.top) >= 2;
      const x = !next ? rect.right + columnGap / 2 : nextRow ? next.left - columnGap / 2 : (rect.right + next.left) / 2;
      const top = nextRow ? next!.top : rect.top;
      const bottom = nextRow ? next!.bottom : rect.bottom;
      return { index: index + 1, orientation: "vertical" as const, left: x, right: x, top, bottom, distance: distanceToSegment(clientX, clientY, x, top, x, bottom) };
    });
    const first = rects[0];
    const leadingX = horizontal ? first.left : first.left - columnGap / 2;
    const leadingY = horizontal ? first.top - rowGap / 2 : first.top;
    gaps.unshift({ index: 0, orientation: horizontal ? "horizontal" : "vertical", left: horizontal ? first.left : leadingX, right: horizontal ? first.right : leadingX, top: leadingY, bottom: horizontal ? leadingY : first.bottom, distance: distanceToSegment(clientX, clientY, horizontal ? first.left : leadingX, leadingY, horizontal ? first.right : leadingX, horizontal ? leadingY : first.bottom) });
    const nearestGap = gaps.reduce((best, gap) => gap.distance < best.distance ? gap : best);
    const slot = nearestGap.index;
    const indicator = indicatorRef.current;
    const dragGhost = dragGhostRef.current;
    if (dragGhost) {
      dragGhost.style.left = `${clientX}px`;
      dragGhost.style.top = `${clientY}px`;
      dragGhost.style.display = "block";
    }
    if (indicator) {
      const visibleDragPositions = cards.flatMap((card, index) => dragIds.includes(card.dataset.photoId || "") ? [index] : []);
      const firstDragPosition = Math.min(...visibleDragPositions);
      const lastDragPosition = Math.max(...visibleDragPositions);
      const isContiguousGroup = visibleDragPositions.length > 0 && visibleDragPositions.length === dragIds.filter((id) => cards.some((card) => card.dataset.photoId === id)).length
        && lastDragPosition - firstDragPosition + 1 === visibleDragPositions.length;
      const noOp = isContiguousGroup && slot >= firstDragPosition && slot <= lastDragPosition + 1;
      indicator.className = `drop-indicator ${nearestGap.orientation}`;
      indicator.style.left = `${horizontal ? nearestGap.left : (nearestGap.left + nearestGap.right) / 2}px`;
      indicator.style.top = `${horizontal ? (nearestGap.top + nearestGap.bottom) / 2 : nearestGap.top}px`;
      indicator.style.width = `${horizontal ? nearestGap.right - nearestGap.left : 4}px`;
      indicator.style.height = `${horizontal ? 4 : nearestGap.bottom - nearestGap.top}px`;
      indicator.style.transform = horizontal ? "translateY(-50%)" : "translateX(-50%)";
      indicator.style.display = noOp ? "none" : "block";
    }
    updateStoredInsertIndex(slot);
    const edge = 72;
    const speed = 18;
    if (clientY < edge) window.scrollBy({ top: -speed, behavior: "auto" });
    else if (clientY > window.innerHeight - edge) window.scrollBy({ top: speed, behavior: "auto" });
  }, [density, dragIds, updateStoredInsertIndex]);

  const photos = useMemo(() => new Map(folder?.photos.map((photo) => [photo.id, photo]) || []), [folder]);
  const draggedPhoto = dragId ? photos.get(dragId) : undefined;
  const ordered = useMemo(() => order.map((id) => photos.get(id)).filter((photo): photo is Photo => Boolean(photo)), [order, photos]);
  const changed = order.join("|") !== baseline.join("|") || JSON.stringify(settings) !== JSON.stringify(savedSettings);
  const visible = useMemo(() => ordered.filter((photo) => photo.name.toLowerCase().includes(search.toLowerCase())), [ordered, search]);
  const binPhotos = useMemo(() => temporaryBin.map(({ photo }) => photo), [temporaryBin]);
  const filenameError = useMemo(() => { try { generateRenamePlan([], settings); return ""; } catch (cause) { return (cause as Error).message; } }, [settings]);
  const plan = useMemo<RenameRow[]>(() => { try { return generateRenamePlan(ordered, settings); } catch { return []; } }, [ordered, settings]);
  const changedRows = plan.filter((row) => row.from !== row.to);
  const conflicts = useMemo(() => {
    const targets = new Set<string>();
    return plan.filter((row) => {
      const key = row.to.toLocaleLowerCase();
      const collision = targets.has(key);
      targets.add(key);
      return collision || Boolean(folder?.photos.some((photo) => photo.name.toLocaleLowerCase() === key && photo.id !== row.id && !plan.some((other) => other.id === photo.id && other.from !== other.to)));
    });
  }, [folder, plan]);

  const commitOrder = useCallback((next: string[]) => {
    setHistory((items) => [...items, order]); setRedoStack([]); setOrder(next);
  }, [order]);

  async function openFolder() {
    if (changed && !window.confirm("You have unsaved changes. Open another folder and discard them?")) return;
    setError(""); setBusy("Opening folder…"); setProgress(12);
    try {
      const result = await api<Folder>("/api/folder");
      setProgress(100); setFolder(result); setOrder(result.photos.map((photo) => photo.id)); setBaseline(result.photos.map((photo) => photo.id));
      setThumbnailsRemaining(result.thumbnailsPending || 0); setThumbnailRevision(0);
      setHistory([]); setRedoStack([]); setSearch(""); setSettings(initialSettings); setSavedSettings(initialSettings); setNotice(`${result.photos.length} photos ready · Subfolders are excluded`);
      setTemporaryBin([]); setShowTemporaryBin(false); setSelectionMode(false); setSelectedIds([]); setActiveMenu(null);
      setTimeout(() => setNotice(""), 4500);
    } catch (cause) { if ((cause as Error).message !== "Folder selection cancelled") setError((cause as Error).message); }
    finally { setBusy(""); setProgress(0); }
  }

  function move(id: string, destination: number) {
    const next = movePhoto(order, id, destination);
    if (next.join() !== order.join()) commitOrder(next);
  }

  function sortByName() { if (folder) commitOrder([...order].sort((a, b) => (photos.get(a)?.name || "").localeCompare(photos.get(b)?.name || "", undefined, { numeric: true, sensitivity: "base" }))); }
  function undo() { if (!history.length) return; setRedoStack((items) => [...items, order]); setOrder(history[history.length - 1]); setHistory(history.slice(0, -1)); }
  function redo() { if (!redoStack.length) return; setHistory((items) => [...items, order]); setOrder(redoStack[redoStack.length - 1]); setRedoStack(redoStack.slice(0, -1)); }

  function moveToTemporaryBin(ids: string[]) {
    const removing = new Set(ids);
    const entries = order.flatMap((id, orderIndex) => {
      if (!removing.has(id)) return [];
      const photo = photos.get(id);
      return photo ? [{ photo, orderIndex, previousId: order[orderIndex - 1], nextId: order[orderIndex + 1] }] : [];
    });
    if (!entries.length) return;
    setTemporaryBin((items) => [...items, ...entries]);
    setOrder(order.filter((id) => !removing.has(id)));
    setSelectedIds([]); setSelectionMode(false); setActiveMenu(null);
    setNotice(`${entries.length} ${entries.length === 1 ? "photo" : "photos"} moved to the temporary bin`);
    window.setTimeout(() => setNotice(""), 3500);
  }

  function restoreBinPhotos(entries: BinPhoto[]) {
    const restoring = [...entries].sort((a, b) => a.orderIndex - b.orderIndex);
    const next = [...order];
    for (const entry of restoring) {
      const nextIndex = entry.nextId ? next.indexOf(entry.nextId) : -1;
      const previousIndex = entry.previousId ? next.indexOf(entry.previousId) : -1;
      const index = nextIndex >= 0 ? nextIndex : previousIndex >= 0 ? previousIndex + 1 : Math.min(entry.orderIndex, next.length);
      next.splice(index, 0, entry.photo.id);
    }
    setOrder(next);
    const restoringIds = new Set(entries.map(({ photo }) => photo.id));
    setTemporaryBin((items) => items.filter(({ photo }) => !restoringIds.has(photo.id)));
    setSelectedIds([]); setSelectionMode(false);
  }

  function togglePhotoSelection(id: string) {
    setSelectedIds((items) => items.includes(id) ? items.filter((item) => item !== id) : [...items, id]);
  }

  async function save() {
    if (!folder || !changedRows.length || conflicts.length || filenameError) return;
    setBusy("Saving changes…"); setProgress(8); setError("");
    const timer = window.setInterval(() => setProgress((value) => Math.min(value + 7, 92)), 180);
    try {
      const result = await api<{ renamed: number; recordId: string }>("/api/save", { folderId: folder.id, changes: plan.map(({ id, to }) => ({ id, to })) });
      setProgress(100); setNotice(`${result.renamed} photos renamed safely`); setBaseline(order); setSavedSettings(settings); setFolder((current) => current ? { ...current, photos: current.photos.map((photo) => ({ ...photo, name: plan.find((row) => row.id === photo.id)?.to || photo.name })) } : current); setPreview(false); setHistory([]); setRedoStack([]);
      window.setTimeout(() => setNotice(""), 5000);
    } catch (cause) { setError((cause as Error).message); }
    finally { window.clearInterval(timer); setBusy(""); setTimeout(() => setProgress(0), 500); }
  }

  async function addPhotos() {
    if (!folder) return;
    setBusy("Adding photos…"); setError("");
    try {
      const result = await api<{ photos: Photo[]; skipped: number; thumbnailsPending: number }>("/api/folder/add", { folderId: folder.id });
      if (!result.photos.length) { setNotice("No new supported photos were selected"); return; }
      const ids = result.photos.map((photo) => photo.id);
      setFolder((current) => current ? { ...current, photos: [...current.photos, ...result.photos], skipped: current.skipped + result.skipped } : current);
      setOrder((current) => [...current, ...ids]);
      setThumbnailsRemaining(result.thumbnailsPending); setThumbnailRevision((revision) => revision + 1);
      setNotice(`${result.photos.length} photos added to the end of the sequence`);
    } catch (cause) { if ((cause as Error).message !== "Photo selection cancelled") setError((cause as Error).message); }
    finally { setBusy(""); }
  }

  async function undoSave() {
    if (!window.confirm("Restore the filenames from your last save? This will rename those files on disk.")) return;
    setBusy("Restoring previous filenames…"); setError("");
    try { const result = await api<{ recordId: string; photos: Photo[] }>("/api/undo"); setFolder((current) => current ? { ...current, photos: result.photos } : current); setOrder(result.photos.map((photo) => photo.id)); setBaseline(result.photos.map((photo) => photo.id)); setTemporaryBin([]); setShowTemporaryBin(false); setSelectedIds([]); setSelectionMode(false); setSettings(initialSettings); setSavedSettings(initialSettings); setNotice("Last rename operation reversed"); }
    catch (cause) { setError((cause as Error).message); }
    finally { setBusy(""); }
  }

  useEffect(() => {
    function beforeUnload(event: BeforeUnloadEvent) { if (changed) { event.preventDefault(); event.returnValue = ""; } }
    window.addEventListener("beforeunload", beforeUnload); return () => window.removeEventListener("beforeunload", beforeUnload);
  }, [changed]);

  useEffect(() => {
    if (!activeMenu) return;
    function dismissMenu(event: PointerEvent) { if (!menuRef.current?.contains(event.target as Node)) setActiveMenu(null); }
    function dismissOnEscape(event: KeyboardEvent) { if (event.key === "Escape") setActiveMenu(null); }
    document.addEventListener("pointerdown", dismissMenu); document.addEventListener("keydown", dismissOnEscape);
    return () => { document.removeEventListener("pointerdown", dismissMenu); document.removeEventListener("keydown", dismissOnEscape); };
  }, [activeMenu]);

  const folderId = folder?.id;
  const isPreparingThumbnails = thumbnailsRemaining > 0;
  useEffect(() => {
    if (!folderId || !isPreparingThumbnails) return;
    let active = true;
    const timer = window.setInterval(async () => {
      try {
        const result = await api<{ thumbnailsRemaining: number }>(`/api/folder/status?id=${encodeURIComponent(folderId)}`);
        if (!active) return;
        setThumbnailsRemaining(result.thumbnailsRemaining);
        if (result.thumbnailsRemaining === 0) { setThumbnailRevision((revision) => revision + 1); window.clearInterval(timer); }
      } catch { if (active) setThumbnailsRemaining(0); }
    }, 1200);
    return () => { active = false; window.clearInterval(timer); };
  }, [folderId, isPreparingThumbnails]);

  useEffect(() => {
    if (!dragId) return;
    function cancelDrag(event: KeyboardEvent) {
      if (event.key === "Escape") { updateStoredInsertIndex(null); setDragId(null); setDragIds([]); }
    }
    window.addEventListener("keydown", cancelDrag);
    return () => window.removeEventListener("keydown", cancelDrag);
  }, [dragId, updateStoredInsertIndex]);

  useEffect(() => {
    if (!dragId) return;
    const activeDragId = dragId;
    const activeDragIds = dragIds.length ? dragIds : [activeDragId];
    function containsInsertionGap(clientX: number, clientY: number) {
      const grid = gridRef.current;
      if (!grid) return false;
      const cards = Array.from(grid.querySelectorAll<HTMLElement>("[data-photo-id]"));
      if (!cards.length) return false;
      const rects = cards.map((card) => card.getBoundingClientRect());
      const computed = window.getComputedStyle(grid);
      const columnGap = Number.parseFloat(computed.columnGap) || 0;
      const rowGap = Number.parseFloat(computed.rowGap) || 0;
      if (density === "compact") {
        return clientX >= rects[0].left - 1 && clientX <= rects[0].right + 1
          && clientY >= rects[0].top - rowGap / 2 - 1
          && clientY <= rects[rects.length - 1].bottom + rowGap / 2 + 1;
      }
      const bounds = rects.reduce((result, rect) => ({
        left: Math.min(result.left, rect.left), right: Math.max(result.right, rect.right),
        top: Math.min(result.top, rect.top), bottom: Math.max(result.bottom, rect.bottom),
      }), { left: rects[0].left, right: rects[0].right, top: rects[0].top, bottom: rects[0].bottom });
      return clientX >= bounds.left - columnGap / 2 - 1 && clientX <= bounds.right + columnGap / 2 + 1
        && clientY >= bounds.top - 1 && clientY <= bounds.bottom + 1;
    }
    function onDragOver(event: DragEvent) {
      if (!containsInsertionGap(event.clientX, event.clientY)) { updateStoredInsertIndex(null); return; }
      event.preventDefault();
      event.dataTransfer!.dropEffect = "move";
      updateInsertIndex(event.clientX, event.clientY);
    }
    function onDrop(event: DragEvent) {
      if (!containsInsertionGap(event.clientX, event.clientY)) { updateStoredInsertIndex(null); return; }
      event.preventDefault();
      event.stopImmediatePropagation();
      updateInsertIndex(event.clientX, event.clientY);
      const activeInsertIndex = insertIndexRef.current;
      if (activeInsertIndex !== null) {
        const insertionIndex = activeInsertIndex < visible.length
          ? order.indexOf(visible[activeInsertIndex].id)
          : visible.length ? order.indexOf(visible[visible.length - 1].id) + 1 : -1;
        const movingIds = order.filter((id) => activeDragIds.includes(id));
        if (movingIds.length && insertionIndex >= 0) {
          const movingSet = new Set(movingIds);
          const removedBeforeTarget = order.slice(0, insertionIndex).filter((id) => movingSet.has(id)).length;
          const nextOrder = order.filter((id) => !movingSet.has(id));
          nextOrder.splice(insertionIndex - removedBeforeTarget, 0, ...movingIds);
          if (nextOrder.join() !== order.join()) commitOrder(nextOrder);
        }
      }
      setDragId(null); setDragIds([]);
      updateStoredInsertIndex(null);
    }
    window.addEventListener("dragover", onDragOver, true);
    window.addEventListener("drag", onDragOver, true);
    window.addEventListener("drop", onDrop, true);
    return () => {
      window.removeEventListener("dragover", onDragOver, true);
      window.removeEventListener("drag", onDragOver, true);
      window.removeEventListener("drop", onDrop, true);
    };
  }, [commitOrder, density, dragId, dragIds, order, updateInsertIndex, updateStoredInsertIndex, visible]);

  return <main className="app-shell">
    <header className="topbar">
      <a className="brand" href="#" aria-label="Wedding Photo Sorter home"><span className="brand-mark"><Icon name="image" size={19}/></span><span>Wedding<span className="brand-light">Photo Sorter</span></span></a>
      <div className="topbar-right">
        {folder && <div className="folder-chip"><span className="live-dot"/><span className="folder-title">{folder.name}</span><span className="chip-count">{folder.photos.length} photos</span></div>}
        {changed && <span className="unsaved"><i/>Unsaved changes</span>}
        <button className="button button-primary open-button" onClick={openFolder} disabled={!!busy}><Icon name="folder"/>Open folder</button>
      </div>
    </header>

    {!folder ? <section className="welcome-wrap">
      <div className="welcome-card">
        <div className="welcome-art"><div className="art-sun"/><div className="art-hill hill-one"/><div className="art-hill hill-two"/><div className="art-frame frame-back"/><div className="art-frame frame-front"><div className="couple"><span/><i/><b/></div></div><div className="art-spark spark-one">✳</div><div className="art-spark spark-two">✧</div></div>
        <div className="welcome-copy"><span className="eyebrow"><span className="eyebrow-line"/>YOUR PHOTOS, YOUR STORY</span><h1>Every moment,<br/><em>in the right order.</em></h1><p>A calm space to arrange your wedding photographs exactly how you remember the day. Your originals stay untouched until you save.</p>
          <button className="button button-primary welcome-open" onClick={openFolder} disabled={!!busy}><Icon name="folder" size={19}/>{busy || "Open folder"}<Icon name="chevron" size={17}/></button>
          <div className="welcome-foot"><span><span className="shield">✓</span> Everything stays on this Mac</span><span className="foot-divider"/><span>No uploads. No changes until Save.</span></div>
        </div>
      </div>
      <div className="welcome-note"><span className="note-star">✳</span> A little less sorting. A little more reliving.</div>
    </section> : <>
      <div className="workspace-heading"><div><div className="eyebrow"><span className="eyebrow-line"/>YOUR COLLECTION</div><h1>Arrange the moments</h1><p>Drag to reorder. Your original photos remain safely in place until you save.</p></div><button className="text-button" onClick={undoSave}>↶ &nbsp;Undo last save</button></div>
      <section className="toolbar" aria-label="Photo controls">
        <label className="search-box"><Icon name="search" size={17}/><input placeholder="Find a photo by filename…" value={search} onChange={(event) => setSearch(event.target.value)}/>{search && <button aria-label="Clear search" onClick={() => setSearch("")}><Icon name="close" size={14}/></button>}</label>
        <div className="toolbar-spacer"/>
        <button className="toolbar-button" onClick={addPhotos} title="Add photos from this folder" disabled={!!busy}>+ Add photos</button>
        {temporaryBin.length > 0 && <button className={`toolbar-button bin-toggle ${showTemporaryBin ? "active" : ""}`} onClick={() => { setShowTemporaryBin((value) => !value); setSelectedIds([]); setSelectionMode(false); setActiveMenu(null); }}>{showTemporaryBin ? "← Back to photos" : `Temporary bin · ${temporaryBin.length}`}</button>}
        {selectionMode ? <>
          <button className="toolbar-button" onClick={() => setSelectedIds((showTemporaryBin ? binPhotos : visible).map((photo) => photo.id))}>Select all shown</button>
          <button className="toolbar-button" onClick={() => setSelectedIds([])} disabled={!selectedIds.length}>Clear selection</button>
          <button className="toolbar-button bulk-action" onClick={() => showTemporaryBin ? restoreBinPhotos(temporaryBin.filter(({ photo }) => selectedIds.includes(photo.id))) : moveToTemporaryBin(selectedIds)} disabled={!selectedIds.length}>{showTemporaryBin ? `Restore ${selectedIds.length}` : `Move ${selectedIds.length} to bin`}</button>
          <button className="text-button" onClick={() => { setSelectionMode(false); setSelectedIds([]); }}>Done</button>
        </> : <button className="toolbar-button" onClick={() => setSelectionMode(true)}>Select photos</button>}
        <button className="toolbar-button" onClick={sortByName} title="Sort by original filename">Name A–Z</button>
        <span className="toolbar-separator"/>
        <button className="icon-button" onClick={undo} disabled={!history.length} aria-label="Undo reorder" title="Undo"><Icon name="undo"/></button>
        <button className="icon-button" onClick={redo} disabled={!redoStack.length} aria-label="Redo reorder" title="Redo"><Icon name="redo"/></button>
        <span className="toolbar-separator"/>
        <div className="segmented" aria-label="Photo view"><button className={density === "comfortable" ? "active" : ""} onClick={() => setDensity("comfortable")} aria-label="Grid view" title="Grid view"><Icon name="grid" size={16}/></button><button className={density === "compact" ? "active" : ""} onClick={() => setDensity("compact")} aria-label="List view" title="List view"><Icon name="list" size={16}/></button></div>
        <button className="text-button reset-button" onClick={() => commitOrder(baseline.filter((id) => !temporaryBin.some(({ photo }) => photo.id === id)))}>Reset order</button>
      </section>
      {showTemporaryBin && <div className="bin-heading"><div><b>Temporary bin</b><span>Photos here stay on disk until you restore them.</span></div><button className="button button-secondary" onClick={() => { setShowTemporaryBin(false); setSelectedIds([]); setSelectionMode(false); }}>← Back to main photos</button></div>}
      {folder.skipped > 0 && <div className="inline-note">{folder.skipped} unsupported or unreadable {folder.skipped === 1 ? "file was" : "files were"} skipped.</div>}
      <div className="grid-meta"><span><b>{showTemporaryBin ? temporaryBin.length : visible.length}</b> {showTemporaryBin ? "photos in temporary bin" : search ? "matching photos" : "photos"}{selectionMode && <span className="selection-status">{selectedIds.length} selected</span>}{thumbnailsRemaining > 0 && <span className="preview-progress"> · Preparing {thumbnailsRemaining} previews</span>}</span><span>{showTemporaryBin ? "These photos are still on disk" : selectionMode ? "Drag a selected photo to move the group" : "Drag any photo to set the sequence"} <span className="meta-dot">·</span> Subfolders excluded</span></div>
      <div
        className={`photo-grid ${density} ${dragId ? "drag-active" : ""} ${showTemporaryBin ? "bin-grid" : ""} ${selectionMode ? "selection-active" : ""}`}
        ref={gridRef}
        onDragOver={(event) => {
          if (!dragId) event.preventDefault();
        }}
        onDrop={(event) => { if (!dragId) event.preventDefault(); }}
      >
        {(showTemporaryBin ? binPhotos : visible).map((photo) => {
          if (showTemporaryBin) return <article className={`photo-card bin-card ${selectedIds.includes(photo.id) ? "is-selected" : ""}`} key={photo.id}>
            <button className="photo-image" onClick={() => selectionMode ? togglePhotoSelection(photo.id) : setSelected(photo)} aria-pressed={selectionMode ? selectedIds.includes(photo.id) : undefined} aria-label={selectionMode ? `${selectedIds.includes(photo.id) ? "Deselect" : "Select"} ${photo.name}` : `Preview ${photo.name}`}><Image src={`${photo.thumbnail}&v=${thumbnailRevision}`} alt="" fill sizes={density === "compact" ? "14vw" : "20vw"} unoptimized/>{selectionMode && <span className="selection-badge">{selectedIds.includes(photo.id) ? <Icon name="check" size={14}/> : ""}</span>}</button>
            <div className="photo-caption"><span title={photo.name}>{photo.name}</span>{!selectionMode && <button className="restore-button" onClick={() => restoreBinPhotos([temporaryBin.find(({ photo: itemPhoto }) => itemPhoto.id === photo.id)!])} aria-label={`Restore ${photo.name}`} title="Restore to photo list"><Icon name="undo" size={15}/></button>}</div>
          </article>;
          const sequence = order.indexOf(photo.id) + 1;
          return <article
            key={photo.id}
            className={`photo-card ${dragIds.includes(photo.id) ? "is-dragging" : ""} ${selectedIds.includes(photo.id) ? "is-selected" : ""}`}
            data-photo-id={photo.id}
            draggable
            onDragStart={(event) => { const idsToMove = selectedIds.includes(photo.id) ? order.filter((id) => selectedIds.includes(id)) : [photo.id]; setDragId(photo.id); setDragIds(idsToMove); updateStoredInsertIndex(null); const emptyDragImage = document.createElement("canvas"); emptyDragImage.width = 1; emptyDragImage.height = 1; event.dataTransfer.setDragImage(emptyDragImage, 0, 0); event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("text/plain", JSON.stringify(idsToMove)); }}
            onDragEnd={() => { setDragId(null); setDragIds([]); updateStoredInsertIndex(null); }}
          >
            <button className="photo-image" onClick={() => selectionMode ? togglePhotoSelection(photo.id) : setSelected(photo)} aria-pressed={selectionMode ? selectedIds.includes(photo.id) : undefined} aria-label={selectionMode ? `${selectedIds.includes(photo.id) ? "Deselect" : "Select"} ${photo.name}` : `Preview ${photo.name}`}><Image src={`${photo.thumbnail}&v=${thumbnailRevision}`} alt="" fill sizes={density === "compact" ? "14vw" : "20vw"} unoptimized/><span className="sequence-badge">{String(sequence).padStart(2, "0")}</span>{selectionMode && <span className="selection-badge">{selectedIds.includes(photo.id) ? <Icon name="check" size={14}/> : ""}</span>}</button>
            {!selectionMode && <div className="photo-menu-anchor" ref={activeMenu === photo.id ? menuRef : null}>
              <button className={`photo-menu-trigger ${activeMenu === photo.id ? "open" : ""}`} aria-label={`Actions for ${photo.name}`} aria-haspopup="menu" aria-expanded={activeMenu === photo.id} title="Photo actions" onClick={() => setActiveMenu((current) => current === photo.id ? null : photo.id)}><Icon name="more" size={18}/></button>
              {activeMenu === photo.id && <div className="photo-menu" role="menu"><button role="menuitem" onClick={() => { setSelected(photo); setActiveMenu(null); }}>View</button><button role="menuitem" className="delete-menu-item" onClick={() => moveToTemporaryBin([photo.id])}>Delete</button></div>}
            </div>}
            <div className="photo-caption"><span title={photo.name}>{photo.name}</span><button aria-label={`Move ${photo.name} earlier`} disabled={sequence === 1} onClick={() => move(photo.id, sequence - 2)}>↑</button><button aria-label={`Move ${photo.name} later`} disabled={sequence === order.length} onClick={() => move(photo.id, sequence)}>↓</button></div>
          </article>;
        })}
      </div>
      {dragId && draggedPhoto && <div ref={dragGhostRef} className="drag-ghost" aria-hidden="true"><Image src={`${draggedPhoto.thumbnail}&v=${thumbnailRevision}`} alt="" width={140} height={100} unoptimized/>{dragIds.length > 1 && <span className="drag-ghost-count">{dragIds.length}</span>}</div>}
      <span ref={indicatorRef} className={`drop-indicator ${density === "compact" ? "horizontal" : "vertical"}`} data-insert-index={insertIndex ?? undefined} aria-hidden="true" />
      {(showTemporaryBin ? temporaryBin.length === 0 : visible.length === 0) && <div className="no-results">{showTemporaryBin ? <><Icon name="check" size={24}/><p>Your temporary bin is empty</p><button className="text-button" onClick={() => setShowTemporaryBin(false)}>Back to photos</button></> : <><Icon name="search" size={24}/><p>No photos match “{search}”</p><button className="text-button" onClick={() => setSearch("")}>Clear search</button></>}</div>}
      <footer className="action-bar"><div className="action-summary"><span className="summary-count">{ordered.length}<small>photos</small></span><span className="action-divider"/><span><b>{changedRows.length}</b> files will be renamed</span><span className="safe-label"><span>✓</span> Originals stay unchanged</span></div><div className="action-buttons"><button className="button button-secondary" disabled={!changedRows.length || !!filenameError} onClick={() => setPreview(true)}>Preview rename</button><button className="button button-primary save-button" disabled={!changed || !!busy || !!conflicts.length || !!filenameError} onClick={() => setPreview(true)}><Icon name="check" size={17}/>{busy || "Save"}</button></div></footer>
    </>}

    {(busy || progress > 0) && <div className="progress-track"><span style={{ width: `${progress || 8}%` }}/></div>}
    {error && <div className="toast toast-error" role="alert"><span>!</span>{error}<button onClick={() => setError("")} aria-label="Dismiss"><Icon name="close" size={15}/></button></div>}
    {notice && <div className="toast toast-success" role="status"><span>✓</span>{notice}<button onClick={() => setNotice("")} aria-label="Dismiss"><Icon name="close" size={15}/></button></div>}

    {preview && folder && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setPreview(false); }}><section className="preview-modal" role="dialog" aria-modal="true" aria-labelledby="preview-title"><div className="modal-head"><div><div className="eyebrow"><span className="eyebrow-line"/>REVIEW BEFORE SAVING</div><h2 id="preview-title">Your new sequence</h2><p>Review each filename before any changes are made.</p></div><button className="icon-button" onClick={() => setPreview(false)} aria-label="Close"><Icon name="close"/></button></div>
      <div className="settings-row"><label>Filename prefix<input value={settings.prefix} onChange={(event) => setSettings({ ...settings, prefix: event.target.value })}/></label><label>Start number<input type="number" min="0" value={settings.start} onChange={(event) => setSettings({ ...settings, start: Math.max(0, Number(event.target.value)) })}/></label><label>Interval<input type="number" min="1" value={settings.interval} onChange={(event) => setSettings({ ...settings, interval: Math.max(1, Number(event.target.value)) })}/></label></div>
      <div className="preview-summary"><span><b>{changedRows.length}</b> files to rename</span><span>{filenameError ? <b className="conflict-text">{filenameError}</b> : conflicts.length ? <b className="conflict-text">{conflicts.length} naming conflicts</b> : "No naming conflicts"}</span></div>
      <div className="rename-table"><div className="rename-table-head"><span>POSITION</span><span>BEFORE</span><span>AFTER</span></div><div className="rename-table-body">{plan.map((row) => <div className="rename-row" key={row.id}><span className="position-tag">{String(row.position).padStart(2, "0")}</span><span title={row.from}>{row.from}</span><span className={row.from === row.to ? "same-name" : "new-name"} title={row.to}>{row.to}</span></div>)}</div></div>
      <div className="modal-foot"><button className="button button-secondary" onClick={() => setPreview(false)}>Cancel</button><button className="button button-primary" disabled={!changedRows.length || !!conflicts.length || !!filenameError || !!busy} onClick={save}><Icon name="check" size={16}/>Save {changedRows.length} changes</button></div>
    </section></div>}
    {selected && <div className="modal-backdrop photo-backdrop" onClick={() => setSelected(null)}><section className="large-preview" role="dialog" aria-modal="true" onClick={(event) => event.stopPropagation()}><button className="icon-button close-preview" onClick={() => setSelected(null)} aria-label="Close preview"><Icon name="close"/></button><Image src={`${selected.thumbnail}&v=${thumbnailRevision}`} alt={selected.name} width={1200} height={900} unoptimized/><div><b>{selected.name}</b><span>{temporaryBin.some(({ photo }) => photo.id === selected.id) ? "In temporary bin" : `Position ${String(order.indexOf(selected.id) + 1).padStart(2, "0")} of ${order.length}`}</span></div></section></div>}
    <div className="app-footer"><span>Wedding Photo Sorter</span><span>Local by design <span>✳</span></span></div>
  </main>;
}
