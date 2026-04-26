import { deflateSync } from 'node:zlib';
import type { MomentRecord } from '@tina/shared';

/**
 * Pure-Node OG image renderer for `/moment/:id/og.png` (TINA-616).
 *
 * No headless browser, no native deps — composes a 1200×630 pixel-art card
 * using a hand-encoded 5×7 bitmap font and a tiny PNG encoder. The pixel
 * aesthetic matches the rest of TinyHouse and keeps cold-start cheap.
 *
 * Output is fully deterministic for a given `(MomentRecord, arcLabel?)`
 * input — the same moment id always produces the same PNG bytes, which is
 * what the LRU cache key relies on.
 */

export const OG_WIDTH = 1200;
export const OG_HEIGHT = 630;

/* -------------------------------------------------------------------------- */
/* PNG encoder — RGBA, 8-bit, single IDAT, deflate via Node zlib              */
/* -------------------------------------------------------------------------- */

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

/** Encode an RGBA pixel buffer (width*height*4 bytes) as a PNG. */
export function encodePng(width: number, height: number, rgba: Uint8Array): Buffer {
  if (rgba.length !== width * height * 4) {
    throw new Error(`rgba length ${rgba.length} != ${width * height * 4}`);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.writeUInt8(8, 8); // bit depth
  ihdr.writeUInt8(6, 9); // color type — RGBA
  ihdr.writeUInt8(0, 10); // compression
  ihdr.writeUInt8(0, 11); // filter
  ihdr.writeUInt8(0, 12); // interlace
  const stride = width * 4;
  const filtered = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    filtered[y * (stride + 1)] = 0; // filter byte: None
    filtered.set(rgba.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }
  const idat = deflateSync(filtered);
  return Buffer.concat([
    PNG_SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* -------------------------------------------------------------------------- */
/* 5×7 bitmap font — uppercase + digits + common punctuation                  */
/* -------------------------------------------------------------------------- */

// Each glyph is 7 rows of 5 bits (low 5 bits of each byte). MSB of the 5 is
// the leftmost pixel. Hand-drawn — chunky pixel-art shapes.
const FONT_WIDTH = 5;
const FONT_HEIGHT = 7;

// biome-ignore format: keep the bitmap rows aligned visually.
const FONT: Record<string, number[]> = {
  ' ': [0,0,0,0,0,0,0],
  'A': [0b01110, 0b10001, 0b10001, 0b11111, 0b10001, 0b10001, 0b10001],
  'B': [0b11110, 0b10001, 0b10001, 0b11110, 0b10001, 0b10001, 0b11110],
  'C': [0b01110, 0b10001, 0b10000, 0b10000, 0b10000, 0b10001, 0b01110],
  'D': [0b11110, 0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b11110],
  'E': [0b11111, 0b10000, 0b10000, 0b11110, 0b10000, 0b10000, 0b11111],
  'F': [0b11111, 0b10000, 0b10000, 0b11110, 0b10000, 0b10000, 0b10000],
  'G': [0b01110, 0b10001, 0b10000, 0b10111, 0b10001, 0b10001, 0b01111],
  'H': [0b10001, 0b10001, 0b10001, 0b11111, 0b10001, 0b10001, 0b10001],
  'I': [0b01110, 0b00100, 0b00100, 0b00100, 0b00100, 0b00100, 0b01110],
  'J': [0b00111, 0b00010, 0b00010, 0b00010, 0b00010, 0b10010, 0b01100],
  'K': [0b10001, 0b10010, 0b10100, 0b11000, 0b10100, 0b10010, 0b10001],
  'L': [0b10000, 0b10000, 0b10000, 0b10000, 0b10000, 0b10000, 0b11111],
  'M': [0b10001, 0b11011, 0b10101, 0b10101, 0b10001, 0b10001, 0b10001],
  'N': [0b10001, 0b10001, 0b11001, 0b10101, 0b10011, 0b10001, 0b10001],
  'O': [0b01110, 0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b01110],
  'P': [0b11110, 0b10001, 0b10001, 0b11110, 0b10000, 0b10000, 0b10000],
  'Q': [0b01110, 0b10001, 0b10001, 0b10001, 0b10101, 0b10010, 0b01101],
  'R': [0b11110, 0b10001, 0b10001, 0b11110, 0b10100, 0b10010, 0b10001],
  'S': [0b01111, 0b10000, 0b10000, 0b01110, 0b00001, 0b00001, 0b11110],
  'T': [0b11111, 0b00100, 0b00100, 0b00100, 0b00100, 0b00100, 0b00100],
  'U': [0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b01110],
  'V': [0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b01010, 0b00100],
  'W': [0b10001, 0b10001, 0b10001, 0b10101, 0b10101, 0b10101, 0b01010],
  'X': [0b10001, 0b10001, 0b01010, 0b00100, 0b01010, 0b10001, 0b10001],
  'Y': [0b10001, 0b10001, 0b01010, 0b00100, 0b00100, 0b00100, 0b00100],
  'Z': [0b11111, 0b00001, 0b00010, 0b00100, 0b01000, 0b10000, 0b11111],
  '0': [0b01110, 0b10001, 0b10011, 0b10101, 0b11001, 0b10001, 0b01110],
  '1': [0b00100, 0b01100, 0b00100, 0b00100, 0b00100, 0b00100, 0b01110],
  '2': [0b01110, 0b10001, 0b00001, 0b00010, 0b00100, 0b01000, 0b11111],
  '3': [0b11110, 0b00001, 0b00001, 0b01110, 0b00001, 0b00001, 0b11110],
  '4': [0b00010, 0b00110, 0b01010, 0b10010, 0b11111, 0b00010, 0b00010],
  '5': [0b11111, 0b10000, 0b11110, 0b00001, 0b00001, 0b10001, 0b01110],
  '6': [0b00110, 0b01000, 0b10000, 0b11110, 0b10001, 0b10001, 0b01110],
  '7': [0b11111, 0b00001, 0b00010, 0b00100, 0b01000, 0b01000, 0b01000],
  '8': [0b01110, 0b10001, 0b10001, 0b01110, 0b10001, 0b10001, 0b01110],
  '9': [0b01110, 0b10001, 0b10001, 0b01111, 0b00001, 0b00010, 0b01100],
  '.': [0,0,0,0,0,0,0b00100],
  ',': [0,0,0,0,0,0b00110, 0b00100],
  ':': [0,0,0b00100, 0,0,0b00100, 0],
  '!': [0b00100, 0b00100, 0b00100, 0b00100, 0b00100, 0, 0b00100],
  '?': [0b01110, 0b10001, 0b00010, 0b00100, 0b00100, 0, 0b00100],
  '-': [0,0,0, 0b11111, 0,0,0],
  '_': [0,0,0,0,0,0, 0b11111],
  '/': [0b00001, 0b00010, 0b00010, 0b00100, 0b01000, 0b01000, 0b10000],
  '&': [0b01100, 0b10010, 0b10100, 0b01000, 0b10101, 0b10010, 0b01101],
  "'": [0b00100, 0b00100, 0,0,0,0,0],
  '"': [0b01010, 0b01010, 0,0,0,0,0],
  '(': [0b00010, 0b00100, 0b01000, 0b01000, 0b01000, 0b00100, 0b00010],
  ')': [0b01000, 0b00100, 0b00010, 0b00010, 0b00010, 0b00100, 0b01000],
  // U+00B7 middle dot — treated as a center pixel. Used in clock lines.
  '·': [0,0,0, 0b00100, 0,0,0],
  // U+2014 em-dash — same as hyphen but slightly thicker; rendered as wide bar.
  '—': [0,0,0, 0b11111, 0,0,0],
  // U+2026 ellipsis — three baseline dots.
  '…': [0,0,0,0,0,0, 0b10101],
  '#': [0b01010, 0b01010, 0b11111, 0b01010, 0b11111, 0b01010, 0b01010],
  '+': [0,0, 0b00100, 0b01110, 0b00100, 0,0],
  '*': [0,0b01010, 0b00100, 0b01010, 0,0,0],
};

const UNKNOWN_GLYPH: number[] = [0b11111, 0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b11111];

/** Width in scaled pixels that `text` occupies at `scale` (1 char = 5+1 px). */
export function measureText(text: string, scale: number): number {
  if (text.length === 0) return 0;
  return text.length * (FONT_WIDTH + 1) * scale - scale;
}

/* -------------------------------------------------------------------------- */
/* RGBA pixel canvas + drawing primitives                                     */
/* -------------------------------------------------------------------------- */

export type Rgba = [number, number, number, number];

export function rgba(r: number, g: number, b: number, a = 255): Rgba {
  return [r & 0xff, g & 0xff, b & 0xff, a & 0xff];
}

/** Parse a `#rrggbb` (or `#rgb`) hex color into RGBA. Returns null on miss. */
export function parseHexColor(hex: string | null | undefined, alpha = 255): Rgba | null {
  if (!hex) return null;
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  let body = m[1]!;
  if (body.length === 3)
    body = body
      .split('')
      .map((c) => c + c)
      .join('');
  const r = Number.parseInt(body.slice(0, 2), 16);
  const g = Number.parseInt(body.slice(2, 4), 16);
  const b = Number.parseInt(body.slice(4, 6), 16);
  return [r, g, b, alpha];
}

export class PixelCanvas {
  readonly width: number;
  readonly height: number;
  readonly buf: Uint8Array;

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
    this.buf = new Uint8Array(width * height * 4);
  }

  setPixel(x: number, y: number, color: Rgba): void {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return;
    const i = (y * this.width + x) * 4;
    this.buf[i] = color[0]!;
    this.buf[i + 1] = color[1]!;
    this.buf[i + 2] = color[2]!;
    this.buf[i + 3] = color[3]!;
  }

  fill(color: Rgba): void {
    for (let y = 0; y < this.height; y++) {
      for (let x = 0; x < this.width; x++) this.setPixel(x, y, color);
    }
  }

  /** Solid axis-aligned rectangle. Clipped to canvas. */
  fillRect(x: number, y: number, w: number, h: number, color: Rgba): void {
    const x0 = Math.max(0, Math.floor(x));
    const y0 = Math.max(0, Math.floor(y));
    const x1 = Math.min(this.width, Math.floor(x + w));
    const y1 = Math.min(this.height, Math.floor(y + h));
    for (let yy = y0; yy < y1; yy++) {
      for (let xx = x0; xx < x1; xx++) this.setPixel(xx, yy, color);
    }
  }

  /** Solid filled circle, cx/cy = center. Aliased — keeps the chunky look. */
  fillCircle(cx: number, cy: number, r: number, color: Rgba): void {
    const r2 = r * r;
    const x0 = Math.max(0, Math.floor(cx - r));
    const y0 = Math.max(0, Math.floor(cy - r));
    const x1 = Math.min(this.width, Math.ceil(cx + r));
    const y1 = Math.min(this.height, Math.ceil(cy + r));
    for (let yy = y0; yy < y1; yy++) {
      for (let xx = x0; xx < x1; xx++) {
        const dx = xx - cx;
        const dy = yy - cy;
        if (dx * dx + dy * dy <= r2) this.setPixel(xx, yy, color);
      }
    }
  }

  /** Hollow ring — outline of a circle. Used for halos around named glyphs. */
  strokeCircle(cx: number, cy: number, rOuter: number, rInner: number, color: Rgba): void {
    const ro2 = rOuter * rOuter;
    const ri2 = rInner * rInner;
    const x0 = Math.max(0, Math.floor(cx - rOuter));
    const y0 = Math.max(0, Math.floor(cy - rOuter));
    const x1 = Math.min(this.width, Math.ceil(cx + rOuter));
    const y1 = Math.min(this.height, Math.ceil(cy + rOuter));
    for (let yy = y0; yy < y1; yy++) {
      for (let xx = x0; xx < x1; xx++) {
        const dx = xx - cx;
        const dy = yy - cy;
        const d2 = dx * dx + dy * dy;
        if (d2 <= ro2 && d2 >= ri2) this.setPixel(xx, yy, color);
      }
    }
  }

  /**
   * Draw `text` at integer cell `(x,y)`, scaled by `scale` (1 = 5×7 px).
   * Coordinates are top-left of the first glyph cell. Unknown glyphs render
   * as a filled box so layout never silently shifts on missing chars.
   */
  drawText(x: number, y: number, text: string, color: Rgba, scale: number): void {
    let cursor = x;
    for (const ch of text) {
      const glyph = FONT[ch] ?? FONT[ch.toUpperCase()] ?? UNKNOWN_GLYPH;
      for (let row = 0; row < FONT_HEIGHT; row++) {
        const bits = glyph[row]!;
        for (let col = 0; col < FONT_WIDTH; col++) {
          if ((bits >> (FONT_WIDTH - 1 - col)) & 1) {
            this.fillRect(cursor + col * scale, y + row * scale, scale, scale, color);
          }
        }
      }
      cursor += (FONT_WIDTH + 1) * scale; // 1px gap
    }
  }

  /**
   * Greedy word-wrap. Yields one line at a time, splitting at spaces. If a
   * single word is longer than `maxPx`, it is broken at glyph boundaries —
   * we never overflow the layout. Returns the lines actually used.
   */
  drawTextWrapped(
    x: number,
    y: number,
    maxPx: number,
    text: string,
    color: Rgba,
    scale: number,
    lineHeightPx: number,
    maxLines: number,
  ): number {
    const lines = wrapText(text, maxPx, scale, maxLines);
    for (let i = 0; i < lines.length; i++) {
      this.drawText(x, y + i * lineHeightPx, lines[i]!, color, scale);
    }
    return lines.length;
  }
}

/** Internal: word-wrap honoring `maxLines`. Last line truncated with "…". */
export function wrapText(text: string, maxPx: number, scale: number, maxLines: number): string[] {
  if (maxLines <= 0) return [];
  const words = text.split(/\s+/).filter(Boolean);
  const out: string[] = [];
  let current = '';
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (measureText(candidate, scale) <= maxPx) {
      current = candidate;
      continue;
    }
    if (current) out.push(current);
    if (out.length >= maxLines) break;
    // Word alone too wide? Hard-break it.
    if (measureText(word, scale) > maxPx) {
      let chunk = '';
      for (const ch of word) {
        const next = chunk + ch;
        if (measureText(next, scale) <= maxPx) {
          chunk = next;
        } else {
          if (chunk) out.push(chunk);
          if (out.length >= maxLines) break;
          chunk = ch;
        }
      }
      current = chunk;
    } else {
      current = word;
    }
  }
  if (current && out.length < maxLines) out.push(current);
  if (out.length > maxLines) out.length = maxLines;
  if (out.length === maxLines && wrappedOverflows(words, out, scale, maxPx)) {
    out[out.length - 1] = truncateToFit(out[out.length - 1]!, maxPx, scale);
  }
  return out;
}

function wrappedOverflows(
  words: string[],
  rendered: string[],
  scale: number,
  maxPx: number,
): boolean {
  // True when not every word made it into `rendered`. Used to decide whether
  // the last visible line should end in `…` (the truncate keeps the line
  // within `maxPx` after the ellipsis is appended).
  void scale;
  void maxPx;
  const all = words.join(' ');
  return rendered.join(' ').length < all.length;
}

function truncateToFit(line: string, maxPx: number, scale: number): string {
  const ellipsis = '…';
  let s = `${line}${ellipsis}`;
  while (measureText(s, scale) > maxPx && s.length > 1) {
    // Drop chars from before the ellipsis.
    s = s.slice(0, -2) + ellipsis;
  }
  return s;
}

/* -------------------------------------------------------------------------- */
/* Moment composition                                                          */
/* -------------------------------------------------------------------------- */

/** Map a participant color hex to a soft pixel-art shade. Falls back to lavender. */
function participantColor(hex: string | null): Rgba {
  return parseHexColor(hex, 255) ?? rgba(185, 176, 220);
}

/** Strip non-printable / unsupported chars before drawing. */
function normalizeForFont(s: string): string {
  let out = '';
  for (const ch of s) {
    if (FONT[ch] || FONT[ch.toUpperCase()]) out += ch;
    else if (ch === ' ' || ch === '\t' || ch === '\n') out += ' ';
    // unknown — drop. UNKNOWN_GLYPH would render as a box, distracting.
  }
  return out;
}

function clockLine(rec: MomentRecord): string {
  const c = rec.clock;
  const hh = String(c.hour).padStart(2, '0');
  const mm = String(c.minute).padStart(2, '0');
  const zone = rec.zone ? ` · ${rec.zone}` : '';
  // Drop the phase from the header — it reads as a duplicate of `DAY N` for
  // the `day` phase and isn't load-bearing context for a share card.
  return `DAY ${c.day} · ${hh}:${mm}${zone}`;
}

/** Display name for a participant — truncates to first name in group cards. */
function participantDisplayName(name: string, isGroup: boolean): string {
  if (!isGroup) return name;
  const first = name.split(/\s+/)[0] ?? name;
  return first;
}

function variantBadge(rec: MomentRecord): string {
  if (rec.variant === 'group') return `GROUP · ${rec.participants.length}`;
  return 'CONVERSATION';
}

/** Color palette — synced with the moment HTML page for visual continuity. */
const BG = rgba(15, 13, 21);
const PANEL = rgba(28, 24, 40);
const FG = rgba(231, 229, 238);
const MUTED = rgba(136, 136, 170);
const ACCENT = rgba(185, 176, 220);
const HALO = rgba(245, 201, 122); // soft gold for named-character halos

export interface ComposeMomentOgOptions {
  /** Optional arc label (warming/cooling/etc) to surface as a small chip. */
  arcLabel?: string | null;
  /** Optional arc headline ("Mei & Rin — warming") if both participants named. */
  arcHeadline?: string | null;
}

/**
 * Compose a 1200×630 PNG card for a moment. Deterministic — same record +
 * options produce identical bytes.
 */
export function composeMomentOg(rec: MomentRecord, opts: ComposeMomentOgOptions = {}): Buffer {
  const c = new PixelCanvas(OG_WIDTH, OG_HEIGHT);
  c.fill(BG);

  // Header bar.
  c.fillRect(0, 0, OG_WIDTH, 80, PANEL);
  c.drawText(48, 32, 'TINA · MOMENT', ACCENT, 4);
  const clockText = normalizeForFont(clockLine(rec));
  const clockWidth = measureText(clockText, 3);
  c.drawText(OG_WIDTH - clockWidth - 48, 36, clockText, MUTED, 3);

  // Footer bar.
  c.fillRect(0, OG_HEIGHT - 80, OG_WIDTH, 80, PANEL);

  // Variant badge (bottom-right).
  const badge = variantBadge(rec);
  const badgePx = measureText(badge, 3);
  c.drawText(OG_WIDTH - badgePx - 48, OG_HEIGHT - 50, badge, ACCENT, 3);

  // Arc chip (bottom-left), if present.
  if (opts.arcLabel) {
    const chip = normalizeForFont(opts.arcLabel.toUpperCase());
    c.drawText(48, OG_HEIGHT - 50, chip, HALO, 3);
  }

  // Participant glyphs row, centered horizontally.
  const parts = rec.participants;
  const isGroupLayout = parts.length >= 4;
  const glyphRadius = parts.length <= 3 ? 56 : 40;
  const haloRadius = glyphRadius + 10;
  const glyphSpacing = parts.length <= 3 ? 220 : 180;
  const totalWidth = parts.length * glyphSpacing - (glyphSpacing - 2 * haloRadius);
  const startX = Math.floor((OG_WIDTH - totalWidth) / 2) + haloRadius;
  const glyphCenterY = 220;

  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]!;
    const cx = startX + i * glyphSpacing;
    const color = participantColor(p.color);
    if (p.named) {
      c.strokeCircle(cx, glyphCenterY, haloRadius, glyphRadius + 2, HALO);
    }
    c.fillCircle(cx, glyphCenterY, glyphRadius, color);
    // Initial letter inside the circle, dark text.
    const initial = (p.name[0] ?? '?').toUpperCase();
    const initialScale = 6;
    const initialW = measureText(initial, initialScale);
    const initialH = FONT_HEIGHT * initialScale;
    c.drawText(
      cx - Math.floor(initialW / 2),
      glyphCenterY - Math.floor(initialH / 2),
      initial,
      BG,
      initialScale,
    );
    // Name underneath. Group cards use first-name-only so chunky pixel-art
    // names don't run into each other when there are 4+ participants.
    const display = participantDisplayName(p.name, isGroupLayout);
    const name = normalizeForFont(display.toUpperCase());
    const nameScale = isGroupLayout ? 2 : 3;
    const nameW = measureText(name, nameScale);
    c.drawText(cx - Math.floor(nameW / 2), glyphCenterY + haloRadius + 24, name, FG, nameScale);
  }

  // Headline — center, wraps to up to 2 lines, scale 5 (chunky pixel-art).
  const headline = normalizeForFont(rec.headline.toUpperCase());
  const headlineScale = 5;
  const headlineLineHeight = FONT_HEIGHT * headlineScale + 14;
  const headlineMaxPx = OG_WIDTH - 96; // 48px side margin
  const lines = wrapText(headline, headlineMaxPx, headlineScale, 2);
  const headlineBlockHeight = lines.length * headlineLineHeight - 14;
  const headlineY = 380 + Math.floor((140 - headlineBlockHeight) / 2);
  for (let i = 0; i < lines.length; i++) {
    const lineW = measureText(lines[i]!, headlineScale);
    c.drawText(
      Math.floor((OG_WIDTH - lineW) / 2),
      headlineY + i * headlineLineHeight,
      lines[i]!,
      FG,
      headlineScale,
    );
  }

  // Arc headline (e.g. "MEI & RIN — WARMING") sits between glyph row and headline.
  if (opts.arcHeadline) {
    const ah = normalizeForFont(opts.arcHeadline.toUpperCase());
    const ahScale = 3;
    const ahW = measureText(ah, ahScale);
    c.drawText(Math.floor((OG_WIDTH - ahW) / 2), 350, ah, HALO, ahScale);
  }

  return encodePng(OG_WIDTH, OG_HEIGHT, c.buf);
}

/* -------------------------------------------------------------------------- */
/* Daily digest OG composition (TINA-684)                                      */
/* -------------------------------------------------------------------------- */

export interface DigestOgInput {
  /** 0-indexed sim-day. */
  day: number;
  /** Page headline — e.g. "TINA — Sim-Day 12: Mei and Hiro talked in the cafe at 3:14pm". */
  headline: string;
  /** Distinct participants, ordered. Stacked into 2 rows. */
  participants: Array<{ name: string; named: boolean; color: string | null }>;
  /** How many moments the digest aggregated — surfaced as a small subtitle chip. */
  momentsCount: number;
}

/**
 * Compose a 1200×630 PNG card for a digest. Reuses the moment card chrome
 * (panels + accent palette) but swaps in a `DIGEST · SIM-DAY {N}` header and
 * a 2-row stacked participant glyph block. Deterministic — same input
 * produces identical bytes, which is what the OG cache key relies on.
 */
export function composeDigestOg(input: DigestOgInput): Buffer {
  const c = new PixelCanvas(OG_WIDTH, OG_HEIGHT);
  c.fill(BG);

  // Header bar.
  c.fillRect(0, 0, OG_WIDTH, 80, PANEL);
  c.drawText(48, 32, `DIGEST · SIM-DAY ${input.day}`, ACCENT, 4);
  const subtitle = normalizeForFont(`${input.momentsCount} MOMENTS`);
  const subtitleWidth = measureText(subtitle, 3);
  c.drawText(OG_WIDTH - subtitleWidth - 48, 36, subtitle, MUTED, 3);

  // Footer bar + branding.
  c.fillRect(0, OG_HEIGHT - 80, OG_WIDTH, 80, PANEL);
  c.drawText(48, OG_HEIGHT - 50, 'TINA · TINYHOUSE', ACCENT, 3);
  const dateBadge = normalizeForFont(`SD-${input.day}`);
  const dateBadgeWidth = measureText(dateBadge, 3);
  c.drawText(OG_WIDTH - dateBadgeWidth - 48, OG_HEIGHT - 50, dateBadge, MUTED, 3);

  // 2-row stacked participant glyphs. Cap at 12 (6 per row) to keep the
  // layout legible at 1200×630 — extras roll off the right with a "+N" pill
  // beneath the second row.
  const parts = input.participants.slice(0, 12);
  const overflow = Math.max(0, input.participants.length - parts.length);
  const perRow = Math.ceil(parts.length / 2) || 1;
  const row1 = parts.slice(0, perRow);
  const row2 = parts.slice(perRow);
  const glyphRadius = 36;
  const haloRadius = glyphRadius + 8;
  const glyphSpacing = 150;
  const rowGap = 110;
  const rowYTop = 180;

  drawDigestGlyphRow(c, row1, rowYTop, glyphRadius, haloRadius, glyphSpacing);
  if (row2.length > 0) {
    drawDigestGlyphRow(c, row2, rowYTop + rowGap, glyphRadius, haloRadius, glyphSpacing);
  }

  if (overflow > 0) {
    const pill = normalizeForFont(`+${overflow} MORE`);
    const w = measureText(pill, 3);
    c.drawText(Math.floor((OG_WIDTH - w) / 2), rowYTop + 2 * rowGap + 4, pill, MUTED, 3);
  }

  // Headline — center, wraps to up to 2 lines, scale 4 (one notch smaller
  // than the moment OG so the digest title has room next to two glyph rows).
  const headline = normalizeForFont(input.headline.toUpperCase());
  const headlineScale = 4;
  const headlineLineHeight = FONT_HEIGHT * headlineScale + 12;
  const headlineMaxPx = OG_WIDTH - 96;
  const lines = wrapText(headline, headlineMaxPx, headlineScale, 2);
  const headlineBlockHeight = lines.length * headlineLineHeight - 12;
  const headlineY = OG_HEIGHT - 80 - 40 - headlineBlockHeight;
  for (let i = 0; i < lines.length; i++) {
    const lineW = measureText(lines[i]!, headlineScale);
    c.drawText(
      Math.floor((OG_WIDTH - lineW) / 2),
      headlineY + i * headlineLineHeight,
      lines[i]!,
      FG,
      headlineScale,
    );
  }

  return encodePng(OG_WIDTH, OG_HEIGHT, c.buf);
}

function drawDigestGlyphRow(
  c: PixelCanvas,
  row: Array<{ name: string; named: boolean; color: string | null }>,
  centerY: number,
  glyphRadius: number,
  haloRadius: number,
  glyphSpacing: number,
): void {
  if (row.length === 0) return;
  const totalWidth = row.length * glyphSpacing - (glyphSpacing - 2 * haloRadius);
  const startX = Math.floor((OG_WIDTH - totalWidth) / 2) + haloRadius;
  for (let i = 0; i < row.length; i++) {
    const p = row[i]!;
    const cx = startX + i * glyphSpacing;
    const color = participantColor(p.color);
    if (p.named) {
      c.strokeCircle(cx, centerY, haloRadius, glyphRadius + 2, HALO);
    }
    c.fillCircle(cx, centerY, glyphRadius, color);
    const initial = (p.name[0] ?? '?').toUpperCase();
    const initialScale = 4;
    const initialW = measureText(initial, initialScale);
    const initialH = FONT_HEIGHT * initialScale;
    c.drawText(
      cx - Math.floor(initialW / 2),
      centerY - Math.floor(initialH / 2),
      initial,
      BG,
      initialScale,
    );
  }
}

/* -------------------------------------------------------------------------- */
/* Per-zone OG composition (TINA-744)                                          */
/* -------------------------------------------------------------------------- */

export interface ZoneOgInput {
  /** Display name of the zone — uppercased before rendering. */
  zone: string;
  /**
   * Headline below the title — typically the freshest matching MomentRecord
   * headline. Pass an empty string to fall back to a quiet "no moments yet" line.
   */
  headline: string;
  /** Distinct top characters to surface as a centered glyph row. Capped at 6. */
  participants: Array<{ name: string; named: boolean; color: string | null }>;
  /** How many MomentRecords this zone has logged in the LRU. Surfaced as subtitle chip. */
  momentsCount: number;
}

/**
 * Compose a 1200×630 PNG card for a zone. Reuses the moment/digest chrome
 * (panel bars + accent palette) but swaps in a `TINA · ZONE` header and a
 * single-row participant glyph block. Deterministic — same input produces
 * identical bytes, which is what the OG cache key relies on.
 */
export function composeZoneOg(input: ZoneOgInput): Buffer {
  const c = new PixelCanvas(OG_WIDTH, OG_HEIGHT);
  c.fill(BG);

  // Header bar.
  c.fillRect(0, 0, OG_WIDTH, 80, PANEL);
  c.drawText(48, 32, 'TINA · ZONE', ACCENT, 4);
  const subtitle = normalizeForFont(`${input.momentsCount} MOMENTS`);
  const subtitleWidth = measureText(subtitle, 3);
  c.drawText(OG_WIDTH - subtitleWidth - 48, 36, subtitle, MUTED, 3);

  // Footer bar + branding.
  c.fillRect(0, OG_HEIGHT - 80, OG_WIDTH, 80, PANEL);
  c.drawText(48, OG_HEIGHT - 50, 'TINA · TINYHOUSE', ACCENT, 3);
  const zoneBadge = normalizeForFont(input.zone.toUpperCase());
  const zoneBadgeWidth = measureText(zoneBadge, 3);
  c.drawText(OG_WIDTH - zoneBadgeWidth - 48, OG_HEIGHT - 50, zoneBadge, MUTED, 3);

  // Big zone name centered up top — the visual anchor.
  const titleRaw = normalizeForFont(input.zone.toUpperCase());
  const titleScale = 8;
  const titleW = measureText(titleRaw, titleScale);
  const titleY = 140;
  c.drawText(Math.floor((OG_WIDTH - titleW) / 2), titleY, titleRaw, FG, titleScale);

  // Single-row participant glyphs centered below the title. Cap at 6 — extras
  // get a "+N" pill below so the layout doesn't reflow under busy zones.
  const parts = input.participants.slice(0, 6);
  const overflow = Math.max(0, input.participants.length - parts.length);
  const glyphRadius = 40;
  const haloRadius = glyphRadius + 8;
  const glyphSpacing = 150;
  const glyphCenterY = 320;
  drawDigestGlyphRow(c, parts, glyphCenterY, glyphRadius, haloRadius, glyphSpacing);
  if (overflow > 0) {
    const pill = normalizeForFont(`+${overflow} MORE`);
    const w = measureText(pill, 3);
    c.drawText(Math.floor((OG_WIDTH - w) / 2), glyphCenterY + haloRadius + 24, pill, MUTED, 3);
  }

  // Headline — center, wraps to up to 2 lines, scale 4.
  const headlineSource = input.headline.trim() || `nothing has happened in ${input.zone} yet`;
  const headline = normalizeForFont(headlineSource.toUpperCase());
  const headlineScale = 4;
  const headlineLineHeight = FONT_HEIGHT * headlineScale + 12;
  const headlineMaxPx = OG_WIDTH - 96;
  const lines = wrapText(headline, headlineMaxPx, headlineScale, 2);
  const headlineBlockHeight = lines.length * headlineLineHeight - 12;
  const headlineY = OG_HEIGHT - 80 - 40 - headlineBlockHeight;
  for (let i = 0; i < lines.length; i++) {
    const lineW = measureText(lines[i]!, headlineScale);
    c.drawText(
      Math.floor((OG_WIDTH - lineW) / 2),
      headlineY + i * headlineLineHeight,
      lines[i]!,
      FG,
      headlineScale,
    );
  }

  return encodePng(OG_WIDTH, OG_HEIGHT, c.buf);
}

/* -------------------------------------------------------------------------- */
/* Pair-arc OG composition (TINA-813)                                          */
/* -------------------------------------------------------------------------- */

export interface ArcOgInput {
  /** First named character. Order is canonical (sorted by id ascending). */
  a: { name: string; color: string | null };
  /** Second named character. */
  b: { name: string; color: string | null };
  /** Arc label — `warming` / `cooling` / etc. Uppercased before rendering. */
  arcLabel: string;
  /** Affinity in [-1, +1]. Surfaced in the footer chip. */
  affinity: number;
  /**
   * Freshest moment headline for this pair, optional. Empty string falls back
   * to a quiet "no moments yet" line so social-card crawlers always get
   * something useful.
   */
  headline: string;
}

/**
 * Compose a 1200×630 PNG card for a named×named arc page. Reuses the moment/
 * digest/zone chrome (panel bars + accent palette) but swaps in a `TINA · ARC`
 * header, the arc-label sub-chip, both glyphs centered with halos, and a
 * footer that combines the affinity score with the freshest moment headline.
 * Deterministic — same input produces identical bytes, which is what the OG
 * cache key relies on.
 */
export function composeArcOg(input: ArcOgInput): Buffer {
  const c = new PixelCanvas(OG_WIDTH, OG_HEIGHT);
  c.fill(BG);

  // Header bar.
  c.fillRect(0, 0, OG_WIDTH, 80, PANEL);
  c.drawText(48, 32, 'TINA · ARC', ACCENT, 4);
  const arcChip = normalizeForFont(input.arcLabel.toUpperCase());
  const arcChipWidth = measureText(arcChip, 3);
  c.drawText(OG_WIDTH - arcChipWidth - 48, 36, arcChip, HALO, 3);

  // Footer bar.
  c.fillRect(0, OG_HEIGHT - 80, OG_WIDTH, 80, PANEL);
  c.drawText(48, OG_HEIGHT - 50, 'TINA · TINYHOUSE', ACCENT, 3);
  const affChip = normalizeForFont(formatAffinityForOg(input.affinity));
  const affChipWidth = measureText(affChip, 3);
  c.drawText(OG_WIDTH - affChipWidth - 48, OG_HEIGHT - 50, affChip, MUTED, 3);

  // Two large glyphs centered horizontally with halos. Names underneath.
  const glyphRadius = 64;
  const haloRadius = glyphRadius + 12;
  const glyphSpacing = 320;
  const cy = 230;
  const cxA = Math.floor(OG_WIDTH / 2 - glyphSpacing / 2);
  const cxB = Math.floor(OG_WIDTH / 2 + glyphSpacing / 2);

  drawArcGlyph(c, input.a, cxA, cy, glyphRadius, haloRadius);
  drawArcGlyph(c, input.b, cxB, cy, glyphRadius, haloRadius);

  // Ampersand between the two glyphs — chunky pixel-art "&" at scale 6.
  const amp = '&';
  const ampScale = 6;
  const ampW = measureText(amp, ampScale);
  const ampH = FONT_HEIGHT * ampScale;
  c.drawText(Math.floor(OG_WIDTH / 2 - ampW / 2), cy - Math.floor(ampH / 2), amp, HALO, ampScale);

  // Headline below — fresh moment, wrapped to 2 lines. Falls back to a quiet
  // "no moments yet" line so empty pairs still produce a readable card.
  const headlineSource =
    input.headline.trim() || `${input.a.name} and ${input.b.name} have no moments yet`;
  const headline = normalizeForFont(headlineSource.toUpperCase());
  const headlineScale = 4;
  const headlineLineHeight = FONT_HEIGHT * headlineScale + 12;
  const headlineMaxPx = OG_WIDTH - 96;
  const lines = wrapText(headline, headlineMaxPx, headlineScale, 2);
  const headlineBlockHeight = lines.length * headlineLineHeight - 12;
  const headlineY = OG_HEIGHT - 80 - 40 - headlineBlockHeight;
  for (let i = 0; i < lines.length; i++) {
    const lineW = measureText(lines[i]!, headlineScale);
    c.drawText(
      Math.floor((OG_WIDTH - lineW) / 2),
      headlineY + i * headlineLineHeight,
      lines[i]!,
      FG,
      headlineScale,
    );
  }

  return encodePng(OG_WIDTH, OG_HEIGHT, c.buf);
}

function drawArcGlyph(
  c: PixelCanvas,
  p: { name: string; color: string | null },
  cx: number,
  cy: number,
  glyphRadius: number,
  haloRadius: number,
): void {
  const color = participantColor(p.color);
  // Both sides of an arc are named characters — always draw the gold halo.
  c.strokeCircle(cx, cy, haloRadius, glyphRadius + 2, HALO);
  c.fillCircle(cx, cy, glyphRadius, color);
  const initial = (p.name[0] ?? '?').toUpperCase();
  const initialScale = 7;
  const initialW = measureText(initial, initialScale);
  const initialH = FONT_HEIGHT * initialScale;
  c.drawText(
    cx - Math.floor(initialW / 2),
    cy - Math.floor(initialH / 2),
    initial,
    BG,
    initialScale,
  );
  // Display name underneath (full name; truncated by font normalization).
  const name = normalizeForFont(p.name.toUpperCase());
  const nameScale = 3;
  const nameW = measureText(name, nameScale);
  c.drawText(cx - Math.floor(nameW / 2), cy + haloRadius + 24, name, FG, nameScale);
}

/** Format affinity in [-1, +1] as a chunky chip like `AFFINITY +0.42`. */
function formatAffinityForOg(a: number): string {
  const clamped = Math.max(-1, Math.min(1, a));
  const sign = clamped >= 0 ? '+' : '-';
  const abs = Math.abs(clamped).toFixed(2);
  return `AFFINITY ${sign}${abs}`;
}

/* -------------------------------------------------------------------------- */
/* Per-character OG composition (TINA-882)                                    */
/* -------------------------------------------------------------------------- */

export interface CharacterOgInput {
  /** Display name. Big bitmap text up top. */
  name: string;
  /** Body color hex for the centered glyph. Falls back to lavender. */
  color: string | null;
  /** Bio line — single-line truncated, drawn small under the name. */
  bio: string;
  /**
   * Strongest current arc, or null when none have formed yet. Surfaced as a
   * gold chip with `<arc> WITH <name>` on the right side of the header.
   */
  arc: { label: string; otherName: string } | null;
  /**
   * Freshest moment headline, or empty string for the quiet fallback. Wraps
   * to 2 lines max with ellipsis truncation.
   */
  headline: string;
  /**
   * Variant of the freshest moment, when there is one. `'group'` swaps the
   * footer chip from `CONVERSATION` to `GROUP · N`.
   */
  variant?: 'conversation' | 'group' | null;
  /** Group size for the footer badge when variant is `group`. */
  participantCount?: number;
}

/**
 * Compose a 1200×630 PNG card for a named character. Reuses the moment/zone/
 * arc chrome (panel bars + accent palette) but swaps in a `TINA · CHARACTER`
 * header, the persona name as the visual anchor, a single-line bio, the
 * strongest current arc as a gold chip, and the freshest moment headline as
 * the footer body. Deterministic — same input produces identical bytes,
 * which is what the OG cache key relies on.
 */
export function composeCharacterOg(input: CharacterOgInput): Buffer {
  const c = new PixelCanvas(OG_WIDTH, OG_HEIGHT);
  c.fill(BG);

  // Header bar.
  c.fillRect(0, 0, OG_WIDTH, 80, PANEL);
  c.drawText(48, 32, 'TINA · CHARACTER', ACCENT, 4);
  if (input.arc) {
    const chip = normalizeForFont(`${input.arc.label} WITH ${input.arc.otherName}`.toUpperCase());
    const chipW = measureText(chip, 3);
    c.drawText(OG_WIDTH - chipW - 48, 36, chip, HALO, 3);
  }

  // Footer bar + branding.
  c.fillRect(0, OG_HEIGHT - 80, OG_WIDTH, 80, PANEL);
  c.drawText(48, OG_HEIGHT - 50, 'TINA · TINYHOUSE', ACCENT, 3);
  const footerBadge = footerBadgeFor(input.variant ?? null, input.participantCount ?? 0);
  const badgeW = measureText(footerBadge, 3);
  c.drawText(OG_WIDTH - badgeW - 48, OG_HEIGHT - 50, footerBadge, MUTED, 3);

  // Centered glyph with halo — the character is always "named" on this page.
  const glyphRadius = 70;
  const haloRadius = glyphRadius + 12;
  const glyphCx = Math.floor(OG_WIDTH / 2);
  const glyphCy = 200;
  const glyphColor = participantColor(input.color);
  c.strokeCircle(glyphCx, glyphCy, haloRadius, glyphRadius + 2, HALO);
  c.fillCircle(glyphCx, glyphCy, glyphRadius, glyphColor);
  const initial = (input.name[0] ?? '?').toUpperCase();
  const initialScale = 8;
  const initialW = measureText(initial, initialScale);
  const initialH = FONT_HEIGHT * initialScale;
  c.drawText(
    glyphCx - Math.floor(initialW / 2),
    glyphCy - Math.floor(initialH / 2),
    initial,
    BG,
    initialScale,
  );

  // Big name centered below the glyph. Scales down once if it would clip.
  const nameRaw = normalizeForFont(input.name.toUpperCase());
  const nameMaxPx = OG_WIDTH - 96;
  const nameScale = measureText(nameRaw, 7) <= nameMaxPx ? 7 : 5;
  const nameW = measureText(nameRaw, nameScale);
  const nameY = glyphCy + haloRadius + 28;
  c.drawText(Math.floor((OG_WIDTH - nameW) / 2), nameY, nameRaw, FG, nameScale);

  // Single-line bio under the name — truncated to fit.
  const bioRaw = normalizeForFont(input.bio.toUpperCase());
  if (bioRaw.length > 0) {
    const bioScale = 3;
    const bioMaxPx = OG_WIDTH - 96;
    const bioLines = wrapText(bioRaw, bioMaxPx, bioScale, 1);
    if (bioLines.length > 0) {
      const bioY = nameY + FONT_HEIGHT * nameScale + 24;
      const lineW = measureText(bioLines[0]!, bioScale);
      c.drawText(Math.floor((OG_WIDTH - lineW) / 2), bioY, bioLines[0]!, MUTED, bioScale);
    }
  }

  // Headline above the footer — wraps to 2 lines, scale 4 to match arc/zone.
  const headlineSource = input.headline.trim() || `${input.name} is having a quiet moment`;
  const headline = normalizeForFont(headlineSource.toUpperCase());
  const headlineScale = 4;
  const headlineLineHeight = FONT_HEIGHT * headlineScale + 12;
  const headlineMaxPx = OG_WIDTH - 96;
  const lines = wrapText(headline, headlineMaxPx, headlineScale, 2);
  const headlineBlockHeight = lines.length * headlineLineHeight - 12;
  const headlineY = OG_HEIGHT - 80 - 32 - headlineBlockHeight;
  for (let i = 0; i < lines.length; i++) {
    const lineW = measureText(lines[i]!, headlineScale);
    c.drawText(
      Math.floor((OG_WIDTH - lineW) / 2),
      headlineY + i * headlineLineHeight,
      lines[i]!,
      FG,
      headlineScale,
    );
  }

  return encodePng(OG_WIDTH, OG_HEIGHT, c.buf);
}

function footerBadgeFor(
  variant: 'conversation' | 'group' | null,
  participantCount: number,
): string {
  if (variant === 'group' && participantCount > 0) return `GROUP · ${participantCount}`;
  if (variant === 'conversation') return 'CONVERSATION';
  return 'CHARACTER';
}
