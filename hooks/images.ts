import type { EngineInterface, ImageSource } from 'claude-code'

import type { ImageRef } from '../types'

// Pictures in a todo agent's tool results. The database keeps a reference
// only: the file a Read named, or a sidecar the result's base64 was spooled to.
// The terminal's Image draws a PNG file itself, so a PNG on disk is drawn
// straight from its path; anything else (a JPEG, a spooled block) is turned
// into a small PNG in the data folder the first time the call browser shows it.

type $ = EngineInterface

const PICTURE = /\.(png|jpe?g|gif|webp|bmp|tiff?|heic)$/i
const TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  heic: 'image/heic',
}
const EXT: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' }

export const isPicture = (path: string) => PICTURE.test(path)
export const baseName = (path: string) => path.slice(path.lastIndexOf('/') + 1)
export const mediaTypeOf = (path: string) => TYPES[(path.split('.').pop() ?? '').toLowerCase()] ?? 'application/octet-stream'

export function size(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export const altOf = (im: ImageRef) => (im.bytes === undefined ? im.name : `${im.name} · ${size(im.bytes)}`)

type Block = { mediaType: string; base64: string }

const rec = (v: unknown): Record<string, unknown> | undefined =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined
const s = (v: unknown) => (typeof v === 'string' ? v : undefined)

// An image block in any of the shapes a result carries one: the API's
// `{ source: { media_type, data } }`, MCP's `{ data, mimeType }`, or the Read
// tool's `{ file: { base64, type } }`.
function blockOf(o: Record<string, unknown>): Block | undefined {
  if (o['type'] !== 'image') return undefined
  const src = rec(o['source'])
  const file = rec(o['file'])
  const base64 = s(src?.['data']) ?? s(o['data']) ?? s(file?.['base64'])
  if (!base64) return undefined
  const mediaType = s(src?.['media_type']) ?? s(o['mimeType']) ?? s(o['media_type']) ?? s(file?.['type']) ?? 'image/png'
  return { mediaType, base64 }
}

// The result's image blocks, and a copy of it with each block's bytes swapped
// for a stub, so the response text never carries base64.
export function splitImages(result: unknown): { blocks: Block[]; rest: unknown } {
  const blocks: Block[] = []
  const walk = (v: unknown, depth: number): unknown => {
    if (depth > 6) return v
    if (Array.isArray(v)) return v.map(x => walk(x, depth + 1))
    const o = rec(v)
    if (!o) return v
    const b = blockOf(o)
    if (b) {
      blocks.push(b)
      return `[image ${b.mediaType}]`
    }
    return Object.fromEntries(Object.entries(o).map(([k, x]) => [k, walk(x, depth + 1)]))
  }
  return { blocks, rest: walk(result, 0) }
}

const bytesOf = (base64: string) => Math.floor((base64.replace(/=+$/, '').length * 3) / 4)

// What a call's result carries, by reference: a Read of a picture is its file;
// other image blocks are spooled, as base64 text, beside the database.
export async function imageRefs($: $, o: { id: string; tool: string; filePath?: string; blocks: Block[]; folder?: string }) {
  if (o.tool === 'Read' && o.filePath !== undefined && isPicture(o.filePath)) {
    let bytes: number | undefined
    try {
      bytes = (await $.fs.stat(o.filePath)).size
    } catch {
      bytes = o.blocks[0] ? bytesOf(o.blocks[0].base64) : undefined
    }
    const im: ImageRef = { name: baseName(o.filePath), path: o.filePath, mediaType: mediaTypeOf(o.filePath) }
    return [bytes === undefined ? im : { ...im, bytes }]
  }
  if (o.blocks.length === 0 || o.folder === undefined) return []
  const out: ImageRef[] = []
  for (const [i, b] of o.blocks.entries()) {
    const path = `${o.folder}/images/${o.id.replace(/[^\w.-]/g, '_')}-${i}.b64`
    try {
      await $.fs.write(path, b.base64)
    } catch {
      continue
    }
    const ext = EXT[b.mediaType] ?? 'img'
    out.push({ name: `${o.tool} image ${i + 1}.${ext}`, path, bytes: bytesOf(b.base64), mediaType: b.mediaType, spooled: true })
  }
  return out
}

// ---------- drawing them ----------

// A PNG file is drawn straight from its path; the rest need a PNG made first.
const isDirect = (im: ImageRef) => !im.spooled && im.mediaType === 'image/png'

// The PNG an image is drawn from, once `thumbnail` has vouched for it.
export function sourceOf(im: ImageRef, thumbs: Record<string, string>): ImageSource | undefined {
  const t = thumbs[im.path]
  return t ? { file: t, format: 'png' } : undefined
}

function hash(text: string) {
  let h = 5381
  for (let i = 0; i < text.length; i++) h = ((h * 33) ^ text.charCodeAt(i)) >>> 0
  return h.toString(16)
}

async function ran($: $, argv: string[]) {
  try {
    return (await $.process.run(argv)).exitCode === 0
  } catch {
    return false
  }
}

// Whether the file is there and $.fs will read it: the host refuses a whole
// drawing whose Image names a path it won't open (a network mount, a device),
// so a picture is only drawn from a path that passed this.
async function isReadable($: $, path: string) {
  try {
    return (await $.fs.stat(path)).kind === 'file'
  } catch {
    return false
  }
}

// The PNG an Image draws for `im`: a PNG file as it is; else one made in
// `folder`/thumbs, the spooled base64 decoded and a picture that isn't a PNG
// scaled down by sips (macOS) or ImageMagick. Resolves its path, or '' when
// there's nothing to draw.
export async function thumbnail($: $, im: ImageRef, folder: string) {
  if (isDirect(im)) return (await isReadable($, im.path)) ? im.path : ''
  const png = await make($, im, folder)
  return png && (await isReadable($, png)) ? png : ''
}

async function make($: $, im: ImageRef, folder: string) {
  const dir = `${folder}/thumbs`
  const key = hash(im.path)
  if (!(await ran($, ['mkdir', '-p', dir]))) return ''
  let src = im.path
  if (im.spooled) {
    src = `${dir}/${key}.${EXT[im.mediaType] ?? 'img'}`
    if (!(await ran($, ['sh', '-c', 'base64 -d < "$1" > "$2"', 'sh', im.path, src]))) return ''
    if (im.mediaType === 'image/png') return src
  }
  const out = `${dir}/${key}.png`
  for (const argv of [
    ['sips', '-s', 'format', 'png', '-Z', '480', src, '--out', out],
    ['magick', src, '-thumbnail', '480x480', out],
    ['convert', src, '-thumbnail', '480x480', out],
  ]) {
    if (await ran($, argv)) return out
  }
  return ''
}
