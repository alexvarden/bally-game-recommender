/**
 * Embedders behind the shared Embedder contract.
 *
 * LocalEmbedder runs a small sentence-embedding model on CPU via transformers.js: free, offline after the first
 * download, deterministic. HashEmbedder is a dependency-free bag-of-words stand-in for tests and CI, where we don't
 * want a model download.
 */
import { createHash } from "node:crypto";
import type { Embedder } from "../contracts/ranking.ts";

export const DEFAULT_LOCAL_MODEL = "Xenova/bge-small-en-v1.5";
export const MODEL_CACHE_DIR = ".cache/models";

export function normalise(v: number[]): number[] {
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return norm === 0 ? v : v.map((x) => x / norm);
}

/** Cosine similarity of two vectors; 0 if either is all zeros. */
export function cosine(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb);
}

/** What LocalEmbedder needs from transformers.js; injectable so tests don't download a model. */
export type FeatureExtractor = (texts: string[], options: { pooling: "mean"; normalize: boolean }) => Promise<{ tolist(): number[][] }>;
export type ExtractorLoader = (model: string, cacheDir: string) => Promise<FeatureExtractor>;

export const loadTransformersExtractor: ExtractorLoader = async (model, cacheDir) => {
  const { pipeline, env } = await import("@huggingface/transformers");
  env.cacheDir = cacheDir;
  return (await pipeline("feature-extraction", model)) as unknown as FeatureExtractor;
};

export class LocalEmbedder implements Embedder {
  readonly model: string;
  readonly dimensions = 384;
  private readonly load: ExtractorLoader;
  private readonly cacheDir: string;
  private extractor: Promise<FeatureExtractor> | undefined;

  constructor(model = DEFAULT_LOCAL_MODEL, load: ExtractorLoader = loadTransformersExtractor, cacheDir = MODEL_CACHE_DIR) {
    this.model = model;
    this.load = load;
    this.cacheDir = cacheDir;
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    this.extractor ??= this.load(this.model, this.cacheDir);
    const output = await (await this.extractor)(texts, { pooling: "mean", normalize: true });
    return output.tolist();
  }
}

export const tokenise = (text: string) => text.toLowerCase().match(/[a-z0-9]+/g) ?? [];

/** Deterministic bag-of-words hashing embedder. Similar wording gives similar vectors; meaning is not captured. */
export class HashEmbedder implements Embedder {
  readonly model: string;
  readonly dimensions: number;

  constructor(dimensions = 64) {
    this.dimensions = dimensions;
    this.model = `hash-bow-${dimensions}`;
  }

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((t) => this.vector(t));
  }

  private vector(text: string): number[] {
    const v = new Array<number>(this.dimensions).fill(0);
    for (const token of tokenise(text)) {
      const h = createHash("sha256").update(token).digest();
      v[h.readUInt32BE(0) % this.dimensions]! += 1;
    }
    return normalise(v);
  }
}
