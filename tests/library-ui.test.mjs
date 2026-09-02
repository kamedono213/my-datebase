import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';
import * as model from '../src/model.js';

const htmlPath = new URL('../index.html', import.meta.url);
const appPath = new URL('../src/app.js', import.meta.url);
const initialDataPath = new URL('../src/initial-data.js', import.meta.url);

test('sort selector offers tab order', async () => {
  const html = await readFile(htmlPath, 'utf8');
  assert.match(html, /<option value=["']tag["']>タブ順<\/option>/);
});

test('model exposes a deterministic distinct tab color map', () => {
  assert.equal(typeof model.buildTagColorMap, 'function');
  if (typeof model.buildTagColorMap !== 'function') return;
  const first = model.buildTagColorMap(['生物', '雑学', '医療', '地理']);
  const second = model.buildTagColorMap(['生物', '雑学', '医療', '地理']);
  assert.deepEqual(first, second);
  assert.equal(new Set(Object.values(first)).size, 4);
});

test('tag sort follows supplied tab order and then title', () => {
  const notes = [
    model.createNote({ id: 'a', title: 'Z', tags: ['医療'], updatedAt: 30, createdAt: 30 }),
    model.createNote({ id: 'b', title: 'B', tags: ['生物'], updatedAt: 20, createdAt: 20 }),
    model.createNote({ id: 'c', title: 'A', tags: ['生物'], updatedAt: 10, createdAt: 10 }),
    model.createNote({ id: 'd', title: 'なし', tags: [], updatedAt: 40, createdAt: 40 }),
  ];
  const result = model.filterAndSortNotes(notes, { sort: 'tag', tagOrder: ['生物', '医療'] });
  assert.deepEqual(result.map((note) => note.id), ['c', 'b', 'a', 'd']);
});

test('library list renders only a colored dot and title for each note', async () => {
  const app = await readFile(appPath, 'utf8');
  assert.match(app, /className = 'tab-dot'/);
  assert.doesNotMatch(app, /preview\.className = 'note-preview'/);
  assert.doesNotMatch(app, /meta\.className = 'note-meta'/);
});

test('the Notion export is bundled as initial data and seeded by the app', async () => {
  await assert.doesNotReject(() => access(initialDataPath));
  const app = await readFile(appPath, 'utf8');
  assert.match(app, /INITIAL_NOTES/);
  assert.match(app, /seedInitialDataOnce/);
});
