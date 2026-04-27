import { type MomentRecord, deriveWorldClock } from '@tina/shared';
import { describe, expect, test } from 'vitest';
import {
  OG_HEIGHT,
  OG_WIDTH,
  PixelCanvas,
  composeArcOg,
  composeArcsIndexOg,
  composeCharacterOg,
  composeCharactersIndexOg,
  composeMomentOg,
  composeMomentsIndexOg,
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

describe('composeArcOg', () => {
  test('renders a 1200x630 PNG for a populated pair', () => {
    const png = composeArcOg({
      a: { name: 'Hiro Abe', color: '#aaffff' },
      b: { name: 'Mei Tanaka', color: '#ffaaaa' },
      arcLabel: 'warming',
      affinity: 0.42,
      headline: 'Mei and Hiro caught up at the counter',
    });
    expect(png.subarray(0, 8).equals(PNG_SIGNATURE)).toBe(true);
    expect(png.readUInt32BE(16)).toBe(OG_WIDTH);
    expect(png.readUInt32BE(20)).toBe(OG_HEIGHT);
  });

  test('is deterministic — same input produces the same bytes', () => {
    const input = {
      a: { name: 'Hiro Abe', color: '#aaffff' },
      b: { name: 'Mei Tanaka', color: '#ffaaaa' },
      arcLabel: 'cooling',
      affinity: -0.18,
      headline: 'a tense lull at the cafe',
    };
    const a = composeArcOg(input);
    const b = composeArcOg(input);
    expect(a.equals(b)).toBe(true);
  });

  test('falls back gracefully on an empty headline', () => {
    const png = composeArcOg({
      a: { name: 'Hiro', color: null },
      b: { name: 'Mei', color: null },
      arcLabel: 'new',
      affinity: 0,
      headline: '',
    });
    expect(png.length).toBeGreaterThan(1000);
    // Different from the populated case so OG cache keys behave correctly.
    const populated = composeArcOg({
      a: { name: 'Hiro', color: null },
      b: { name: 'Mei', color: null },
      arcLabel: 'new',
      affinity: 0,
      headline: 'they spoke for the first time',
    });
    expect(png.equals(populated)).toBe(false);
  });

  test('different arc labels produce different bytes', () => {
    const a = composeArcOg({
      a: { name: 'Hiro', color: '#aaffff' },
      b: { name: 'Mei', color: '#ffaaaa' },
      arcLabel: 'warming',
      affinity: 0.4,
      headline: 'shared a meal',
    });
    const b = composeArcOg({
      a: { name: 'Hiro', color: '#aaffff' },
      b: { name: 'Mei', color: '#ffaaaa' },
      arcLabel: 'cooling',
      affinity: 0.4,
      headline: 'shared a meal',
    });
    expect(a.equals(b)).toBe(false);
  });
});

describe('composeCharacterOg', () => {
  const baseInput = {
    name: 'Mei Tanaka',
    color: '#ffaaaa',
    bio: 'a soft-spoken librarian who hand-letters her shelf cards',
    arc: { label: 'warming', otherName: 'Hiro Abe' },
    headline: 'Mei and Hiro caught up at the counter',
  } as const;

  test('renders a 1200x630 PNG for a populated character', () => {
    const png = composeCharacterOg({ ...baseInput, variant: 'conversation' });
    expect(png.subarray(0, 8).equals(PNG_SIGNATURE)).toBe(true);
    expect(png.readUInt32BE(16)).toBe(OG_WIDTH);
    expect(png.readUInt32BE(20)).toBe(OG_HEIGHT);
  });

  test('is deterministic — same input produces the same bytes', () => {
    const input = { ...baseInput, variant: 'conversation' as const };
    const a = composeCharacterOg(input);
    const b = composeCharacterOg(input);
    expect(a.equals(b)).toBe(true);
  });

  test('bio truncation produces a different render than a short bio (single-line clamp)', () => {
    const long = composeCharacterOg({
      ...baseInput,
      bio: 'an extraordinarily long biographical paragraph that absolutely cannot fit on a single OG card line because it just keeps going on and on and on and on',
    });
    const short = composeCharacterOg({ ...baseInput, bio: 'short bio' });
    // Different bytes means truncation actually shaped the layout — guards
    // against a regression where a one-line clamp silently drops to 0 chars.
    expect(long.equals(short)).toBe(false);
    expect(long.length).toBeGreaterThan(1000);
  });

  test('falls back gracefully on an empty headline', () => {
    const empty = composeCharacterOg({ ...baseInput, headline: '' });
    expect(empty.length).toBeGreaterThan(1000);
    const populated = composeCharacterOg({ ...baseInput, headline: 'a busy afternoon' });
    expect(empty.equals(populated)).toBe(false);
  });

  test('group variant renders a different footer chip than conversation', () => {
    const conv = composeCharacterOg({ ...baseInput, variant: 'conversation' });
    const grp = composeCharacterOg({ ...baseInput, variant: 'group', participantCount: 4 });
    expect(conv.equals(grp)).toBe(false);
  });

  test('null arc renders without throwing (no chip)', () => {
    const png = composeCharacterOg({ ...baseInput, arc: null });
    expect(png.length).toBeGreaterThan(1000);
    // Different bytes than the arc-chip case so callers can rely on cache
    // miss semantics across arc state transitions.
    const withArc = composeCharacterOg(baseInput);
    expect(png.equals(withArc)).toBe(false);
  });

  test('handles missing/invalid color and unsupported chars in bio', () => {
    const png = composeCharacterOg({
      name: 'Xss',
      color: 'not-a-color',
      bio: 'emoji ☃ smuggled into bio ✨',
      arc: null,
      headline: 'a quiet morning',
    });
    expect(png.length).toBeGreaterThan(1000);
  });
});

describe('composeMomentsIndexOg', () => {
  const baseInput = {
    participants: [
      { name: 'Mei Tanaka', color: '#ffaaaa' },
      { name: 'Hiro Abe', color: '#aaffff' },
      { name: 'Ava Okafor', color: '#cccccc' },
    ],
    headline: 'Mei and Hiro caught up at the counter',
    simDay: 12,
    momentsCount: 47,
  };

  test('renders a 1200x630 PNG for a populated index', () => {
    const png = composeMomentsIndexOg(baseInput);
    expect(png.subarray(0, 8).equals(PNG_SIGNATURE)).toBe(true);
    expect(png.readUInt32BE(16)).toBe(OG_WIDTH);
    expect(png.readUInt32BE(20)).toBe(OG_HEIGHT);
  });

  test('is deterministic — same input produces the same bytes', () => {
    const a = composeMomentsIndexOg(baseInput);
    const b = composeMomentsIndexOg(baseInput);
    expect(a.equals(b)).toBe(true);
  });

  test('different headlines produce different bytes', () => {
    const a = composeMomentsIndexOg({ ...baseInput, headline: 'first headline' });
    const b = composeMomentsIndexOg({ ...baseInput, headline: 'second totally different one' });
    expect(a.equals(b)).toBe(false);
  });

  test('different sim-day produces different bytes (footer chip)', () => {
    const a = composeMomentsIndexOg({ ...baseInput, simDay: 12 });
    const b = composeMomentsIndexOg({ ...baseInput, simDay: 13 });
    expect(a.equals(b)).toBe(false);
  });

  test('falls back gracefully on an empty index (no participants, no headline)', () => {
    const png = composeMomentsIndexOg({
      participants: [],
      headline: '',
      simDay: 0,
      momentsCount: 0,
    });
    expect(png.length).toBeGreaterThan(1000);
    // Distinct from the populated case so cache-key churn isolates the empty
    // state.
    const populated = composeMomentsIndexOg(baseInput);
    expect(png.equals(populated)).toBe(false);
  });

  test('renders a "+N MORE" pill when totalParticipantCount exceeds 8', () => {
    const eight = Array.from({ length: 8 }, (_, i) => ({
      name: `P${i}`,
      color: '#abcdef',
    }));
    const capped = composeMomentsIndexOg({
      ...baseInput,
      participants: eight,
      totalParticipantCount: 8,
    });
    const overflow = composeMomentsIndexOg({
      ...baseInput,
      participants: eight,
      totalParticipantCount: 12,
    });
    // The overflow pill changes the bytes — proves the layout actually drew it.
    expect(capped.equals(overflow)).toBe(false);
  });
});

describe('composeCharactersIndexOg', () => {
  const baseInput = {
    characters: [
      { name: 'Mei Tanaka', color: '#ffaaaa' },
      { name: 'Hiro Abe', color: '#aaffff' },
      { name: 'Ava Okafor', color: '#cccccc' },
    ],
    headline: 'Mei and Hiro caught up at the counter',
    totalCharacterCount: 3,
  };

  test('renders a 1200x630 PNG for a populated cast', () => {
    const png = composeCharactersIndexOg(baseInput);
    expect(png.subarray(0, 8).equals(PNG_SIGNATURE)).toBe(true);
    expect(png.readUInt32BE(16)).toBe(OG_WIDTH);
    expect(png.readUInt32BE(20)).toBe(OG_HEIGHT);
  });

  test('is deterministic — same input produces the same bytes', () => {
    const a = composeCharactersIndexOg(baseInput);
    const b = composeCharactersIndexOg(baseInput);
    expect(a.equals(b)).toBe(true);
  });

  test('different headlines produce different bytes', () => {
    const a = composeCharactersIndexOg({ ...baseInput, headline: 'first headline' });
    const b = composeCharactersIndexOg({ ...baseInput, headline: 'second totally different one' });
    expect(a.equals(b)).toBe(false);
  });

  test('different cast produces different bytes', () => {
    const a = composeCharactersIndexOg(baseInput);
    const b = composeCharactersIndexOg({
      ...baseInput,
      characters: [
        { name: 'Mei Tanaka', color: '#ffaaaa' },
        { name: 'Hiro Abe', color: '#aaffff' },
      ],
      totalCharacterCount: 2,
    });
    expect(a.equals(b)).toBe(false);
  });

  test('falls back gracefully on an empty cast (no characters)', () => {
    const png = composeCharactersIndexOg({
      characters: [],
      headline: '',
      totalCharacterCount: 0,
    });
    expect(png.length).toBeGreaterThan(1000);
    // Distinct from the populated case so the empty card caches separately.
    const populated = composeCharactersIndexOg(baseInput);
    expect(png.equals(populated)).toBe(false);
  });

  test('renders a "+N MORE" pill when totalCharacterCount exceeds 10', () => {
    const ten = Array.from({ length: 10 }, (_, i) => ({
      name: `Cast${i}`,
      color: '#abcdef',
    }));
    const capped = composeCharactersIndexOg({
      characters: ten,
      headline: 'busy day',
      totalCharacterCount: 10,
    });
    const overflow = composeCharactersIndexOg({
      characters: ten,
      headline: 'busy day',
      totalCharacterCount: 14,
    });
    expect(capped.equals(overflow)).toBe(false);
  });
});

describe('composeArcsIndexOg', () => {
  const baseInput = {
    pairs: [
      {
        aColor: '#ffaaaa',
        bColor: '#aaffff',
        aFirst: 'Mei',
        bFirst: 'Hiro',
        arcLabel: 'warming',
      },
      {
        aColor: '#cccccc',
        bColor: '#aaffff',
        aFirst: 'Ava',
        bFirst: 'Hiro',
        arcLabel: 'cooling',
      },
    ],
    totalPairCount: 2,
    topArcLabel: 'warming',
    freshestHeadline: 'Mei and Hiro caught up at the counter',
  };

  test('renders a 1200x630 PNG for a populated leaderboard', () => {
    const png = composeArcsIndexOg(baseInput);
    expect(png.subarray(0, 8).equals(PNG_SIGNATURE)).toBe(true);
    expect(png.readUInt32BE(16)).toBe(OG_WIDTH);
    expect(png.readUInt32BE(20)).toBe(OG_HEIGHT);
  });

  test('is deterministic — same input produces the same bytes', () => {
    const a = composeArcsIndexOg(baseInput);
    const b = composeArcsIndexOg(baseInput);
    expect(a.equals(b)).toBe(true);
  });

  test('different headlines produce different bytes', () => {
    const a = composeArcsIndexOg({ ...baseInput, freshestHeadline: 'first headline' });
    const b = composeArcsIndexOg({ ...baseInput, freshestHeadline: 'second totally different' });
    expect(a.equals(b)).toBe(false);
  });

  test('different top arc label produces different bytes (header chip)', () => {
    const a = composeArcsIndexOg({ ...baseInput, topArcLabel: 'warming' });
    const b = composeArcsIndexOg({ ...baseInput, topArcLabel: 'cooling' });
    expect(a.equals(b)).toBe(false);
  });

  test('falls back gracefully on an empty leaderboard (no pairs)', () => {
    const png = composeArcsIndexOg({
      pairs: [],
      totalPairCount: 0,
      topArcLabel: null,
      freshestHeadline: '',
    });
    expect(png.length).toBeGreaterThan(1000);
    const populated = composeArcsIndexOg(baseInput);
    expect(png.equals(populated)).toBe(false);
  });

  test('renders a "+N MORE" pill when totalPairCount exceeds 6', () => {
    const six = Array.from({ length: 6 }, (_, i) => ({
      aColor: '#aaaaaa',
      bColor: '#bbbbbb',
      aFirst: `A${i}`,
      bFirst: `B${i}`,
      arcLabel: 'warming',
    }));
    const capped = composeArcsIndexOg({
      pairs: six,
      totalPairCount: 6,
      topArcLabel: 'warming',
      freshestHeadline: 'busy week',
    });
    const overflow = composeArcsIndexOg({
      pairs: six,
      totalPairCount: 9,
      topArcLabel: 'warming',
      freshestHeadline: 'busy week',
    });
    expect(capped.equals(overflow)).toBe(false);
  });
});
