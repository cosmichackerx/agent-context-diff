import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

// GitHub Marketplace rules for action.yml: name, description (max 125 chars),
// and branding with an icon from the Feather set and one of the allowed colors.
const text = readFileSync(new URL('../../action.yml', import.meta.url), 'utf8');

function top(key: string): string | undefined {
  const m = new RegExp(`^${key}:\\s*(.+)$`, 'm').exec(text);
  return m?.[1]?.trim().replace(/^['"]|['"]$/g, '');
}

test('action.yml has Marketplace-ready metadata', () => {
  const name = top('name');
  const description = top('description');
  assert.ok(name && name.length <= 60, 'name present and short');
  assert.ok(description, 'description present');
  assert.ok(description!.length <= 125, `description is ${description!.length} chars, Marketplace allows 125`);
  const icon = /^branding:\s*\n\s+icon:\s*(\S+)/m.exec(text)?.[1];
  const color = /^\s+color:\s*(\S+)/m.exec(text)?.[1];
  assert.ok(icon, 'branding.icon present');
  assert.ok(['white', 'black', 'yellow', 'blue', 'green', 'orange', 'red', 'purple', 'gray-dark'].includes(color ?? ''), `color ${color} is allowed`);
  assert.match(text, /^runs:\s*\n\s+using:\s*['"]?composite/m);
});
