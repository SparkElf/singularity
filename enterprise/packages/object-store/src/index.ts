import { createHash, randomBytes } from "node:crypto";
import type { Stats } from "node:fs";
import {
  constants,
  link,
  lstat,
  mkdir,
  open,
  realpath,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { Readable } from "node:stream";

const OBJECT_KEY_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const READ_CHUNK_BYTES = 64 * 1_024;

declare const objectKeyBrand: unique symbol;
export type ObjectKey = string & { readonly [objectKeyBrand]: true };

export class ObjectStoreError extends Error {
  constructor(
    readonly code:
      | "already-exists"
      | "corrupt-object"
      | "invalid-configuration"
      | "invalid-key"
      | "not-found"
      | "size-limit-exceeded",
  ) {
    super(`Object store operation failed: ${code}`);
    this.name = "ObjectStoreError";
  }
}

export interface ObjectWriteInput {
  expectedSha256?: string;
  key: ObjectKey;
  maximumBytes?: number;
  source: AsyncIterable<Uint8Array> | Iterable<Uint8Array>;
}

export interface StoredObject {
  key: ObjectKey;
  sha256: string;
  sizeBytes: number;
}

export interface StoredObjectStat {
  key: ObjectKey;
  modifiedAt: Date;
  sizeBytes: number;
}

export interface FileObjectStoreOptions {
  maximumObjectBytes: number;
  rootDirectory: string;
}

function requirePositiveInteger(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new ObjectStoreError("invalid-configuration");
  }
  return value;
}

function isMissing(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

function isAlreadyPresent(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "EEXIST"
  );
}

function requireRegularFile(stat: Stats): void {
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new ObjectStoreError("corrupt-object");
  }
}

export function createObjectKey(): ObjectKey {
  return randomBytes(32).toString("base64url") as ObjectKey;
}

export function parseObjectKey(value: string): ObjectKey {
  if (!OBJECT_KEY_PATTERN.test(value)) {
    throw new ObjectStoreError("invalid-key");
  }
  return value as ObjectKey;
}

export class FileObjectStore {
  readonly #maximumObjectBytes: number;
  readonly #rootDirectory: string;

  private constructor(options: FileObjectStoreOptions, rootDirectory: string) {
    this.#maximumObjectBytes = requirePositiveInteger(options.maximumObjectBytes);
    this.#rootDirectory = rootDirectory;
  }

  static async open(options: FileObjectStoreOptions): Promise<FileObjectStore> {
    if (!isAbsolute(options.rootDirectory)) {
      throw new ObjectStoreError("invalid-configuration");
    }
    const rootDirectory = resolve(options.rootDirectory);
    await mkdir(rootDirectory, { mode: 0o700, recursive: true });
    const rootStat = await lstat(rootDirectory);
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
      throw new ObjectStoreError("invalid-configuration");
    }
    if ((await realpath(rootDirectory)) !== rootDirectory) {
      throw new ObjectStoreError("invalid-configuration");
    }
    return new FileObjectStore(options, rootDirectory);
  }

  async put(input: ObjectWriteInput): Promise<StoredObject> {
    const maximumBytes = Math.min(
      this.#maximumObjectBytes,
      input.maximumBytes === undefined
        ? this.#maximumObjectBytes
        : requirePositiveInteger(input.maximumBytes),
    );
    if (
      input.expectedSha256 !== undefined &&
      !SHA256_PATTERN.test(input.expectedSha256)
    ) {
      throw new ObjectStoreError("corrupt-object");
    }

    const destination = this.#pathFor(input.key);
    const temporary = join(
      this.#rootDirectory,
      `.object-${randomBytes(24).toString("hex")}.tmp`,
    );
    let handle: FileHandle | undefined;
    try {
      handle = await open(
        temporary,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
        0o600,
      );
      const hash = createHash("sha256");
      let sizeBytes = 0;
      for await (const rawChunk of input.source) {
        const chunk = Buffer.from(
          rawChunk.buffer,
          rawChunk.byteOffset,
          rawChunk.byteLength,
        );
        sizeBytes += chunk.byteLength;
        if (sizeBytes > maximumBytes) {
          throw new ObjectStoreError("size-limit-exceeded");
        }
        hash.update(chunk);
        await this.#writeAll(handle, chunk);
      }
      const sha256 = hash.digest("hex");
      if (
        input.expectedSha256 !== undefined &&
        sha256 !== input.expectedSha256
      ) {
        throw new ObjectStoreError("corrupt-object");
      }
      await handle.sync();
      await handle.close();
      handle = undefined;
      try {
        await link(temporary, destination);
      } catch (error) {
        if (isAlreadyPresent(error)) {
          throw new ObjectStoreError("already-exists");
        }
        throw error;
      }
      await unlink(temporary);
      return { key: input.key, sha256, sizeBytes };
    } finally {
      if (handle !== undefined) {
        await handle.close();
      }
      await this.#removeIfPresent(temporary);
    }
  }

  async putBytes(
    key: ObjectKey,
    value: Uint8Array,
    expectedSha256?: string,
  ): Promise<StoredObject> {
    return this.put({
      ...(expectedSha256 === undefined ? {} : { expectedSha256 }),
      key,
      source: [value],
    });
  }

  async read(key: ObjectKey, maximumBytes: number): Promise<Buffer> {
    const chunks: Buffer[] = [];
    for await (const chunk of await this.openReadStream(key, maximumBytes)) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }

  async digest(key: ObjectKey, maximumBytes: number): Promise<StoredObject> {
    const hash = createHash("sha256");
    let sizeBytes = 0;
    for await (const chunk of await this.openReadStream(key, maximumBytes)) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      sizeBytes += bytes.byteLength;
      hash.update(bytes);
    }
    return { key, sha256: hash.digest("hex"), sizeBytes };
  }

  async openReadStream(key: ObjectKey, maximumBytes: number): Promise<Readable> {
    const limit = Math.min(
      this.#maximumObjectBytes,
      requirePositiveInteger(maximumBytes),
    );
    const handle = await this.#openRegularFile(key);
    const stat = await handle.stat();
    if (stat.size > limit) {
      await handle.close();
      throw new ObjectStoreError("size-limit-exceeded");
    }

    async function* readChunks(): AsyncGenerator<Buffer> {
      let totalBytes = 0;
      try {
        while (true) {
          const chunk = Buffer.allocUnsafe(READ_CHUNK_BYTES);
          const { bytesRead } = await handle.read(
            chunk,
            0,
            chunk.byteLength,
            null,
          );
          if (bytesRead === 0) {
            return;
          }
          totalBytes += bytesRead;
          if (totalBytes > limit) {
            throw new ObjectStoreError("size-limit-exceeded");
          }
          yield chunk.subarray(0, bytesRead);
        }
      } finally {
        await handle.close();
      }
    }

    return Readable.from(readChunks());
  }

  async stat(key: ObjectKey): Promise<StoredObjectStat> {
    const path = this.#pathFor(key);
    let stat: Stats;
    try {
      stat = await lstat(path);
    } catch (error) {
      if (isMissing(error)) {
        throw new ObjectStoreError("not-found");
      }
      throw error;
    }
    requireRegularFile(stat);
    return { key, modifiedAt: stat.mtime, sizeBytes: stat.size };
  }

  async delete(key: ObjectKey): Promise<void> {
    await this.stat(key);
    try {
      await unlink(this.#pathFor(key));
    } catch (error) {
      if (isMissing(error)) {
        throw new ObjectStoreError("not-found");
      }
      throw error;
    }
  }

  #pathFor(key: ObjectKey): string {
    parseObjectKey(key);
    return join(this.#rootDirectory, key);
  }

  async #openRegularFile(key: ObjectKey): Promise<FileHandle> {
    const path = this.#pathFor(key);
    let before: Stats;
    try {
      before = await lstat(path);
    } catch (error) {
      if (isMissing(error)) {
        throw new ObjectStoreError("not-found");
      }
      throw error;
    }
    requireRegularFile(before);

    let handle: FileHandle;
    try {
      handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error) {
      if (isMissing(error)) {
        throw new ObjectStoreError("not-found");
      }
      throw error;
    }
    const after = await handle.stat();
    if (!after.isFile() || before.dev !== after.dev || before.ino !== after.ino) {
      await handle.close();
      throw new ObjectStoreError("corrupt-object");
    }
    return handle;
  }

  async #writeAll(handle: FileHandle, chunk: Buffer): Promise<void> {
    let offset = 0;
    while (offset < chunk.byteLength) {
      const { bytesWritten } = await handle.write(
        chunk,
        offset,
        chunk.byteLength - offset,
      );
      if (bytesWritten === 0) {
        throw new ObjectStoreError("corrupt-object");
      }
      offset += bytesWritten;
    }
  }

  async #removeIfPresent(path: string): Promise<void> {
    try {
      await unlink(path);
    } catch (error) {
      if (!isMissing(error)) {
        throw error;
      }
    }
  }
}
