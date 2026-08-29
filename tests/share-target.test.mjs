import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const manifestPath = new URL('../manifest.webmanifest', import.meta.url);

test('manifest registers the app as a GET share target for title, text, and url', async () => {
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  assert.deepEqual(manifest.share_target, {
    action: './?share_target=1',
    method: 'GET',
    params: {
      title: 'title',
      text: 'text',
      url: 'url',
    },
  });
});

test('share helper module exists', async () => {
  const { access } = await import('node:fs/promises');
  const shareModule = new URL('../src/share.js', import.meta.url);
  await assert.doesNotReject(() => access(shareModule));
});

test('share helper exports parseSharePayload', async () => {
  const mod = await import('../src/share.js');
  assert.equal(typeof mod.parseSharePayload, 'function');
});

test('parseSharePayload combines title, text, and url without duplicating the url', async () => {
  const { parseSharePayload } = await import('../src/share.js');
  const params = new URLSearchParams({
    share_target: '1',
    title: '北海道 - Wikipedia',
    text: '北海道についての説明',
    url: 'https://ja.wikipedia.org/wiki/北海道',
  });
  assert.deepEqual(parseSharePayload(params), {
    isShareTarget: true,
    title: '北海道 - Wikipedia',
    content: '北海道についての説明\n\nhttps://ja.wikipedia.org/wiki/北海道',
  });

  const alreadyContainsUrl = new URLSearchParams({
    share_target: '1',
    text: '見て https://example.com/article',
    url: 'https://example.com/article',
  });
  assert.deepEqual(parseSharePayload(alreadyContainsUrl), {
    isShareTarget: true,
    title: '',
    content: '見て https://example.com/article',
  });
});

test('index includes the quick capture bottom sheet controls', async () => {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  for (const id of ['quickCaptureButton', 'quickCaptureDialog', 'quickTitleInput', 'quickTagsInput', 'quickContentInput', 'quickSaveButton', 'quickEditButton']) {
    assert.match(html, new RegExp(`id=["']${id}["']`));
  }
});

test('app integrates share payload handling and quick capture saving', async () => {
  const app = await readFile(new URL('../src/app.js', import.meta.url), 'utf8');
  assert.match(app, /parseSharePayload/);
  assert.match(app, /openQuickCapture/);
  assert.match(app, /saveQuickCapture/);
  assert.match(app, /history\.replaceState/);
});

test('service worker caches the share helper module', async () => {
  const sw = await readFile(new URL('../sw.js', import.meta.url), 'utf8');
  assert.match(sw, /\.\/src\/share\.js/);
});
