import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  createObjectKey,
  FileObjectStore,
  ObjectStoreError,
} from "../dist/index.js";

async function createStore(t, maximumObjectBytes = 1024) {
  const rootDirectory = await mkdtemp(join(tmpdir(), "singularity-objects-"));
  t.after(async () => rm(rootDirectory, { force: true, recursive: true }));
  return {
    rootDirectory,
    store: await FileObjectStore.open({
      maximumObjectBytes,
      rootDirectory,
    }),
  };
}

test("writes, verifies, reads, and deletes one immutable object", async (t) => {
  const { store } = await createStore(t);
  const key = createObjectKey();
  const value = Buffer.from("versioned backup payload", "utf8");
  const sha256 = createHash("sha256").update(value).digest("hex");

  assert.deepEqual(await store.putBytes(key, value, sha256), {
    key,
    sha256,
    sizeBytes: value.byteLength,
  });
  assert.deepEqual(await store.read(key, value.byteLength), value);
  assert.deepEqual(await store.digest(key, value.byteLength), {
    key,
    sha256,
    sizeBytes: value.byteLength,
  });
  assert.equal((await store.stat(key)).sizeBytes, value.byteLength);

  await store.delete(key);
  await assert.rejects(
    store.stat(key),
    (error) =>
      error instanceof ObjectStoreError && error.code === "not-found",
  );
});

test("keeps exclusive creation and removes failed temporary writes", async (t) => {
  const { rootDirectory, store } = await createStore(t, 16);
  const key = createObjectKey();

  await store.putBytes(key, Buffer.from("first", "utf8"));
  await assert.rejects(
    store.putBytes(key, Buffer.from("second", "utf8")),
    (error) =>
      error instanceof ObjectStoreError && error.code === "already-exists",
  );
  await assert.rejects(
    store.putBytes(createObjectKey(), Buffer.alloc(17)),
    (error) =>
      error instanceof ObjectStoreError && error.code === "size-limit-exceeded",
  );

  assert.deepEqual(await readdir(rootDirectory), [key]);
  assert.deepEqual(await store.read(key, 16), Buffer.from("first", "utf8"));
});

test("rejects symbolic links at the object boundary", async (t) => {
  const { rootDirectory, store } = await createStore(t);
  const outsideDirectory = await mkdtemp(join(tmpdir(), "singularity-outside-"));
  t.after(async () => rm(outsideDirectory, { force: true, recursive: true }));
  const outsideFile = join(outsideDirectory, "content");
  const key = createObjectKey();
  await writeFile(outsideFile, "outside", { encoding: "utf8", mode: 0o600 });
  await symlink(outsideFile, join(rootDirectory, key));

  await assert.rejects(
    store.read(key, 1024),
    (error) =>
      error instanceof ObjectStoreError && error.code === "corrupt-object",
  );
});
