import { type MomentRecord, deriveWorldClock } from '@tina/shared';
import { describe, expect, test } from 'vitest';
import {
  OG_HEIGHT,
  OG_WIDTH,
  PixelCanvas,
  composeMomentOg,
  composeZoneOg,
  encodePng,
  measureText,
  parseHexColor,
  rgba,
  wrapText,
} from './og-image.js';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function mkConversationMoment(overrides: Partial<MomentRecord> = {}): MomentRecord {
  const simTime = 14 * 3600 + 30 * 60;
  const base: MomentRecord = {
    version: 1,
    id: 'abc12345',
    sessionId: 's1',
    variant: 'conversation',
    headline: 'Mei and Rin had a long meandering chat in the garden',
    simTime,
    clock: deriveWorldClock(simTime, 30),
    capturedAt: '2026-04-25T12:00:00.000Z',
    zone: 'garden',
    participants: [
      { id: 'mei', name: 'Mei', named: true, color: '#ffaaaa' },
      { id: 'rin', name: 'Rin', named: true, color: '#aaffff' },
    ],
    transcript: [{ speakerId: 'mei', text: 'hi', at: simTime }],
    openedAt: simTime - 60,
    closedAt: simTime,
    closeReason: 'idle',
    reflection: null,
  };
  return { ...base, ...overrides };
}

describe('encodePng', () => {
  test('returns a valid PNG with signature + IHDR + IDAT + IEND', () => {
    const c = new PixelCanvas(4, 4);
    c.fill(rgba(255, 0, 0));
    const png = encodePng(4, 4, c.buf);
    expect(png.subarray(0, 8).equals(PNG_SIGNATURE)).toBe(true);
    expect(png.includes(Buffer.from('IHDR'))).toBe(true);
    expect(png.includes(Buffer.from('IDAT'))).toBe(true);
    expect(png.includes(Buffer.from('IEND'))).toBe(true);
  });

  test('throws on size mismatch', () => {
    expect(() => encodePng(4, 4, new Uint8Array(10))).toThrow();
  });
});

describe('PixelCanvas drawing', () => {
  test('fillRect sets the right pixels', () => {
    const c = new PixelCanvas(8, 8);
    c.fillRect(2, 3, 3, 2, rgba(10, 20, 30));
    // Sample one in-rect pixel.
    const idx = (3 * 8 + 2) * 4;
    expect(c.buf[idx]).toBe(10);
    expect(c.buf[idx + 1]).toBe(20);
    expect(c.buf[idx + 2]).toBe(30);
    expect(c.buf[idx + 3]).toBe(255);
    // And one outside.
    const outside = (0 * 8 + 0) * 4;
    expect(c.buf[outside]).toBe(0);
  });

  test('fillRect clips to canvas without throwing', () => {
    const c = new PixelCanvas(4, 4);
    c.fillRect(-2, -2, 100, 100, rgba(255, 255, 255));
    expect(c.buf[(0 * 4 + 0) * 4]).toBe(255);
    expect(c.buf[(3 * 4 + 3) * 4]).toBe(255);
  });

  test('drawText paints non-zero pixels for a known glyph', () => {
    const c = new PixelCanvas(40, 16);
    c.drawText(0, 0, 'A', rgba(255, 255, 255), 1);
    // 'A' has its top middle pixel set: row 0, col 1..3 all set; col 0 zero.
    const at = (x: number, y: number) => c.buf[(y * 40 + x) * 4];
    expect(at(1, 0)).toBe(255);
    expect(at(2, 0)).toBe(255);
    expect(at(3, 0)).toBe(255);
    expect(at(0, 0)).toBe(0);
  });

  test('drawText falls back to UNKNOWN_GLYPH for missing chars', () => {
    const c = new PixelCanvas(20, 10);
    c.drawText(0, 0, '☃', rgba(255, 0, 0), 1); // snowman — not in font
    // UNKNOWN_GLYPH is a filled box — top-left pixel set.
    const at = (x: number, y: number) => c.buf[(y * 20 + x) * 4];
    expect(at(0, 0)).toBe(255);
  });
});

describe('parseHexColor', () => {
  test('accepts #rrggbb', () => {
    expect(parseHexColor('#ff8800')).toEqual([255, 136, 0, 255]);
  });
  test('accepts #rgb', () => {
    expect(parseHexColor('#f80')).toEqual([255, 136, 0, 255]);
  });
  test('rejects garbage', () => {
    expect(parseHexColor('not-a-color')).toBeNull();
    expect(parseHexColor(null)).toBeNull();
  });
});

describe('measureText / wrapText', () => {
  test('measureText scales with font width + 1px gap', () => {
    expect(measureText('AB', 1)).toBe(11); // 5+1+5
    expect(measureText('AB', 3)).toBe(33);
  });

  test('wrapText respects pixel width and max lines', () => {
    const lines = wrapText('one two three four five six seven', 60, 2, 2);
    expect(lines.length).toBeLessThanOrEqual(2);
    expect(lines[lines.length - 1]).toMatch(/…$/);
  });

  test('wrapText breaks long single words at glyph boundaries', () => {
    const lines = wrapText('supercalifragilistic', 30, 2, 3);
    expect(lines.every((l) => l.length > 0)).toBe(true);
    expect(lines.length).toBeGreaterThan(1);
  });

  test('wrapText produces at most maxLines', () => {
    const lines = wrapText('a a a a a a a a a a a a a a a a', 20, 2, 2);
    expect(lines.length).toBe(2);
  });
});

describe('composeMomentOg', () => {
  test('renders a 1200x630 PNG for a basic conversation moment', () => {
    const rec = mkConversationMoment();
    const png = composeMomentOg(rec);
    expect(png.subarray(0, 8).equals(PNG_SIGNATURE)).toBe(true);
    // Decode IHDR width/height.
    expect(png.readUInt32BE(16)).toBe(OG_WIDTH);
    expect(png.readUInt32BE(20)).toBe(OG_HEIGHT);
  });

  test('is deterministic — same input produces same bytes', () => {
    const rec = mkConversationMoment();
    const a = composeMomentOg(rec);
    const b = composeMomentOg(rec);
    expect(a.equals(b)).toBe(true);
  });

  test('different headlines produce different PNGs', () => {
    const a = composeMomentOg(mkConversationMoment({ headline: 'first headline' }));
    const b = composeMomentOg(mkConversationMoment({ headline: 'totally different headline' }));
    expect(a.equals(b)).toBe(false);
  });

  test('arcLabel + arcHeadline change output bytes', () => {
    const rec = mkConversationMoment();
    const plain = composeMomentOg(rec);
    const withArc = composeMomentOg(rec, {
      arcLabel: 'warming',
      arcHeadline: 'Mei & Rin — warming',
    });
    expect(plain.equals(withArc)).toBe(false);
  });

  test('group variant renders without throwing for 4 participants', () => {
    const rec = mkConversationMoment({
      variant: 'group',
      closeReason: 'group',
      headline: 'Mei, Rin, Kai and Hiro shared the kitchen',
      participants: [
        { id: 'mei', name: 'Mei', named: true, color: '#ffaaaa' },
        { id: 'rin', name: 'Rin', named: true, color: '#aaffff' },
        { id: 'kai', name: 'Kai', named: true, color: '#ffffaa' },
        { id: 'hiro', name: 'Hiro', named: true, color: '#aaffaa' },
      ],
      transcript: [],
    });
    const png = composeMomentOg(rec);
    expect(png.length).toBeGreaterThan(1000);
  });

  test('handles missing/invalid participant colors', () => {
    const rec = mkConversationMoment({
      participants: [
        { id: 'mei', name: 'Mei', named: true, color: null },
        { id: 'p2', name: 'P2', named: false, color: 'not-a-color' },
      ],
    });
    expect(() => composeMomentOg(rec)).not.toThrow();
  });

  test('strips emoji and unsupported chars from headline without breaking layout', () => {
    const rec = mkConversationMoment({
      headline: 'Mei ☃ met ✨ Rin in the \u{1f33f} garden',
    });
    const png = composeMomentOg(rec);
    expect(png.length).toBeGreaterThan(1000);
  });
});

describe('composeZoneOg', () => {
  test('renders a 1200x630 PNG for a populated zone', () => {
    const png = composeZoneOg({
      zone: 'cafe',
      headline: 'Mei and Hiro caught up at the counter',
      momentsCount: 12,
      participants: [
        { name: 'Mei', named: true, color: '#ffaaaa' },
        { name: 'Hiro', named: true, color: '#aaffff' },
      ],
    });
    expect(png.subarray(0, 8).equals(PNG_SIGNATURE)).toBe(true);
    expect(png.readUInt32BE(16)).toBe(OG_WIDTH);
    expect(png.readUInt32BE(20)).toBe(OG_HEIGHT);
  });

  test('is deterministic — same input produces the same bytes', () => {
    const input = {
      zone: 'park',
      headline: 'a quiet hour by the pond',
      momentsCount: 4,
      participants: [{ name: 'Rin', named: true, color: '#aaccff' }],
    };
    const a = composeZoneOg(input);
    const b = composeZoneOg(input);
    expect(a.equals(b)).toBe(true);
  });

  test('falls back gracefully on an empty zone (TINA-744 verification)', () => {
    const png = composeZoneOg({
      zone: 'park',
      headline: '',
      momentsCount: 0,
      participants: [],
    });
    expect(png.length).toBeGreaterThan(1000);
    // Different from the populated case: bytes must reflect the empty fallback.
    const populated = composeZoneOg({
      zone: 'park',
      headline: 'someone showed up',
      momentsCount: 1,
      participants: [{ name: 'A', named: false, color: null }],
    });
    expect(png.equals(populated)).toBe(false);
  });

  test('different zone names produce different bytes', () => {
    const a = composeZoneOg({ zone: 'cafe', headline: '', momentsCount: 0, participants: [] });
    const b = composeZoneOg({ zone: 'park', headline: '', momentsCount: 0, participants: [] });
    expect(a.equals(b)).toBe(false);
  });
});
