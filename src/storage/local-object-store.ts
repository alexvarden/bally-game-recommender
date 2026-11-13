/**
 * ObjectStore over a local folder: the development stand-in for the S3 bucket.
 *
 * Keys are slash-separated paths relative to the root. The etag is the SHA-256 of the content, so a re-uploaded
 * object with changed bytes gets a new etag, as with S3.
 */
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import type { ObjectStore, ObjectSummary } from "../contracts/storage.ts";

export const DEFAULT_BUCKET_DIR = "var/bucket";

export const etagOf = (body: Buffer | string) => createHash("sha256").update(body).digest("hex");

/** Rejects keys that could escape the bucket root. */
export function assertSafeKey(key: string) {
  if (!key || key.startsWith("/") || key.split("/").some((part) => part === ".." || part === "")) {
    throw new Error(`invalid object key: ${key}`);
  }
}

async function walk(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const nested = await Promise.all(
    entries.map((e) => (e.isDirectory() ? walk(join(dir, e.name)) : Promise.resolve([join(dir, e.name)]))),
  );
  return nested.flat();
}

export class LocalObjectStore implements ObjectStore {
  readonly root: string;

  constructor(root = DEFAULT_BUCKET_DIR) {
    this.root = root;
  }

  async list(prefix: string): Promise<ObjectSummary[]> {
    const files = await walk(this.root);
    const keys = files.map((f) => relative(this.root, f).split(sep).join("/")).filter((k) => k.startsWith(prefix));
    return Promise.all(keys.sort().map((key) => this.summary(key)));
  }

  async get(key: string): Promise<Buffer> {
    assertSafeKey(key);
    return readFile(join(this.root, key));
  }

  async put(key: string, body: Buffer | string): Promise<ObjectSummary> {
    assertSafeKey(key);
    const path = join(this.root, key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, body);
    return this.summary(key);
  }

  private async summary(key: string): Promise<ObjectSummary> {
    const path = join(this.root, key);
    const [body, info] = await Promise.all([readFile(path), stat(path)]);
    return { key, etag: etagOf(body), lastModified: info.mtime.toISOString() };
  }
}
