import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { PathLike } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { generateRenamePlan, movePhoto } from "../lib/rename-plan";
import { isSupportedImageName, registerFolderSession, safeRename, savePlan, undoLastSave } from "../lib/local-files";

async function fixture(files: Record<string, Buffer | string>) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "wedding-sorter-test-"));
  for (const [name, contents] of Object.entries(files)) await fs.writeFile(path.join(directory, name), contents);
  return directory;
}

async function hash(filePath: string) {
  return createHash("sha256").update(await fs.readFile(filePath)).digest("hex");
}

test("reordering moves a photo to any sequence position", () => {
  assert.deepEqual(movePhoto(["a", "b", "c", "d"], "d", 1), ["a", "d", "b", "c"]);
  assert.deepEqual(movePhoto(["a", "b", "c"], "missing", 0), ["a", "b", "c"]);
});

test("filename plan pads sequence numbers and preserves extensions", () => {
  assert.deepEqual(generateRenamePlan([{ id: "1", name: "one.JPG" }, { id: "2", name: "two.heic" }], { prefix: "Wedding", start: 100, interval: 100, width: 5 }).map(({ to }) => to), ["Wedding_00100.JPG", "Wedding_00200.heic"]);
});

test("filename plan permits an insertion between interval numbers", () => {
  const plan = generateRenamePlan(["a.jpg", "insert.png", "b.jpg"].map((name, i) => ({ id: String(i), name })), { prefix: "Wedding", start: 200, interval: 1, width: 5 });
  assert.deepEqual(plan.map((row) => row.to), ["Wedding_00200.jpg", "Wedding_00201.png", "Wedding_00202.jpg"]);
});

test("supported image extensions include JPEG, PNG, HEIC, and WebP and skip TIFF", () => {
  for (const name of ["a.jpg", "a.JPEG", "a.png", "a.heic", "a.webp"]) assert.equal(isSupportedImageName(name), true);
  assert.equal(isSupportedImageName("scan.tiff"), false);
  assert.equal(isSupportedImageName("notes.txt"), false);
});

test("filename planning remains linear for collections of one thousand photos", () => {
  const photos = Array.from({ length: 1000 }, (_, i) => ({ id: String(i), name: `photo-${i}.jpg` }));
  const plan = generateRenamePlan(photos, { prefix: "Wedding", start: 100, interval: 100, width: 5 });
  assert.equal(plan.length, 1000);
  assert.equal(plan[999].to, "Wedding_100000.jpg");
});

test("two phase rename safely swaps names and preserves bytes and hashes", async (t) => {
  const directory = await fixture({ "one.jpg": Buffer.from([0, 255, 3, 4]), "two.jpg": Buffer.from("original two bytes") });
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const before = [await hash(path.join(directory, "one.jpg")), await hash(path.join(directory, "two.jpg"))];
  await safeRename(directory, [{ from: "one.jpg", to: "two.jpg" }, { from: "two.jpg", to: "one.jpg" }]);
  assert.deepEqual([await hash(path.join(directory, "two.jpg")), await hash(path.join(directory, "one.jpg"))], before);
});

test("filename collision with an unrelated file is rejected without changing sources", async (t) => {
  const directory = await fixture({ "photo.jpg": "photo", "Wedding_00100.jpg": "keep" });
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await assert.rejects(safeRename(directory, [{ from: "photo.jpg", to: "Wedding_00100.jpg" }]), /already exists/);
  assert.equal(await fs.readFile(path.join(directory, "photo.jpg"), "utf8"), "photo");
  assert.equal(await fs.readFile(path.join(directory, "Wedding_00100.jpg"), "utf8"), "keep");
});

test("a destination created after validation is not overwritten", async (t) => {
  const directory = await fixture({ "photo.jpg": "photo" });
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  let raced = false;
  const link = (async (from: PathLike, to: PathLike) => {
    if (!raced) { raced = true; await fs.writeFile(String(to), "external file"); }
    return fs.link(from, to);
  }) as typeof fs.link;
  await assert.rejects(safeRename(directory, [{ from: "photo.jpg", to: "target.jpg" }], { rename: fs.rename, link, unlink: fs.unlink }), /rolled back/);
  assert.equal(await fs.readFile(path.join(directory, "photo.jpg"), "utf8"), "photo");
  assert.equal(await fs.readFile(path.join(directory, "target.jpg"), "utf8"), "external file");
});

test("missing sources are rejected before any rename", async (t) => {
  const directory = await fixture({ "one.jpg": "one" });
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await assert.rejects(safeRename(directory, [{ from: "one.jpg", to: "renamed.jpg" }, { from: "gone.jpg", to: "new.jpg" }]), /missing/);
  assert.equal(await fs.readFile(path.join(directory, "one.jpg"), "utf8"), "one");
});

test("a phase two failure rolls completed moves back to their original paths", async (t) => {
  const directory = await fixture({ "one.jpg": "one", "two.jpg": "two" });
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const realRename = fs.rename.bind(fs);
  let failed = false;
  const link = (async (from: PathLike, to: PathLike) => {
    if (!failed && String(to).endsWith("new-two.jpg")) { failed = true; throw new Error("simulated destination claim failure"); }
    return fs.link(from, to);
  }) as typeof fs.link;
  await assert.rejects(safeRename(directory, [{ from: "one.jpg", to: "new-one.jpg" }, { from: "two.jpg", to: "new-two.jpg" }], { rename: realRename, link, unlink: fs.unlink }), /rolled back/);
  assert.equal(await fs.readFile(path.join(directory, "one.jpg"), "utf8"), "one");
  assert.equal(await fs.readFile(path.join(directory, "two.jpg"), "utf8"), "two");
  assert.deepEqual((await fs.readdir(directory)).sort(), ["one.jpg", "two.jpg"]);
});

test("save makes no changes before invocation and saved rename can be undone", async (t) => {
  const directory = await fixture({ "original.jpg": Buffer.from("photo bytes") });
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const photoPath = path.join(directory, "original.jpg");
  const before = await hash(photoPath);
  const session = registerFolderSession(directory, [{ id: "photo-id", name: "original.jpg", size: (await fs.stat(photoPath)).size, modified: 0, thumbnail: "", filePath: photoPath }]);
  assert.equal(await fs.readFile(photoPath, "utf8"), "photo bytes");
  await savePlan(session.id, [{ id: "photo-id", to: "Wedding_00100.jpg" }]);
  assert.equal(await hash(path.join(directory, "Wedding_00100.jpg")), before);
  const restored = await undoLastSave();
  assert.equal(restored.photos[0].name, "original.jpg");
  assert.equal(await hash(photoPath), before);
});

test("duplicate destination names are rejected", async (t) => {
  const directory = await fixture({ "one.jpg": "1", "two.jpg": "2" });
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await assert.rejects(safeRename(directory, [{ from: "one.jpg", to: "same.jpg" }, { from: "two.jpg", to: "same.jpg" }]), /Two photos/);
});
