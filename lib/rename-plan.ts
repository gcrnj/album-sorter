export type RenameInput = { id: string; name: string };
export type RenameSettings = { prefix: string; start: number; interval: number; width: number };
export type RenamePlanRow = { id: string; from: string; to: string; position: number };

export function generateRenamePlan(photos: RenameInput[], settings: RenameSettings): RenamePlanRow[] {
  const prefix = settings.prefix.trim();
  if (!prefix || /[\\/:\0]/.test(prefix)) throw new Error("Enter a filename prefix without slashes.");
  if (!Number.isSafeInteger(settings.start) || settings.start < 0) throw new Error("Starting number must be a non-negative whole number.");
  if (!Number.isSafeInteger(settings.interval) || settings.interval < 1) throw new Error("Numbering interval must be a positive whole number.");
  return photos.map((photo, index) => {
    const dot = photo.name.lastIndexOf(".");
    const extension = dot > -1 ? photo.name.slice(dot) : "";
    const number = settings.start + index * settings.interval;
    if (!Number.isSafeInteger(number)) throw new Error("The numbering settings exceed the safe integer range.");
    return { id: photo.id, from: photo.name, to: `${prefix}_${String(number).padStart(settings.width, "0")}${extension}`, position: index + 1 };
  });
}

export function movePhoto(order: string[], id: string, destination: number) {
  const from = order.indexOf(id);
  if (from < 0) return order;
  const next = [...order];
  next.splice(from, 1);
  next.splice(Math.max(0, Math.min(destination, next.length)), 0, id);
  return next;
}
