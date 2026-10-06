// Types for content.mjs, so the Astro pages are type checked.
export type ImageFile = { name: string; url: string; w: number };
export type ImageSet = {
  thumb: { avif: ImageFile[]; webp: ImageFile[] };
  large: { avif: ImageFile[]; webp: ImageFile[] };
  preview: ImageFile;
  og: ImageFile;
};
export type Photo = {
  file: string;
  slug: string;
  title: string;
  categories: string[];
  style: string | null;
  year: number | null;
  focus: [number, number];
  /** Keywords stored in the file (XMP dc:subject, IPTC Keywords). */
  keywords: string[];
  /** Keywords plus Drive folder names and hashtags, as slugs; they decide categories and style. */
  tags: string[];
  /** Set for photos imported from Google Drive. */
  drive?: { id: string };
  abs: string;
  width: number;
  height: number;
  ar: number;
  hash: string;
  featured: boolean;
  /** Facts about the original, as stored in content/images.json. */
  source: Source;
  /** True when the original is a Git LFS pointer file and was not downloaded. */
  pointer: boolean;
  /** Image file names, set by scripts/images.mjs before writing images.json. */
  outputs?: string[];
  images: ImageSet;
};
export type Option<T = string> = { id: T; label: string };
export type Source = {
  sha256: string;
  hash: string;
  width: number;
  height: number;
  taken: string | null;
  keywords: string[];
  tree: string[][];
  title: string | null;
  monochrome: boolean;
};
export type ListItem = Option & { match: string[]; default: boolean; monochrome: boolean };
export type DriveEntry = { file: string; id: string; md5: string | null; paths: string[][]; description?: string; taken?: string };
export type Content = {
  photos: Photo[];
  categories: Option[];
  styles: Option[];
  years: Option<number>[];
  tagReport: {
    unmatched: [string, number][];
    fromKeywords: { kind: 'category' | 'style'; id: string; label: string; count: number }[];
  };
  warnings: string[];
};

export const ROOT: string;
export const CONTENT_DIR: string;
export const PHOTOS_DIR: string;
export const IMG_OUT_DIR: string;
export const IMG_URL: string;
export const SOURCES_FILE: string;
export function readSources(): Promise<Record<string, Source & { outputs: string[] }>>;
export function writeSources(photos: Photo[]): Promise<void>;
export function lfsPointer(buf: Buffer): string | null;
export const SIZES: { thumb: number[]; large: number[]; preview: number; og: number };
export const UNCATEGORIZED: Option;
export class ContentError extends Error {
  errors: string[];
  constructor(errors: string[]);
}
export function slugify(s: string): string;
export function imageSet(p: Pick<Photo, 'slug' | 'hash' | 'width' | 'height'>): ImageSet;
export function driveTags(d: Pick<DriveEntry, 'paths' | 'description'> | null | undefined): string[];
export function fromTags(
  source: { topics?: string[]; types?: string[]; drive?: DriveEntry | null; monochrome?: boolean },
  categories: ListItem[],
  styles: ListItem[],
): { tags: string[]; categories: string[]; style: string | null; year: number | null; title: string | null };
export function loadContent(opts?: { fresh?: boolean }): Promise<Content>;
