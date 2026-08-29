import { createNote, filterAndSortNotes, normalizeTags } from './model.js';
import { parseSharePayload } from './share.js';
import {
  listNotes,
  putNote,
  deleteNotePermanently,
  getSetting,
  setSetting,
  exportData,
  importData,
} from './db.js';

const $ = (id) => document.getElementById(id);
const DEFAULT_APP_TITLE = '知識データベース';

const els = {
  libraryView: $('libraryView'),
  editorView: $('editorView'),
  trashView: $('trashView'),
  searchInput: $('searchInput'),
  sortSelect: $('sortSelect'),
  tagFilters: $('tagFilters'),
  noteList: $('noteList'),
  emptyState: $('emptyState'),
  resultCount: $('resultCount'),
  addButton: $('addButton'),
  clipboardButton: $('clipboardButton'),
  quickCaptureButton: $('quickCaptureButton'),
  quickCaptureDialog: $('quickCaptureDialog'),
  quickCancelButton: $('quickCancelButton'),
  quickTitleInput: $('quickTitleInput'),
  quickTagsInput: $('quickTagsInput'),
  quickContentInput: $('quickContentInput'),
  quickSaveButton: $('quickSaveButton'),
  quickEditButton: $('quickEditButton'),
  randomButton: $('randomButton'),
  trashButton: $('trashButton'),
  settingsButton: $('settingsButton'),
  homeButton: $('homeButton'),
  appTitleInput: $('appTitleInput'),
  backButton: $('backButton'),
  saveState: $('saveState'),
  pinButton: $('pinButton'),
  favoriteButton: $('favoriteButton'),
  titleInput: $('titleInput'),
  tagsInput: $('tagsInput'),
  contentInput: $('contentInput'),
  copyTitleButton: $('copyTitleButton'),
  copyBodyButton: $('copyBodyButton'),
  copyAllButton: $('copyAllButton'),
  duplicateButton: $('duplicateButton'),
  deleteButton: $('deleteButton'),
  attachmentInput: $('attachmentInput'),
  attachmentList: $('attachmentList'),
  relatedSelect: $('relatedSelect'),
  relatedList: $('relatedList'),
  trashBackButton: $('trashBackButton'),
  trashList: $('trashList'),
  settingsDialog: $('settingsDialog'),
  themeSelect: $('themeSelect'),
  exportButton: $('exportButton'),
  importInput: $('importInput'),
  toast: $('toast'),
};

const state = {
  notes: [],
  activeNoteId: null,
  selectedTags: new Set(),
  query: '',
  sort: 'updated',
  autosaveTimer: null,
  toastTimer: null,
  appTitleTimer: null,
};

function currentNote() {
  return state.notes.find((note) => note.id === state.activeNoteId) || null;
}

function formatDate(timestamp) {
  if (!timestamp) return '';
  return new Intl.DateTimeFormat('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(timestamp);
}

function showToast(message) {
  clearTimeout(state.toastTimer);
  els.toast.textContent = message;
  els.toast.hidden = false;
  state.toastTimer = setTimeout(() => { els.toast.hidden = true; }, 1800);
}

function showView(view) {
  els.libraryView.hidden = view !== 'library';
  els.editorView.hidden = view !== 'editor';
  els.trashView.hidden = view !== 'trash';
  window.scrollTo({ top: 0, behavior: 'instant' });
}

function textWithLinks(container, text) {
  container.replaceChildren();
  const value = String(text || '');
  const regex = /(https?:\/\/[^\s]+)/gi;
  let last = 0;
  for (const match of value.matchAll(regex)) {
    const index = match.index ?? 0;
    container.append(document.createTextNode(value.slice(last, index)));
    const link = document.createElement('a');
    link.href = match[0];
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = match[0];
    link.addEventListener('click', (event) => event.stopPropagation());
    container.append(link);
    last = index + match[0].length;
  }
  container.append(document.createTextNode(value.slice(last)));
}

function collectAllTags() {
  const counts = new Map();
  for (const note of state.notes) {
    if (note.deletedAt != null) continue;
    for (const tag of note.tags || []) counts.set(tag, (counts.get(tag) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'ja'));
}

function renderTagFilters() {
  els.tagFilters.replaceChildren();
  for (const [tag, count] of collectAllTags()) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `tag-chip${state.selectedTags.has(tag) ? ' active' : ''}`;
    button.textContent = `${tag} ${count}`;
    button.addEventListener('click', () => {
      if (state.selectedTags.has(tag)) state.selectedTags.delete(tag);
      else state.selectedTags.add(tag);
      renderLibrary();
    });
    els.tagFilters.append(button);
  }
}

function renderLibrary() {
  renderTagFilters();
  const notes = filterAndSortNotes(state.notes, {
    query: state.query,
    tags: [...state.selectedTags],
    sort: state.sort,
  });

  els.noteList.replaceChildren();
  els.resultCount.textContent = `${notes.length}件`;
  els.emptyState.hidden = notes.length !== 0 || Boolean(state.query) || state.selectedTags.size > 0;

  if (notes.length === 0 && (state.query || state.selectedTags.size)) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.innerHTML = '<strong>該当する知識がありません</strong><span>検索語やタグを変えてみてください。</span>';
    els.noteList.append(empty);
    return;
  }

  for (const note of notes) {
    const card = document.createElement('article');
    card.className = 'note-card';
    card.tabIndex = 0;
    card.addEventListener('click', () => openEditor(note.id));
    card.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') openEditor(note.id);
    });

    const head = document.createElement('div');
    head.className = 'note-card-head';
    const title = document.createElement('div');
    title.className = 'note-title';
    title.textContent = note.title.trim() || '無題';
    const marks = document.createElement('div');
    marks.className = 'card-marks';
    marks.textContent = `${note.pinned ? '📌' : ''}${note.favorite ? '★' : ''}`;
    head.append(title, marks);

    const preview = document.createElement('div');
    preview.className = 'note-preview';
    const excerpt = note.content.trim().slice(0, 180) || '本文なし';
    textWithLinks(preview, excerpt);

    const meta = document.createElement('div');
    meta.className = 'note-meta';
    const tags = document.createElement('div');
    tags.className = 'card-tags';
    for (const tag of note.tags.slice(0, 4)) {
      const chip = document.createElement('span');
      chip.className = 'card-tag';
      chip.textContent = tag;
      tags.append(chip);
    }
    const date = document.createElement('span');
    date.className = 'note-date';
    date.textContent = formatDate(note.updatedAt);
    meta.append(tags, date);

    card.append(head, preview, meta);
    els.noteList.append(card);
  }
}

function updateEditorButtons(note) {
  els.pinButton.classList.toggle('active', note.pinned);
  els.favoriteButton.classList.toggle('active', note.favorite);
  els.favoriteButton.textContent = note.favorite ? '★' : '☆';
}

function renderAttachments(note) {
  els.attachmentList.replaceChildren();
  for (const attachment of note.attachments || []) {
    const card = document.createElement('div');
    card.className = 'attachment-card';
    const img = document.createElement('img');
    img.src = attachment.dataUrl;
    img.alt = attachment.name || '添付画像';
    img.loading = 'lazy';
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'attachment-remove';
    remove.textContent = '×';
    remove.setAttribute('aria-label', '画像を削除');
    remove.addEventListener('click', () => {
      note.attachments = note.attachments.filter((item) => item.id !== attachment.id);
      scheduleAutosave();
      renderAttachments(note);
    });
    card.append(img, remove);
    els.attachmentList.append(card);
  }
}

function renderRelated(note) {
  els.relatedSelect.replaceChildren();
  const base = document.createElement('option');
  base.value = '';
  base.textContent = '関連メモを追加…';
  els.relatedSelect.append(base);

  const candidates = state.notes
    .filter((item) => item.deletedAt == null && item.id !== note.id && !note.relatedIds.includes(item.id))
    .sort((a, b) => a.title.localeCompare(b.title, 'ja'));
  for (const item of candidates) {
    const option = document.createElement('option');
    option.value = item.id;
    option.textContent = item.title || '無題';
    els.relatedSelect.append(option);
  }

  els.relatedList.replaceChildren();
  for (const id of note.relatedIds) {
    const related = state.notes.find((item) => item.id === id && item.deletedAt == null);
    if (!related) continue;
    const pill = document.createElement('span');
    pill.className = 'related-pill';
    const open = document.createElement('button');
    open.type = 'button';
    open.textContent = related.title || '無題';
    open.addEventListener('click', async () => {
      await flushAutosave();
      openEditor(related.id);
    });
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.textContent = '×';
    remove.setAttribute('aria-label', '関連を解除');
    remove.addEventListener('click', () => {
      note.relatedIds = note.relatedIds.filter((relatedId) => relatedId !== id);
      scheduleAutosave();
      renderRelated(note);
    });
    pill.append(open, remove);
    els.relatedList.append(pill);
  }
}

async function openEditor(noteId = null, seed = null) {
  let note = noteId ? state.notes.find((item) => item.id === noteId) : null;
  if (!note) {
    note = createNote(seed || {});
    state.notes.push(note);
    await putNote(note);
  }
  state.activeNoteId = note.id;
  els.titleInput.value = note.title;
  els.tagsInput.value = note.tags.join(', ');
  els.contentInput.value = note.content;
  els.saveState.textContent = '保存済み';
  updateEditorButtons(note);
  renderAttachments(note);
  renderRelated(note);
  showView('editor');
  requestAnimationFrame(() => (note.title ? els.contentInput : els.titleInput).focus());
}

function syncInputsToNote() {
  const note = currentNote();
  if (!note) return null;
  note.title = els.titleInput.value;
  note.content = els.contentInput.value;
  note.tags = normalizeTags(els.tagsInput.value.split(/[,、]/));
  note.updatedAt = Date.now();
  return note;
}

async function saveActiveNote() {
  const note = syncInputsToNote();
  if (!note) return;
  els.saveState.textContent = '保存中…';
  await putNote(note);
  els.saveState.textContent = '保存済み';
  renderLibrary();
}

function scheduleAutosave() {
  clearTimeout(state.autosaveTimer);
  els.saveState.textContent = '未保存';
  state.autosaveTimer = setTimeout(saveActiveNote, 500);
}

async function flushAutosave() {
  if (!state.activeNoteId) return;
  if (state.autosaveTimer) {
    clearTimeout(state.autosaveTimer);
    state.autosaveTimer = null;
  }
  await saveActiveNote();
}

async function closeEditor() {
  await flushAutosave();
  state.activeNoteId = null;
  showView('library');
  renderLibrary();
}

async function writeClipboard(text) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
    } else {
      const area = document.createElement('textarea');
      area.value = text;
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.append(area);
      area.select();
      document.execCommand('copy');
      area.remove();
    }
    showToast('コピーしました');
  } catch {
    showToast('コピーできませんでした');
  }
}

async function createFromClipboard() {
  try {
    if (!navigator.clipboard?.readText) throw new Error('Clipboard unavailable');
    const content = await navigator.clipboard.readText();
    await openEditor(null, { content });
    if (content) showToast('本文に貼り付けました');
  } catch {
    await openEditor();
    showToast('クリップボードを読めないため空欄で作成しました');
  }
}

function quickCaptureSeed() {
  return {
    title: els.quickTitleInput.value,
    content: els.quickContentInput.value,
    tags: normalizeTags(els.quickTagsInput.value.split(/[,、]/)),
  };
}

function closeQuickCapture() {
  if (els.quickCaptureDialog.open && typeof els.quickCaptureDialog.close === 'function') {
    els.quickCaptureDialog.close();
  } else {
    els.quickCaptureDialog.removeAttribute('open');
  }
}

function openQuickCapture(seed = {}) {
  els.quickTitleInput.value = String(seed.title ?? '');
  els.quickTagsInput.value = normalizeTags(seed.tags ?? []).join(', ');
  els.quickContentInput.value = String(seed.content ?? '');

  if (typeof els.quickCaptureDialog.showModal === 'function') els.quickCaptureDialog.showModal();
  else els.quickCaptureDialog.setAttribute('open', '');

  requestAnimationFrame(() => {
    const target = els.quickTitleInput.value ? els.quickContentInput : els.quickTitleInput;
    target.focus();
    if (target === els.quickContentInput) target.setSelectionRange(target.value.length, target.value.length);
  });
}

async function saveQuickCapture() {
  const seed = quickCaptureSeed();
  if (!seed.title.trim() && !seed.content.trim()) {
    showToast('タイトルか内容を入力してください');
    return;
  }
  const note = createNote(seed);
  state.notes.push(note);
  await putNote(note);
  renderLibrary();
  closeQuickCapture();
  showToast('保存しました');
}

async function editQuickCapture() {
  const seed = quickCaptureSeed();
  closeQuickCapture();
  await openEditor(null, seed);
}

function handleInitialShareTarget() {
  const payload = parseSharePayload(new URLSearchParams(location.search));
  if (!payload.isShareTarget) return;

  const cleanUrl = `${location.pathname}${location.hash}`;
  history.replaceState(null, '', cleanUrl);
  openQuickCapture({ title: payload.title, content: payload.content });
}

function insertFormatting(kind) {
  const textarea = els.contentInput;
  const start = textarea.selectionStart;
  const end = textarea.selectionEnd;
  const selected = textarea.value.slice(start, end);
  let before = '';
  let after = '';
  if (kind === 'heading') before = '# ';
  if (kind === 'bold') { before = '**'; after = '**'; }
  if (kind === 'bullet') before = '- ';
  if (kind === 'check') before = '- [ ] ';
  textarea.setRangeText(`${before}${selected}${after}`, start, end, 'end');
  textarea.focus();
  scheduleAutosave();
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

async function addAttachments(files) {
  const note = currentNote();
  if (!note) return;
  for (const file of files) {
    if (!file.type.startsWith('image/')) continue;
    if (file.size > 10 * 1024 * 1024) {
      showToast(`${file.name} は10MBを超えるため追加できません`);
      continue;
    }
    const dataUrl = await fileToDataUrl(file);
    note.attachments.push({
      id: `img-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      name: file.name,
      type: file.type,
      dataUrl,
    });
  }
  renderAttachments(note);
  scheduleAutosave();
}

async function toggleFlag(key) {
  const note = currentNote();
  if (!note) return;
  note[key] = !note[key];
  note.updatedAt = Date.now();
  await putNote(note);
  updateEditorButtons(note);
  renderLibrary();
}

async function duplicateActive() {
  await flushAutosave();
  const note = currentNote();
  if (!note) return;
  const clone = createNote({
    title: `${note.title || '無題'}（コピー）`,
    content: note.content,
    tags: note.tags,
    attachments: note.attachments,
    relatedIds: note.relatedIds,
  });
  state.notes.push(clone);
  await putNote(clone);
  showToast('複製しました');
  await openEditor(clone.id);
}

async function moveActiveToTrash() {
  await flushAutosave();
  const note = currentNote();
  if (!note) return;
  note.deletedAt = Date.now();
  note.updatedAt = Date.now();
  await putNote(note);
  state.activeNoteId = null;
  showView('library');
  renderLibrary();
  showToast('ゴミ箱へ移動しました');
}

function renderTrash() {
  const notes = filterAndSortNotes(state.notes, { onlyDeleted: true, sort: 'updated' });
  els.trashList.replaceChildren();
  if (!notes.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.innerHTML = '<strong>ゴミ箱は空です</strong><span>削除した知識はここから復元できます。</span>';
    els.trashList.append(empty);
    return;
  }

  for (const note of notes) {
    const card = document.createElement('div');
    card.className = 'trash-card';
    const title = document.createElement('strong');
    title.textContent = note.title || '無題';
    const meta = document.createElement('div');
    meta.className = 'muted';
    meta.textContent = `削除: ${formatDate(note.deletedAt)}`;
    const actions = document.createElement('div');
    actions.className = 'trash-card-actions';
    const restore = document.createElement('button');
    restore.type = 'button';
    restore.className = 'secondary-btn';
    restore.textContent = '復元';
    restore.addEventListener('click', async () => {
      note.deletedAt = null;
      note.updatedAt = Date.now();
      await putNote(note);
      renderTrash();
      renderLibrary();
      showToast('復元しました');
    });
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'danger-btn';
    remove.style.gridColumn = 'auto';
    remove.textContent = '完全削除';
    remove.addEventListener('click', async () => {
      if (!confirm(`「${note.title || '無題'}」を完全に削除しますか？`)) return;
      await deleteNotePermanently(note.id);
      state.notes = state.notes.filter((item) => item.id !== note.id);
      renderTrash();
      renderLibrary();
      showToast('完全に削除しました');
    });
    actions.append(restore, remove);
    card.append(title, meta, actions);
    els.trashList.append(card);
  }
}

async function openRandomNote() {
  const candidates = state.notes.filter((note) => note.deletedAt == null);
  if (!candidates.length) return showToast('知識がまだありません');
  const note = candidates[Math.floor(Math.random() * candidates.length)];
  await openEditor(note.id);
}

function downloadJson(data) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const date = new Date().toISOString().slice(0, 10);
  a.href = url;
  a.download = `knowledge-backup-${date}.json`;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  els.themeSelect.value = theme;
}

function applyAppTitle(value) {
  const title = String(value || '').trim() || DEFAULT_APP_TITLE;
  els.appTitleInput.value = title;
  document.title = title;
  return title;
}

async function saveAppTitle() {
  clearTimeout(state.appTitleTimer);
  state.appTitleTimer = null;
  const title = applyAppTitle(els.appTitleInput.value);
  await setSetting('appTitle', title);
}

function scheduleAppTitleSave() {
  clearTimeout(state.appTitleTimer);
  document.title = els.appTitleInput.value.trim() || DEFAULT_APP_TITLE;
  state.appTitleTimer = setTimeout(saveAppTitle, 500);
}

async function goHome() {
  if (state.activeNoteId) {
    await flushAutosave();
    state.activeNoteId = null;
  }
  if (els.settingsDialog.open && typeof els.settingsDialog.close === 'function') els.settingsDialog.close();
  else els.settingsDialog.removeAttribute('open');
  showView('library');
  renderLibrary();
}

async function handleImport(file) {
  try {
    const data = JSON.parse(await file.text());
    await importData(data);
    state.notes = await listNotes();
    const theme = await getSetting('theme', 'system');
    applyTheme(theme);
    const appTitle = await getSetting('appTitle', '知識データベース');
    applyAppTitle(appTitle);
    state.selectedTags.clear();
    state.query = '';
    els.searchInput.value = '';
    renderLibrary();
    showToast('バックアップを読み込みました');
  } catch (error) {
    console.error(error);
    showToast('バックアップを読み込めませんでした');
  } finally {
    els.importInput.value = '';
  }
}

function wireEvents() {
  els.searchInput.addEventListener('input', () => {
    state.query = els.searchInput.value;
    renderLibrary();
  });
  els.sortSelect.addEventListener('change', () => {
    state.sort = els.sortSelect.value;
    renderLibrary();
  });
  els.addButton.addEventListener('click', () => openEditor());
  els.quickCaptureButton.addEventListener('click', () => openQuickCapture());
  els.quickCancelButton.addEventListener('click', closeQuickCapture);
  els.quickSaveButton.addEventListener('click', saveQuickCapture);
  els.quickEditButton.addEventListener('click', editQuickCapture);
  els.quickCaptureDialog.addEventListener('click', (event) => {
    if (event.target === els.quickCaptureDialog) closeQuickCapture();
  });
  els.quickCaptureDialog.addEventListener('cancel', (event) => {
    event.preventDefault();
    closeQuickCapture();
  });
  els.clipboardButton.addEventListener('click', createFromClipboard);
  els.randomButton.addEventListener('click', openRandomNote);
  els.trashButton.addEventListener('click', () => {
    renderTrash();
    showView('trash');
  });
  els.trashBackButton.addEventListener('click', () => showView('library'));
  els.backButton.addEventListener('click', closeEditor);
  els.homeButton.addEventListener('click', goHome);
  els.appTitleInput.addEventListener('input', scheduleAppTitleSave);
  els.appTitleInput.addEventListener('blur', saveAppTitle);

  for (const input of [els.titleInput, els.tagsInput, els.contentInput]) input.addEventListener('input', scheduleAutosave);

  els.favoriteButton.addEventListener('click', () => toggleFlag('favorite'));
  els.pinButton.addEventListener('click', () => toggleFlag('pinned'));
  els.copyTitleButton.addEventListener('click', () => writeClipboard(els.titleInput.value));
  els.copyBodyButton.addEventListener('click', () => writeClipboard(els.contentInput.value));
  els.copyAllButton.addEventListener('click', () => {
    const note = syncInputsToNote();
    const tagLine = note.tags.length ? `\n\n#${note.tags.join(' #')}` : '';
    writeClipboard(`${note.title}\n\n${note.content}${tagLine}`.trim());
  });
  els.duplicateButton.addEventListener('click', duplicateActive);
  els.deleteButton.addEventListener('click', moveActiveToTrash);

  document.querySelectorAll('[data-format]').forEach((button) => {
    button.addEventListener('click', () => insertFormatting(button.dataset.format));
  });

  els.attachmentInput.addEventListener('change', async () => {
    await addAttachments([...els.attachmentInput.files]);
    els.attachmentInput.value = '';
  });

  els.relatedSelect.addEventListener('change', () => {
    const note = currentNote();
    if (!note || !els.relatedSelect.value) return;
    if (!note.relatedIds.includes(els.relatedSelect.value)) note.relatedIds.push(els.relatedSelect.value);
    els.relatedSelect.value = '';
    renderRelated(note);
    scheduleAutosave();
  });

  els.settingsButton.addEventListener('click', () => {
    if (typeof els.settingsDialog.showModal === 'function') els.settingsDialog.showModal();
    else els.settingsDialog.setAttribute('open', '');
  });
  els.themeSelect.addEventListener('change', async () => {
    applyTheme(els.themeSelect.value);
    await setSetting('theme', els.themeSelect.value);
  });
  els.exportButton.addEventListener('click', async () => {
    downloadJson(await exportData());
    showToast('バックアップを書き出しました');
  });
  els.importInput.addEventListener('change', () => {
    const [file] = els.importInput.files;
    if (file) handleImport(file);
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushAutosave();
  });
}

async function init() {
  const theme = await getSetting('theme', 'system');
  applyTheme(theme);
  const appTitle = await getSetting('appTitle', '知識データベース');
  applyAppTitle(appTitle);
  state.notes = await listNotes();
  wireEvents();
  renderLibrary();
  showView('library');
  handleInitialShareTarget();

  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('./sw.js').catch((error) => console.warn('Service worker registration failed', error));
  }
}

init().catch((error) => {
  console.error(error);
  alert('アプリを起動できませんでした。ブラウザを再読み込みしてください。');
});
