import type { AttachmentInput } from "@harness/api";

/** An attachment waiting in the prompt box. `preview`: data URL for pasted/picked image bytes. */
export type PendingAttachment = { id: string; name: string; kind: "image" | "file"; input: AttachmentInput; preview?: string };

export const IMAGE_MAX_BYTES = 5 * 1024 * 1024;
export const IMAGE_MAX_SIDE = 2000;
/** Pasted non-image bytes (the core embeds text files up to 1 MB, links the rest). */
export const FILE_MAX_BYTES = 5 * 1024 * 1024;

const IMAGE_EXT = /\.(png|jpe?g|gif|webp)$/i;

export const baseName = (path: string) => path.split(/[\\/]/).pop() || path;
export const isImageName = (name: string) => IMAGE_EXT.test(name);

let n = 0;
const nextId = () => `att-${Date.now().toString(36)}-${n++}`;

export function fromPath(path: string): PendingAttachment {
  const name = baseName(path);
  return { id: nextId(), name, kind: isImageName(name) ? "image" : "file", input: { type: "path", path } };
}

/** Scale (w, h) down to fit `max` on the longer side; unchanged when it already fits. */
export function fitWithin(w: number, h: number, max: number): [number, number] {
  const s = Math.min(1, max / Math.max(w, h));
  return [Math.round(w * s), Math.round(h * s)];
}

const readDataUrl = (blob: Blob) =>
  new Promise<string>((ok, fail) => {
    const r = new FileReader();
    r.onload = () => ok(r.result as string);
    r.onerror = () => fail(r.error);
    r.readAsDataURL(blob);
  });

/** Larger than IMAGE_MAX_SIDE: redrawn smaller (PNG stays PNG, the rest becomes JPEG). GIFs are kept as-is (animation). */
async function downscale(file: File, dataUrl: string): Promise<string> {
  if (file.type === "image/gif") return dataUrl;
  const img = new Image();
  img.src = dataUrl;
  await img.decode();
  const [w, h] = fitWithin(img.naturalWidth, img.naturalHeight, IMAGE_MAX_SIDE);
  if (w === img.naturalWidth && h === img.naturalHeight) return dataUrl;
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  canvas.getContext("2d")!.drawImage(img, 0, 0, w, h);
  return canvas.toDataURL(file.type === "image/png" ? "image/png" : "image/jpeg", 0.9);
}

/** Bytes from paste, an `<input type="file">` or an HTML5 drop. Throws a user-facing message when too large. */
export async function fromFile(file: File): Promise<PendingAttachment> {
  const name = file.name || (file.type.startsWith("image/") ? `pasted.${file.type.split("/")[1] ?? "png"}` : "pasted");
  const image = file.type.startsWith("image/");
  let url = await readDataUrl(file);
  if (image) url = await downscale(file, url);
  const [head, data = ""] = url.split(",", 2);
  const mime = head!.slice(5).split(";")[0] || file.type || "application/octet-stream";
  const bytes = Math.floor((data.length * 3) / 4);
  const max = image ? IMAGE_MAX_BYTES : FILE_MAX_BYTES;
  if (bytes > max) throw new Error(`${name} is too large (max ${max / 1024 / 1024} MB).`);
  return { id: nextId(), name, kind: image ? "image" : "file", input: { type: "data", name, mime, data }, ...(image && { preview: url }) };
}
