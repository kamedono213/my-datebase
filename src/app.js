import { buildTagColorMap, createNote, filterAndSortNotes, normalizeTags } from './model.js';
import { summarize } from './summarize.js';
import { parseSharePayload } from './share.js';
import {
  listNotes,
  getSetting,
  setSetting,
  exportData,
  importData,
} from './db.js';
import {
  putNote,
  deleteNotePermanently,
  initCloudSync,
  signIn,
  signOutCloud,
} from './cloud-sync.js';

const $ = (id) => document.getElementById(id);
const DEFAULT_APP_TITLE = 'ピックノート';
const FREE_NOTE_LIMIT = 10;
const PRO_UNLOCKED_KEY = 'proUnlocked';

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
  quickCaptureDialog: $('quickCaptureDialog'),
  quickCancelButton: $('quickCancelButton'),
  quickTitleInput: $('quickTitleInput'),
  quickTagsInput: $('quickTagsInput'),
  quickContentInput: $('quickContentInput'),
  quickSaveButton: $('quickSaveButton'),
  quickEditButton: $('quickEditButton'),
  quizButton: $('quizButton'),
  trashButton: $('trashButton'),
  settingsButton: $('settingsButton'),
  homeButton: $('homeButton'),
  appTitleInput: $('appTitleInput'),
  backButton: $('backButton'),
  saveState: $('saveState'),
  pinButton: $('pinButton'),
  favoriteButton: $('favoriteButton'),
  titleInput: $('titleInput'),
  tagsPicker: $('tagsPicker'),
  contentInput: $('contentInput'),
  copyTitleButton: $('copyTitleButton'),
  copyBodyButton: $('copyBodyButton'),
  copyAllButton: $('copyAllButton'),
  summarizeButton: $('summarizeButton'),
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
  authStatusText: $('authStatusText'),
  signInButton: $('signInButton'),
  accountInfo: $('accountInfo'),
  accountEmail: $('accountEmail'),
  syncStatusText: $('syncStatusText'),
  signOutButton: $('signOutButton'),
};

const state = {
  notes: [],
  activeNoteId: null,
  expandedNoteId: null,
  selectedTags: new Set(),
  editingTags: new Set(),
  tagRegistry: [], // [{ name, color }] 作成時に色を選べるタグの一覧
  query: '',
  sort: 'updated',
  autosaveTimer: null,
  toastTimer: null,
  appTitleTimer: null,
};

const TAG_COLOR_SWATCHES = [
  '#E1665D', '#E8A33D', '#D9BB3C', '#6FA85B', '#3FA0A0',
  '#4E8BC9', '#7C6FD1', '#C36FC0', '#8A8F98', '#4A4A4A',
];

async function upsertTagInRegistry(name, color) {
  const registry = [...state.tagRegistry];
  const idx = registry.findIndex((t) => t.name.toLocaleLowerCase() === name.toLocaleLowerCase());
  if (idx >= 0) registry[idx] = { name, color };
  else registry.push({ name, color });
  await setSetting('tagRegistry', registry);
  state.tagRegistry = registry;
  return registry;
}

// 登録済みタグは指定した色、それ以外(バックアップ由来などの未登録タグ)は
// 従来通りの自動配色にフォールバックする。
function resolveTagColorMap(tagOrder) {
  const map = buildTagColorMap(tagOrder);
  for (const entry of state.tagRegistry) {
    const match = tagOrder.find((tag) => tag.toLocaleLowerCase() === entry.name.toLocaleLowerCase());
    if (match) map[match] = entry.color;
  }
  return map;
}

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

function renderTagFilters(tagEntries, colorMap) {
  els.tagFilters.replaceChildren();
  for (const [tag, count] of tagEntries) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `tag-chip${state.selectedTags.has(tag) ? ' active' : ''}`;
    button.style.setProperty('--tag-color', colorMap[tag]);
    button.textContent = `${tag} ${count}`;
    button.addEventListener('click', () => {
      // 以前は複数タグをAND条件で積み重ねる仕様だったが、選択中のタグが
      // 画面から見えづらく「別のタグを押したはずが該当なしになる」原因になっていた。
      // タップ1回=そのタグだけで絞り込み、もう一度押すと解除、に変更。
      if (state.selectedTags.has(tag) && state.selectedTags.size === 1) {
        state.selectedTags.clear();
      } else {
        state.selectedTags.clear();
        state.selectedTags.add(tag);
      }
      renderLibrary();
    });
    els.tagFilters.append(button);
  }
}

function renderLibrary() {
  const tagEntries = collectAllTags();
  const tagOrder = tagEntries.map(([tag]) => tag);
  const colorMap = resolveTagColorMap(tagOrder);
  renderTagFilters(tagEntries, colorMap);

  const notes = filterAndSortNotes(state.notes, {
    query: state.query,
    tags: [...state.selectedTags],
    sort: state.sort,
    tagOrder,
  });

  els.noteList.replaceChildren();
  els.resultCount.textContent = `${notes.length}件`;
  els.emptyState.hidden = notes.length !== 0 || Boolean(state.query) || state.selectedTags.size > 0;

  if (notes.length === 0 && (state.query || state.selectedTags.size)) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.innerHTML = '<strong>該当する知識がありません</strong><span>検索語やタブを変えてみてください。</span>';
    els.noteList.append(empty);
    return;
  }

  for (const note of notes) {
    const card = document.createElement('article');
    card.className = 'note-card';

    const row = document.createElement('div');
    row.className = 'note-title-row';
    row.tabIndex = 0;
    row.setAttribute('role', 'button');

    let longPressTimer = null;
    let longPressTriggered = false;
    row.addEventListener('pointerdown', () => {
      longPressTriggered = false;
      longPressTimer = setTimeout(() => {
        longPressTriggered = true;
        openRowMenu(note, row);
      }, 500);
    });
    const cancelLongPress = () => clearTimeout(longPressTimer);
    row.addEventListener('pointerup', cancelLongPress);
    row.addEventListener('pointerleave', cancelLongPress);
    row.addEventListener('pointercancel', cancelLongPress);
    row.addEventListener('click', () => {
      if (longPressTriggered) return;
      toggleInlineExpand(note.id);
    });
    row.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        toggleInlineExpand(note.id);
      }
    });

    const primaryTag = note.tags?.[0];
    if (primaryTag) {
      const dot = document.createElement('span');
      dot.className = 'tab-dot';
      dot.style.setProperty('--tag-color', colorMap[primaryTag] || 'var(--muted)');
      dot.setAttribute('aria-label', `タブ: ${primaryTag}`);
      dot.title = primaryTag;
      row.append(dot);
    }

    const title = document.createElement('div');
    title.className = 'note-title';
    title.textContent = note.title.trim() || '無題';
    row.append(title);

    const editBtn = document.createElement('button');
    editBtn.type = 'button';
    editBtn.className = 'note-edit-btn';
    editBtn.setAttribute('aria-label', '編集・削除メニュー');
    editBtn.title = '編集・削除メニュー';
    editBtn.textContent = '✏️';
    editBtn.addEventListener('click', (event) => {
      event.stopPropagation();
      openRowMenu(note, editBtn);
    });
    row.append(editBtn);

    card.append(row);
    card.append(buildInlinePanel(note));
    els.noteList.append(card);

    if (state.expandedNoteId === note.id) {
      const wrap = card.querySelector('.note-inline-wrap');
      requestAnimationFrame(() => wrap.classList.add('open'));
    }
  }
}

// タイトルの長押し、またはペンマークのタップで出す「編集/削除」メニュー。
function openRowMenu(note, anchorEl) {
  document.querySelectorAll('.row-menu').forEach((menu) => menu.remove());

  const menu = document.createElement('div');
  menu.className = 'row-menu';

  const editItem = document.createElement('button');
  editItem.type = 'button';
  editItem.textContent = '✏️ 編集';
  editItem.addEventListener('click', () => {
    menu.remove();
    openEditor(note.id);
  });

  const deleteItem = document.createElement('button');
  deleteItem.type = 'button';
  deleteItem.className = 'danger';
  deleteItem.textContent = '🗑 削除';
  deleteItem.addEventListener('click', async () => {
    menu.remove();
    note.deletedAt = Date.now();
    note.updatedAt = Date.now();
    await putNote(note);
    renderLibrary();
    showToast('ゴミ箱へ移動しました');
  });

  menu.append(editItem, deleteItem);
  document.body.append(menu);

  const rect = anchorEl.getBoundingClientRect();
  const menuRect = menu.getBoundingClientRect();
  let top = rect.bottom + 6;
  if (top + menuRect.height > window.innerHeight - 12) top = rect.top - menuRect.height - 6;
  const left = Math.min(Math.max(12, rect.left), window.innerWidth - menuRect.width - 12);
  menu.style.top = `${Math.max(12, top)}px`;
  menu.style.left = `${left}px`;

  requestAnimationFrame(() => {
    const closeOnOutside = (event) => {
      if (!menu.contains(event.target)) {
        menu.remove();
        document.removeEventListener('pointerdown', closeOnOutside);
      }
    };
    document.addEventListener('pointerdown', closeOnOutside);
  });
}

// タイトル行を押すとページ転換せずその場で内容を開く。中の内容欄はそのまま
// 編集もできる(自動保存)。フルページでの編集は長押し/ペンマークのメニューから。
function toggleInlineExpand(noteId) {
  state.expandedNoteId = state.expandedNoteId === noteId ? null : noteId;
  renderLibrary();
}

const inlineSaveTimers = new Map();

function scheduleInlineSave(note) {
  clearTimeout(inlineSaveTimers.get(note.id));
  const timer = setTimeout(async () => {
    note.updatedAt = Date.now();
    await putNote(note);
  }, 500);
  inlineSaveTimers.set(note.id, timer);
}

function buildInlinePanel(note) {
  const wrap = document.createElement('div');
  wrap.className = 'note-inline-wrap';
  const panel = document.createElement('div');
  panel.className = 'note-inline-panel';
  const inner = document.createElement('div');
  inner.className = 'note-inline-inner';

  if (state.expandedNoteId === note.id) {
    const textarea = document.createElement('textarea');
    textarea.className = 'note-inline-content';
    textarea.value = note.content;
    textarea.placeholder = '内容を入力…';
    textarea.rows = 1;
    const autoResize = () => {
      textarea.style.height = 'auto';
      textarea.style.height = `${textarea.scrollHeight}px`;
    };
    textarea.addEventListener('input', () => {
      note.content = textarea.value;
      scheduleInlineSave(note);
      autoResize();
    });
    textarea.addEventListener('click', (event) => event.stopPropagation());
    inner.append(textarea);
    requestAnimationFrame(autoResize);
  }

  panel.append(inner);
  wrap.append(panel);
  return wrap;
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

// 無料枠(10件)を超えて新規作成しようとしていないか確認する。
// 既存メモを開く時(noteIdあり)は対象外。
async function canCreateNewNote() {
  const unlocked = await getSetting(PRO_UNLOCKED_KEY, false);
  if (unlocked) return true;
  const activeCount = state.notes.filter((note) => note.deletedAt == null).length;
  return activeCount < FREE_NOTE_LIMIT;
}

function showUpgradePrompt() {
  showToast(`無料版は${FREE_NOTE_LIMIT}件までです。アップグレードは近日対応予定です。`);
}

async function openEditor(noteId = null, seed = null) {
  let note = noteId ? state.notes.find((item) => item.id === noteId) : null;
  if (!note) {
    if (!(await canCreateNewNote())) {
      showUpgradePrompt();
      return;
    }
    note = createNote(seed || {});
    state.notes.push(note);
    await putNote(note);
  }
  state.activeNoteId = note.id;
  els.titleInput.value = note.title;
  state.editingTags = new Set(normalizeTags(note.tags));
  renderTagsPicker();
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
  note.tags = normalizeTags([...state.editingTags]);
  note.updatedAt = Date.now();
  return note;
}

// 登録済みタグ(＋そのメモに既についている未登録タグ)をチップで表示し、
// タップでON/OFFできるようにする。末尾に新規タグ作成チップを置く。
function renderTagsPicker() {
  const registryNames = state.tagRegistry.map((t) => t.name);
  // タグ作成ダイアログを経由せず、自由入力の時代に付けられたタグも候補に出す。
  // (登録済みタグ一覧だけだと、編集中のメモに元々ついていないタグは出てこなかった)
  const usedNames = state.notes.flatMap((note) => note.tags || []);
  const seen = new Set(registryNames.map((name) => name.toLocaleLowerCase()));
  const extra = [];
  for (const tag of [...state.editingTags, ...usedNames]) {
    const key = tag.toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    extra.push(tag);
  }
  const allNames = [...registryNames, ...extra];
  const colorMap = resolveTagColorMap(allNames);

  els.tagsPicker.replaceChildren();
  for (const name of allNames) {
    const active = [...state.editingTags].some((tag) => tag.toLocaleLowerCase() === name.toLocaleLowerCase());
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = `tag-chip${active ? ' active' : ''}`;
    chip.style.setProperty('--tag-color', colorMap[name]);
    chip.textContent = name;
    chip.addEventListener('click', () => {
      if (active) {
        for (const tag of [...state.editingTags]) {
          if (tag.toLocaleLowerCase() === name.toLocaleLowerCase()) state.editingTags.delete(tag);
        }
      } else {
        state.editingTags.add(name);
      }
      renderTagsPicker();
      scheduleAutosave();
    });
    els.tagsPicker.append(chip);
  }

  const addChip = document.createElement('button');
  addChip.type = 'button';
  addChip.className = 'tag-chip tag-chip-add';
  addChip.textContent = '＋ 新規タグ';
  addChip.addEventListener('click', openTagCreator);
  els.tagsPicker.append(addChip);
}

function openTagCreator() {
  document.querySelectorAll('.tag-creator').forEach((el) => el.remove());

  const panel = document.createElement('div');
  panel.className = 'tag-creator';

  const nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.className = 'tag-creator-name';
  nameInput.placeholder = 'タグ名';
  nameInput.maxLength = 24;

  const swatchRow = document.createElement('div');
  swatchRow.className = 'tag-creator-swatches';
  let chosenColor = TAG_COLOR_SWATCHES[Math.floor(Math.random() * TAG_COLOR_SWATCHES.length)];
  const swatchButtons = TAG_COLOR_SWATCHES.map((color) => {
    const sw = document.createElement('button');
    sw.type = 'button';
    sw.className = `swatch${color === chosenColor ? ' selected' : ''}`;
    sw.style.setProperty('--sw', color);
    sw.addEventListener('click', () => {
      chosenColor = color;
      swatchButtons.forEach((b) => b.classList.remove('selected'));
      sw.classList.add('selected');
    });
    swatchRow.append(sw);
    return sw;
  });

  const actions = document.createElement('div');
  actions.className = 'tag-creator-actions';
  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.className = 'tt-skip';
  cancelBtn.textContent = 'キャンセル';
  const saveBtn = document.createElement('button');
  saveBtn.type = 'button';
  saveBtn.textContent = '追加';

  cancelBtn.addEventListener('click', () => panel.remove());
  saveBtn.addEventListener('click', async () => {
    const [name] = normalizeTags([nameInput.value]);
    if (!name) { panel.remove(); return; }
    await upsertTagInRegistry(name, chosenColor);
    state.editingTags.add(name);
    panel.remove();
    renderTagsPicker();
    scheduleAutosave();
  });

  actions.append(cancelBtn, saveBtn);
  panel.append(nameInput, swatchRow, actions);
  els.tagsPicker.insertAdjacentElement('afterend', panel);
  nameInput.focus();
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
  if (!(await canCreateNewNote())) {
    closeQuickCapture();
    showUpgradePrompt();
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
  if (!(await canCreateNewNote())) {
    showUpgradePrompt();
    return;
  }
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

// 隠し機能(チュートリアルでは触れない): タイトルだけ見せて「内容は？」と出題し、
// 「答えを見る」で自分が書いた内容を確認できる、ランダム出題クイズ。
function openQuizNote() {
  const candidates = state.notes.filter((note) => note.deletedAt == null);
  if (!candidates.length) return showToast('知識がまだありません');
  const note = candidates[Math.floor(Math.random() * candidates.length)];

  const overlay = document.createElement('div');
  overlay.className = 'quiz-overlay';

  const card = document.createElement('div');
  card.className = 'quiz-card';

  const label = document.createElement('div');
  label.className = 'quiz-label';
  label.textContent = 'このタイトルの内容は？';

  const titleEl = document.createElement('div');
  titleEl.className = 'quiz-title';
  titleEl.textContent = note.title.trim() || '無題';

  const contentEl = document.createElement('div');
  contentEl.className = 'quiz-content';
  contentEl.hidden = true;
  contentEl.textContent = note.content || '(内容なし)';

  const actions = document.createElement('div');
  actions.className = 'quiz-actions';
  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'secondary-btn';
  closeBtn.textContent = '閉じる';
  const revealBtn = document.createElement('button');
  revealBtn.type = 'button';
  revealBtn.className = 'primary-btn';
  revealBtn.textContent = '答えを見る';

  closeBtn.addEventListener('click', () => overlay.remove());
  revealBtn.addEventListener('click', () => {
    contentEl.hidden = false;
    revealBtn.remove();
  });

  actions.append(closeBtn, revealBtn);
  card.append(label, titleEl, contentEl, actions);
  overlay.append(card);
  overlay.addEventListener('click', (event) => { if (event.target === overlay) overlay.remove(); });
  document.body.append(overlay);
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

const SYNC_STATUS_LABELS = {
  'signed-out': '',
  syncing: '同期中…',
  synced: '同期済み',
  offline: 'オフライン（復帰時に同期します）',
  error: '同期エラー（このままローカルには保存されています）',
};

function updateAuthUI(user) {
  const signedIn = Boolean(user);
  els.signInButton.hidden = signedIn;
  els.accountInfo.hidden = !signedIn;
  els.authStatusText.hidden = signedIn;
  if (signedIn) {
    els.accountEmail.textContent = user.email || user.displayName || 'ログイン済み';
  }
}

function updateSyncStatusUI(status) {
  els.syncStatusText.textContent = SYNC_STATUS_LABELS[status] ?? '';
}

async function refreshNotesFromCloud() {
  state.notes = await listNotes();
  renderLibrary();
  if (!els.trashView.hidden) renderTrash();
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

function canGoBackInApp() {
  return Boolean(els.settingsDialog.open) || !els.editorView.hidden || !els.trashView.hidden;
}

// ハードウェア/ジェスチャーの「戻る」から呼ばれる共通の戻り先。
// 編集中は必ずflushAutosaveしてから戻るので、戻る操作で未保存分が消えない。
async function goBack() {
  if (els.settingsDialog.open) {
    els.settingsDialog.close();
    return;
  }
  if (!els.editorView.hidden) {
    await closeEditor();
    return;
  }
  if (!els.trashView.hidden) {
    showView('library');
    return;
  }
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
    const appTitle = await getSetting('appTitle', 'ピックノート');
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
  // quickCaptureButton/clipboardButtonのUIは廃止(＋は右下のFABのみ)。
  // クイック追加ダイアログ自体は共有(share target)からの受け口として残す。
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
  els.quizButton.addEventListener('click', openQuizNote);
  els.trashButton.addEventListener('click', () => {
    renderTrash();
    showView('trash');
  });
  els.trashBackButton.addEventListener('click', () => showView('library'));
  els.backButton.addEventListener('click', closeEditor);
  els.homeButton.addEventListener('click', goHome);
  els.appTitleInput.addEventListener('input', scheduleAppTitleSave);
  els.appTitleInput.addEventListener('blur', saveAppTitle);

  for (const input of [els.titleInput, els.contentInput]) input.addEventListener('input', scheduleAutosave);

  els.favoriteButton.addEventListener('click', () => toggleFlag('favorite'));
  els.pinButton.addEventListener('click', () => toggleFlag('pinned'));
  els.copyTitleButton.addEventListener('click', () => writeClipboard(els.titleInput.value));
  els.copyBodyButton.addEventListener('click', () => writeClipboard(els.contentInput.value));
  els.copyAllButton.addEventListener('click', () => {
    const note = syncInputsToNote();
    const tagLine = note.tags.length ? `\n\n#${note.tags.join(' #')}` : '';
    writeClipboard(`${note.title}\n\n${note.content}${tagLine}`.trim());
  });
  els.summarizeButton.addEventListener('click', () => {
    const content = els.contentInput.value;
    if (!content.trim()) {
      showToast('本文が空です');
      return;
    }
    const summary = summarize(content, 3);
    writeClipboard(summary);
    showToast('要約をコピーしました(無料のオフライン要約・簡易版)');
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

  els.signInButton.addEventListener('click', async () => {
    try {
      await signIn();
    } catch (error) {
      console.error(error);
      // 原因を特定するため、一旦エラーの中身をそのまま出す(落ち着いたら簡潔なメッセージに戻す)。
      const detail = error?.code || error?.message || String(error);
      showToast(`ログインできませんでした: ${detail}`);
    }
  });
  els.signOutButton.addEventListener('click', async () => {
    await signOutCloud();
    showToast('ログアウトしました');
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      flushAutosave();
    } else if (document.visibilityState === 'visible') {
      // オーバーレイ(常駐アイコン)から追加したメモは、本体アプリがバックグラウンドで
      // 開いたままの間に別経路でIndexedDBへ書き込まれる。本体アプリ側は起動時に一度
      // listNotes()した内容をメモリに保持したままなので、フォアグラウンドに戻るたびに
      // 読み直さないと「保存されたのに一覧に出てこない」状態になる。
      reloadNotesFromDb();
    }
  });
}

async function reloadNotesFromDb() {
  const activeId = state.activeNoteId;
  state.notes = await listNotes();
  if (activeId && !state.notes.some((note) => note.id === activeId)) {
    state.activeNoteId = null;
    state.expandedNoteId = null;
  }
  renderLibrary();
}

async function init() {
  const theme = await getSetting('theme', 'system');
  applyTheme(theme);
  const appTitle = await getSetting('appTitle', 'ピックノート');
  applyAppTitle(appTitle);
  state.notes = await listNotes();

  // 無料枠(10件)導入より前から使っていた人が、更新した途端に新規作成をブロック
  // されることのないように救済する。「proUnlockedが未設定」かつ「既に10件を超えて
  // 使っている」場合だけ、自動的に無制限扱いにする。
  const proUnlockedSetting = await getSetting(PRO_UNLOCKED_KEY, null);
  if (proUnlockedSetting === null) {
    const activeCount = state.notes.filter((note) => note.deletedAt == null).length;
    await setSetting(PRO_UNLOCKED_KEY, activeCount > FREE_NOTE_LIMIT);
  }

  state.tagRegistry = await getSetting('tagRegistry', []);

  // ゴミ箱に入って30日経ったメモは自動で完全削除する
  const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
  const now = Date.now();
  const expired = state.notes.filter((note) => note.deletedAt != null && now - note.deletedAt > THIRTY_DAYS_MS);
  for (const note of expired) {
    await deleteNotePermanently(note.id);
  }
  if (expired.length) {
    const expiredIds = new Set(expired.map((note) => note.id));
    state.notes = state.notes.filter((note) => !expiredIds.has(note.id));
  }

  wireEvents();
  renderLibrary();
  showView('library');
  handleInitialShareTarget();

  initCloudSync({
    onNotesChanged: refreshNotesFromCloud,
    onStatusChange: updateSyncStatusUI,
    onAuthChanged: updateAuthUI,
  });

  const isNativeApp = Boolean(window.Capacitor?.isNativePlatform?.());

  // ハードウェアの戻るボタンと、Android端末の画面端スワイプ(ジェスチャーナビゲーション)は
  // どちらもAndroid側では同じ「戻る」操作として扱われ、@capacitor/appのbackButton
  // イベントに集約される。編集画面などの時はアプリを閉じずにgoBack()、
  // ホーム(一覧)まで戻っていたら通常通りアプリを終了する。
  const NativeApp = window.Capacitor?.Plugins?.App;
  if (NativeApp) {
    NativeApp.addListener('backButton', () => {
      if (canGoBackInApp()) goBack();
      else NativeApp.exitApp();
    });
  }

  if (isNativeApp) {
    // ネイティブアプリはAPK自体に最新のファイルが同梱されているので、
    // PWA用のservice workerキャッシュは不要かつ有害(更新した画面が古いまま
    // 表示され続けるバグの原因になる)。既に登録されてしまっている端末のために
    // 明示的に解除・キャッシュ削除もしておく。
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.getRegistrations().then((regs) => {
        for (const reg of regs) reg.unregister();
      }).catch(() => {});
    }
    if ('caches' in window) {
      caches.keys().then((keys) => Promise.all(keys.map((key) => caches.delete(key)))).catch(() => {});
    }
  } else if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('./sw.js').catch((error) => console.warn('Service worker registration failed', error));
  }
}

init().catch((error) => {
  console.error(error);
  alert('アプリを起動できませんでした。ブラウザを再読み込みしてください。');
});
