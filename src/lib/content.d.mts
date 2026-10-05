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
  unlisted?: boolean;
  abs: string;
  width: number;
  height: number;
  ar: number;
  hash: string;
  mtimeMs: number;
  images: ImageSet;
};
export type Option<T = string> = { id: T; label: string };
export type Content = {
  photos: Photo[];
  categories: Option[];
  styles: Option[];
  years: Option<number>[];
  warnings: string[];
};

export const ROOT: string;
export const CONTENT_DIR: string;
export const PHOTOS_DIR: string;
export const IMG_OUT_DIR: string;
export const IMG_URL: string;
export const SIZES: { thumb: number[]; large: number[]; preview: number; og: number };
export const UNCATEGORIZED: Option;
export class ContentError extends Error {
  errors: string[];
  constructor(errors: string[]);
}
export function slugify(s: string): string;
export function imageSet(p: Pick<Photo, 'slug' | 'hash' | 'width' | 'height'>): ImageSet;
export function loadContent(opts?: { fresh?: boolean }): Promise<Content>;
