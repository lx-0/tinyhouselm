import { describe, expect, it } from 'vitest';
import { parseSkillSource } from './skills.js';

describe('parseSkillSource', () => {
  it('parses frontmatter, body, and heading into a SkillDocument', () => {
    const source = `---
name: ava-okafor
description: 27yo barista, introvert
metadata:
  age: "27"
  occupation: "barista"
---

# Ava Okafor

## Voice
short sentences.
`;
    const doc = parseSkillSource(source, '/tmp/ava/SKILL.md');
    expect(doc.id).toBe('ava-okafor');
    expect(doc.displayName).toBe('Ava Okafor');
    expect(doc.description).toContain('introvert');
    expect(doc.metadata.age).toBe('27');
    expect(doc.metadata.occupation).toBe('barista');
    expect(doc.body).toContain('## Voice');
  });

  it('falls back to titlecased id when body has no H1', () => {
    const source = `---
name: marcus-li
description: bike messenger
---

no heading here
`;
    const doc = parseSkillSource(source, '/tmp/m/SKILL.md');
    expect(doc.displayName).toBe('Marcus Li');
  });

  it('throws when frontmatter is missing', () => {
    expect(() => parseSkillSource('just a markdown file', '/tmp/bad.md')).toThrow(/frontmatter/);
  });

  it('throws when name is missing', () => {
    const source = `---
description: nameless
---

# Body
`;
    expect(() => parseSkillSource(source, '/tmp/bad.md')).toThrow(/name/);
  });
});
