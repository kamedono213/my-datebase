import { buildTagColorMap, createNote, filterAndSortNotes, normalizeTags, normalizeNoteType } from './model.js';
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

const NOTE_TYPE_LABELS = { knowledge: '知識', movie: '映画', book: '本' };
const MOVIE_TEMPLATE =
  '■鑑賞日: \n\n' +
  '■あらすじ:\n\n\n' +
  '■印象に残ったシーン・セリフ:\n\n\n' +
  '■感想・考察:\n';

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
  trashEmptyAllButton: $('trashEmptyAllButton'),
  accountButton: $('accountButton'),
  accountAvatarPlaceholder: $('accountAvatarPlaceholder'),
  accountAvatarImg: $('accountAvatarImg'),
  homeButton: $('homeButton'),
  appTitleInput: $('appTitleInput'),
  backButton: $('backButton'),
  saveState: $('saveState'),
  pinButton: $('pinButton'),
  favoriteButton: $('favoriteButton'),
  titleInput: $('titleInput'),
  tagsPicker: $('tagsPicker'),
  contentInput: $('contentInput'),
  deleteButton: $('deleteButton'),
  attachmentInput: $('attachmentInput'),
  attachmentList: $('attachmentList'),
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
  selectionBar: $('selectionBar'),
  selectionCount: $('selectionCount'),
  selectionTagButton: $('selectionTagButton'),
  selectionDeleteButton: $('selectionDeleteButton'),
  selectionCancelButton: $('selectionCancelButton'),
  bulkTagDialog: $('bulkTagDialog'),
  bulkTagTargetCount: $('bulkTagTargetCount'),
  bulkTagPicker: $('bulkTagPicker'),
  bulkTagCloseButton: $('bulkTagCloseButton'),
  bulkTagApplyButton: $('bulkTagApplyButton'),
  bottomTabbar: $('bottomTabbar'),
};

const state = {
  notes: [],
  activeNoteId: null,
  expandedNoteId: null,
  activeType: 'knowledge', // 下部タブ: 'knowledge' | 'movie' | 'book'
  bookLevel: {}, // noteId -> 0(閉じる)/1(概要)/2(概要+章一覧)
  chapterOpen: {}, // `${noteId}:${chapterId}` -> bool
  selectedTags: new Set(),
  editingTags: new Set(),
  selectionMode: false,
  selectedNoteIds: new Set(),
  bulkTagPicks: new Set(),
  // タグの登録一覧はノートの種類ごとに別々に持つ({ name, color }[])。
  // 知識のタグ(生物など)が映画のタグ候補に出てきてしまうのを防ぐため。
  tagRegistries: { knowledge: [], movie: [], book: [] },
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

// 映画タブの初回起動時だけ、オーソドックスなジャンルを登録済みタグとして
// 用意しておく(知識タブのタグとは完全に別枠)。あとから自由に追加・削除できる。
const DEFAULT_MOVIE_TAGS = [
  'アクション', 'コメディ', 'ドラマ', 'ホラー', 'SF', 'ファンタジー',
  'ミステリー', 'サスペンス', '恋愛', '実話', 'アニメ', 'ドキュメンタリー',
];

// 知識タブは昔からの設定キー'tagRegistry'のまま(既存データとの互換性のため)、
// 映画・本は別キーに分けて保存する。
function tagRegistrySettingKey(noteType) {
  return noteType === 'knowledge' ? 'tagRegistry' : `tagRegistry:${noteType}`;
}

async function upsertTagInRegistry(name, color, noteType = state.activeType) {
  const type = normalizeNoteType(noteType);
  const registry = [...(state.tagRegistries[type] || [])];
  const idx = registry.findIndex((t) => t.name.toLocaleLowerCase() === name.toLocaleLowerCase());
  if (idx >= 0) registry[idx] = { name, color };
  else registry.push({ name, color });
  await setSetting(tagRegistrySettingKey(type), registry);
  state.tagRegistries[type] = registry;
  return registry;
}

// タグを登録解除し、そのタグが付いていた同じタブのメモからも取り除く
// (宙ぶらりんな未登録タグとして残らないように)。
async function deleteTagFromRegistry(name, noteType) {
  const type = normalizeNoteType(noteType);
  const key = name.toLocaleLowerCase();
  const registry = (state.tagRegistries[type] || []).filter((t) => t.name.toLocaleLowerCase() !== key);
  await setSetting(tagRegistrySettingKey(type), registry);
  state.tagRegistries[type] = registry;
  for (const note of state.notes) {
    if (normalizeNoteType(note.noteType) !== type) continue;
    if (!note.tags?.some((t) => t.toLocaleLowerCase() === key)) continue;
    note.tags = note.tags.filter((t) => t.toLocaleLowerCase() !== key);
    note.updatedAt = Date.now();
    await putNote(note);
  }
  for (const tag of [...state.editingTags]) {
    if (tag.toLocaleLowerCase() === key) state.editingTags.delete(tag);
  }
}

// 登録済みタグは指定した色、それ以外(バックアップ由来などの未登録タグ)は
// 従来通りの自動配色にフォールバックする。
function resolveTagColorMap(tagOrder, noteType = state.activeType) {
  const map = buildTagColorMap(tagOrder);
  const registry = state.tagRegistries[normalizeNoteType(noteType)] || [];
  for (const entry of registry) {
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

function updateBottomTabbar() {
  if (!els.bottomTabbar) return;
  for (const btn of els.bottomTabbar.querySelectorAll('button')) {
    btn.classList.toggle('active', btn.dataset.noteType === state.activeType);
  }
}

// 映画タイプのメモ用、タイトル行に表示する5段階の星評価。
// タップしたところまでを塗りつぶす(例: 3個目をタップ→★3つ)。同じ星を押すと0に戻す。
function buildStarRating(note) {
  const wrap = document.createElement('span');
  wrap.className = 'star-rating';
  // タイトル行(.note-title-row)はタップ展開やスワイプ削除をpointerdown/pointermove/
  // pointerupで検知しているため、clickだけ止めても星の操作がその下のジェスチャーに
  // 伝わってしまい、意図せずタイトルが展開されていた。星エリア全体でポインター系の
  // イベントも含めて止める。
  for (const type of ['pointerdown', 'pointermove', 'pointerup', 'click']) {
    wrap.addEventListener(type, (event) => event.stopPropagation());
  }

  for (let i = 1; i <= 5; i++) {
    const star = document.createElement('button');
    star.type = 'button';
    star.className = 'star-btn';
    star.textContent = i <= (note.rating || 0) ? '★' : '☆';
    star.setAttribute('aria-label', `評価${i}`);
    star.addEventListener('click', (event) => {
      event.stopPropagation();
      note.rating = note.rating === i ? 0 : i;
      note.updatedAt = Date.now();
      putNote(note);
      // renderLibrary()で一覧全体を作り直すと、展開中のパネルの.note-inline-wrapも
      // 新しい要素に置き換わり、.openクラスがrequestAnimationFrameで付け直される
      // ため、開閉アニメーションが最初からやり直しになって「一瞬閉じて開く」ように
      // 見えてしまう。星の見た目だけその場で書き換えて、再描画はしない。
      Array.from(wrap.children).forEach((s, idx) => {
        s.textContent = idx + 1 <= note.rating ? '★' : '☆';
      });
    });
    wrap.append(star);
  }
  return wrap;
}

function notesInActiveTab() {
  return state.notes.filter((note) => normalizeNoteType(note.noteType) === state.activeType);
}

function collectAllTags() {
  const counts = new Map();
  for (const note of notesInActiveTab()) {
    if (note.deletedAt != null) continue;
    for (const tag of note.tags || []) counts.set(tag, (counts.get(tag) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'ja'));
}

function renderTagFilters(tagEntries, colorMap) {
  els.tagFilters.replaceChildren();

  const allCount = notesInActiveTab().filter((note) => note.deletedAt == null).length;
  const allButton = document.createElement('button');
  allButton.type = 'button';
  allButton.className = `tag-chip${state.selectedTags.size === 0 ? ' active' : ''}`;
  allButton.style.setProperty('--tag-color', 'var(--muted)');
  allButton.textContent = `すべて ${allCount}`;
  allButton.addEventListener('click', () => {
    state.selectedTags.clear();
    renderLibrary();
  });
  els.tagFilters.append(allButton);

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
  updateSelectionBar();
  const tagEntries = collectAllTags();
  const tagOrder = tagEntries.map(([tag]) => tag);
  const colorMap = resolveTagColorMap(tagOrder);
  renderTagFilters(tagEntries, colorMap);

  const notes = filterAndSortNotes(state.notes, {
    query: state.query,
    tags: [...state.selectedTags],
    sort: state.sort,
    tagOrder,
    noteType: state.activeType,
  });

  updateBottomTabbar();

  els.noteList.replaceChildren();
  els.resultCount.textContent = `${notes.length}件`;
  els.emptyState.hidden = notes.length !== 0 || Boolean(state.query) || state.selectedTags.size > 0;

  if (notes.length === 0 && (state.query || state.selectedTags.size)) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.innerHTML = '<strong>該当するメモがありません</strong><span>検索語やタグを変えてみてください。</span>';
    els.noteList.append(empty);
    return;
  }

  if (notes.length === 0) {
    const label = NOTE_TYPE_LABELS[state.activeType];
    els.emptyState.querySelector('strong').textContent = `まだ${label}がありません`;
    els.emptyState.querySelector('span').textContent = '右下の＋から最初のメモを作れます。';
  }

  for (const note of notes) {
    const card = document.createElement('article');
    card.className = 'note-card';
    if (state.selectionMode) card.classList.add('selection-mode');
    if (state.selectedNoteIds.has(note.id)) card.classList.add('selected');

    const swipeWrap = document.createElement('div');
    swipeWrap.className = 'note-swipe-wrap';

    const swipeBg = document.createElement('div');
    swipeBg.className = 'note-swipe-bg';
    swipeBg.innerHTML = '<span aria-hidden="true">🗑</span>';
    swipeWrap.append(swipeBg);

    const row = document.createElement('div');
    row.className = 'note-title-row';
    row.tabIndex = 0;
    row.setAttribute('role', 'button');

    const selectDot = document.createElement('span');
    selectDot.className = 'note-select-dot';
    selectDot.setAttribute('aria-hidden', 'true');
    selectDot.textContent = state.selectedNoteIds.has(note.id) ? '✓' : '';
    row.append(selectDot);

    attachRowGestures(row, note, swipeBg);

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

    if (normalizeNoteType(note.noteType) === 'movie') {
      row.append(buildStarRating(note));
    }

    const editBtn = document.createElement('button');
    editBtn.type = 'button';
    editBtn.className = 'note-edit-btn';
    editBtn.setAttribute('aria-label', '編集・削除メニュー');
    editBtn.title = '編集・削除メニュー';
    editBtn.textContent = '✏️';
    editBtn.addEventListener('click', (event) => {
      event.stopPropagation();
      if (state.selectionMode) return;
      openRowMenu(note, editBtn);
    });
    row.append(editBtn);

    swipeWrap.append(row);
    card.append(swipeWrap);
    card.append(buildInlinePanel(note));
    els.noteList.append(card);

    const isBookOpen = normalizeNoteType(note.noteType) === 'book' && (state.bookLevel[note.id] || 0) > 0;
    if (state.expandedNoteId === note.id || isBookOpen) {
      const wrap = card.querySelector('.note-inline-wrap');
      requestAnimationFrame(() => wrap.classList.add('open'));
    }
  }
}

const SWIPE_REVEAL_PX = 84; // スワイプで止まる位置(ゴミ箱が見える所まで)
const SWIPE_DELETE_PX = 150; // ここを超えて離すと即削除

// 長押しで複数選択モードに入ると同時にrenderLibrary()がDOMを丸ごと作り直すため、
// 指がまだ触れたままの状態で古いrow要素が消え、直後に発生するpointerupは
// 新しく作られたrow(状態がリセットされた別インスタンス)で拾われてしまう。
// これをゴースト操作として無視するためのタイムスタンプガード。
let selectionModeEnteredAt = 0;

// タイトル行のジェスチャーをまとめて設定する:
// ・軽くタップ → 展開(または選択モード中はON/OFF切り替え)
// ・長押し(500ms) → 複数選択モードに入る
// ・左スワイプ → ゴミ箱を出す。さらに引くと削除
function attachRowGestures(row, note, swipeBg) {
  let longPressTimer = null;
  let longPressTriggered = false;
  let dragging = false;
  let swiping = false;
  let startX = 0;
  let startY = 0;
  let currentX = 0;
  let restingX = 0; // 前回スワイプで止まった位置(0 or -SWIPE_REVEAL_PX)

  function setTranslate(x, animated) {
    row.classList.toggle('swiping', !animated);
    row.style.transform = x ? `translateX(${x}px)` : '';
  }

  function cancelLongPress() {
    clearTimeout(longPressTimer);
  }

  row.addEventListener('pointerdown', (event) => {
    if (event.button !== undefined && event.button !== 0) return;
    startX = event.clientX;
    startY = event.clientY;
    currentX = restingX;
    dragging = false;
    swiping = false;
    longPressTriggered = false;
    cancelLongPress();
    longPressTimer = setTimeout(() => {
      if (dragging) return; // スワイプ中なら長押し扱いにしない
      longPressTriggered = true;
      if (navigator.vibrate) navigator.vibrate(12);
      enterSelectionMode(note.id);
    }, 500);
  });

  row.addEventListener('pointermove', (event) => {
    if (state.selectionMode) return; // 選択モード中はスワイプ削除を無効化
    const dx = event.clientX - startX;
    const dy = event.clientY - startY;
    if (!dragging) {
      if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
      if (Math.abs(dy) > Math.abs(dx)) return; // 縦スクロール優先、スワイプ扱いにしない
      dragging = true;
      swiping = true;
      cancelLongPress();
      row.setPointerCapture?.(event.pointerId);
    }
    if (!swiping) return;
    event.preventDefault();
    const raw = restingX + dx;
    currentX = Math.max(Math.min(raw, 0), -SWIPE_DELETE_PX - 40);
    setTranslate(currentX, false);
  });

  async function endSwipe() {
    if (currentX <= -SWIPE_DELETE_PX) {
      setTranslate(-400, true);
      note.deletedAt = Date.now();
      note.updatedAt = Date.now();
      await putNote(note);
      showToast('ゴミ箱へ移動しました');
      setTimeout(renderLibrary, 160);
      return;
    }
    if (currentX <= -SWIPE_REVEAL_PX / 2) {
      restingX = -SWIPE_REVEAL_PX;
    } else {
      restingX = 0;
    }
    setTranslate(restingX, true);
  }

  row.addEventListener('pointerup', (event) => {
    cancelLongPress();
    if (swiping) {
      row.releasePointerCapture?.(event.pointerId);
      endSwipe();
      swiping = false;
      dragging = false;
      return;
    }
    dragging = false;
    if (longPressTriggered) return;
    if (restingX !== 0) {
      // ゴミ箱が見えている状態でのタップ → そのタップで削除確定
      endSwipeTapToDelete();
      return;
    }
    if (state.selectionMode) {
      if (Date.now() - selectionModeEnteredAt < 400) return; // 選択モード開始直後のゴーストpointerupを無視
      toggleNoteSelection(note.id);
    } else {
      toggleInlineExpand(note.id);
    }
  });

  async function endSwipeTapToDelete() {
    setTranslate(-400, true);
    note.deletedAt = Date.now();
    note.updatedAt = Date.now();
    await putNote(note);
    showToast('ゴミ箱へ移動しました');
    setTimeout(renderLibrary, 160);
  }

  // ゴミ箱が見えている状態(restingX !== 0)でrow自体は左にずれているため、
  // 露出したゴミ箱アイコン部分は実際にはswipeBg要素の上にある。
  // rowのpointerupだけでは拾えないので、ここにも同じタップ削除を仕込む。
  swipeBg?.addEventListener('pointerup', () => {
    if (restingX !== 0) endSwipeTapToDelete();
  });

  row.addEventListener('pointerleave', () => {
    cancelLongPress();
  });
  row.addEventListener('pointercancel', () => {
    cancelLongPress();
    dragging = false;
    swiping = false;
    setTranslate(restingX, true);
  });
  row.addEventListener('click', (event) => {
    // pointerup側で処理済みなので、合成clickでの二重発火(展開/選択の連打)だけ防ぐ。
    if (swiping || longPressTriggered) event.preventDefault();
  });
  row.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      if (state.selectionMode) toggleNoteSelection(note.id);
      else toggleInlineExpand(note.id);
    }
  });
}

// ---- 複数選択モード ----

function enterSelectionMode(firstNoteId) {
  state.selectionMode = true;
  state.selectedNoteIds = new Set([firstNoteId]);
  selectionModeEnteredAt = Date.now();
  renderLibrary();
}

function toggleNoteSelection(noteId) {
  if (state.selectedNoteIds.has(noteId)) state.selectedNoteIds.delete(noteId);
  else state.selectedNoteIds.add(noteId);
  if (state.selectedNoteIds.size === 0) {
    exitSelectionMode();
    return;
  }
  renderLibrary();
}

function exitSelectionMode() {
  state.selectionMode = false;
  state.selectedNoteIds = new Set();
  renderLibrary();
}

function updateSelectionBar() {
  const count = state.selectedNoteIds.size;
  els.selectionBar.hidden = !state.selectionMode;
  els.selectionCount.textContent = `${count}件選択中`;
}

async function bulkDeleteSelected() {
  const ids = [...state.selectedNoteIds];
  if (ids.length === 0) return;
  if (!confirm(`選択した${ids.length}件をゴミ箱へ移動しますか？`)) return;
  const now = Date.now();
  for (const id of ids) {
    const note = state.notes.find((n) => n.id === id);
    if (!note) continue;
    note.deletedAt = now;
    note.updatedAt = now;
    await putNote(note);
  }
  showToast(`${ids.length}件をゴミ箱へ移動しました`);
  exitSelectionMode();
}

function openBulkTagDialog() {
  if (state.selectedNoteIds.size === 0) return;
  state.bulkTagPicks = new Set();
  els.bulkTagTargetCount.textContent = String(state.selectedNoteIds.size);
  renderBulkTagPicker();
  els.bulkTagDialog.hidden = false;
}

function closeBulkTagDialog() {
  els.bulkTagDialog.hidden = true;
}

function tagChipCheck() {
  const check = document.createElement('span');
  check.className = 'tag-chip-check';
  check.setAttribute('aria-hidden', 'true');
  check.textContent = '✓';
  return check;
}

function renderBulkTagPicker() {
  const registryNames = (state.tagRegistries[state.activeType] || []).map((t) => t.name);
  const usedNames = notesInActiveTab().flatMap((note) => note.tags || []);
  const seen = new Set(registryNames.map((n) => n.toLocaleLowerCase()));
  const names = [...registryNames];
  for (const tag of usedNames) {
    const key = tag.toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    names.push(tag);
  }
  const colorMap = resolveTagColorMap(names);

  els.bulkTagPicker.replaceChildren();
  for (const name of names) {
    const active = state.bulkTagPicks.has(name);
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = `tag-chip${active ? ' active' : ''}`;
    chip.style.setProperty('--tag-color', colorMap[name]);
    chip.append(tagChipCheck(), document.createTextNode(name));
    chip.addEventListener('click', () => {
      if (state.bulkTagPicks.has(name)) state.bulkTagPicks.delete(name);
      else state.bulkTagPicks.add(name);
      renderBulkTagPicker();
    });
    els.bulkTagPicker.append(chip);
  }
  if (names.length === 0) {
    const hint = document.createElement('span');
    hint.className = 'muted';
    hint.textContent = 'まだタグがありません。メモの編集画面で新規タグを作ってください。';
    els.bulkTagPicker.append(hint);
  }
}

async function applyBulkTags() {
  const picks = [...state.bulkTagPicks];
  if (picks.length === 0) {
    closeBulkTagDialog();
    return;
  }
  const ids = [...state.selectedNoteIds];
  for (const id of ids) {
    const note = state.notes.find((n) => n.id === id);
    if (!note) continue;
    const merged = new Set([...(note.tags || []), ...picks]);
    note.tags = normalizeTags([...merged]);
    note.updatedAt = Date.now();
    await putNote(note);
  }
  showToast(`${ids.length}件にタグを追加しました`);
  closeBulkTagDialog();
  exitSelectionMode();
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
  const note = state.notes.find((item) => item.id === noteId);
  if (note && normalizeNoteType(note.noteType) === 'book') {
    // 本タイプ: 1タップで概要+章一覧を同時に開閉する(閉じる⇔開く、の2段階)。
    // 各章の中身は、章の行を個別にタップした時だけ開く(buildBookInlinePanel側)。
    const level = state.bookLevel[noteId] || 0;
    state.bookLevel[noteId] = level > 0 ? 0 : 2;
    renderLibrary();
    return;
  }
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

  if (normalizeNoteType(note.noteType) === 'book') {
    buildBookInlinePanel(note, inner);
  } else if (state.expandedNoteId === note.id) {
    const textarea = document.createElement('textarea');
    textarea.className = 'note-inline-content';
    textarea.value = note.content;
    textarea.placeholder = '内容を入力…';
    textarea.rows = 1;
    const autoResize = () => growAndScroll(textarea);
    textarea.addEventListener('input', () => {
      note.content = textarea.value;
      scheduleInlineSave(note);
      autoResize();
    });
    textarea.addEventListener('click', (event) => event.stopPropagation());
    inner.append(textarea);
    requestAnimationFrame(autoResize);

    if (note.attachments && note.attachments.length) {
      const images = document.createElement('div');
      images.className = 'note-inline-images';
      images.addEventListener('click', (event) => event.stopPropagation());
      for (const attachment of note.attachments) {
        const img = document.createElement('img');
        img.src = attachment.dataUrl;
        img.alt = attachment.name || '添付画像';
        img.loading = 'lazy';
        wireImageLongPressZoom(img);
        images.append(img);
      }
      inner.append(images);
    }
  }

  panel.append(inner);
  wrap.append(panel);
  return wrap;
}

// 「本」タイプ専用: タイトルのみ→(タップ)概要→(タップ)概要+章一覧、の3段階表示。
// 概要は既存の note.content フィールドをそのまま流用し(スキーマ追加なし)、
// 章だけ note.chapters の新フィールドを使う。
function buildBookInlinePanel(note, inner) {
  const level = state.bookLevel[note.id] || 0;
  if (level < 1) return;

  const overviewLabel = document.createElement('label');
  overviewLabel.className = 'inline-field-label';
  overviewLabel.textContent = '概要';
  inner.append(overviewLabel);

  const overview = document.createElement('textarea');
  overview.className = 'note-inline-content book-overview';
  overview.value = note.content;
  overview.placeholder = 'この本の概要・あらすじ・まとめ';
  overview.rows = 1;
  const autoResize = () => growAndScroll(overview);
  overview.addEventListener('input', () => {
    note.content = overview.value;
    scheduleInlineSave(note);
    autoResize();
  });
  overview.addEventListener('click', (event) => event.stopPropagation());
  inner.append(overview);
  requestAnimationFrame(autoResize);

  if (note.attachments && note.attachments.length) {
    const images = document.createElement('div');
    images.className = 'note-inline-images';
    images.addEventListener('click', (event) => event.stopPropagation());
    for (const attachment of note.attachments) {
      const img = document.createElement('img');
      img.src = attachment.dataUrl;
      img.alt = attachment.name || '添付画像';
      img.loading = 'lazy';
      wireImageLongPressZoom(img);
      images.append(img);
    }
    inner.append(images);
  }

  if (level < 2) return;

  const chapterList = document.createElement('div');
  chapterList.className = 'chapter-list';

  note.chapters.forEach((chapter, index) => {
    const key = `${note.id}:${chapter.id}`;
    let open = Boolean(state.chapterOpen[key]);

    const row = document.createElement('div');
    row.className = 'chapter-row';

    const chapterSwipeWrap = document.createElement('div');
    chapterSwipeWrap.className = 'chapter-swipe-wrap';
    const chapterSwipeBg = document.createElement('div');
    chapterSwipeBg.className = 'chapter-swipe-bg';
    chapterSwipeBg.innerHTML = '<span aria-hidden="true">🗑</span>';
    chapterSwipeWrap.append(chapterSwipeBg);

    const head = document.createElement('div');
    head.className = 'chapter-row-head';
    head.innerHTML =
      `<span class="chapter-n">${index + 1}</span>` +
      `<span class="chapter-t"></span>` +
      `<span class="chapter-caret${open ? ' open' : ''}">▶</span>`;
    head.querySelector('.chapter-t').textContent = chapter.title || '無題の章';
    chapterSwipeWrap.append(head);

    // 章の中身(本文欄)は開閉に関わらず常に作っておき、hiddenで出し入れする。
    // 以前はrenderLibrary()で一覧全体を作り直して開閉していたため、他の章や
    // 概要欄まで含めて要素が全部作り直され、開閉アニメーションがやり直しに
    // なって画面がチラついていた。
    const body = document.createElement('div');
    body.className = 'chapter-row-body';
    body.hidden = !open;
    const ta = document.createElement('textarea');
    ta.className = 'note-inline-content';
    ta.value = chapter.content;
    ta.placeholder = '自由に書いてください';
    ta.rows = 1;
    const chapterAutoResize = () => growAndScroll(ta);
    ta.addEventListener('input', () => {
      chapter.content = ta.value;
      scheduleInlineSave(note);
      chapterAutoResize();
    });
    ta.addEventListener('click', (event) => event.stopPropagation());
    body.append(ta);

    // 画像: 大項目(章)ごとに追加できる。本文欄と同じbody(開閉で出し入れされる
    // 領域)の中に置くので、章を開いた時だけ画像も一緒に見える。
    if (!Array.isArray(chapter.attachments)) chapter.attachments = [];
    const chapterImages = document.createElement('div');
    chapterImages.className = 'note-inline-images';
    chapterImages.addEventListener('click', (event) => event.stopPropagation());
    function renderChapterImages() {
      chapterImages.replaceChildren();
      for (const attachment of chapter.attachments) {
        const img = document.createElement('img');
        img.src = attachment.dataUrl;
        img.alt = attachment.name || '添付画像';
        img.loading = 'lazy';
        wireImageLongPressZoom(img);
        chapterImages.append(img);
      }
    }
    renderChapterImages();
    body.append(chapterImages);

    const addImageLabel = document.createElement('label');
    addImageLabel.className = 'small-btn file-btn chapter-add-image-btn';
    addImageLabel.textContent = '＋ 画像を追加';
    addImageLabel.addEventListener('click', (event) => event.stopPropagation());
    const chapterImageInput = document.createElement('input');
    chapterImageInput.type = 'file';
    chapterImageInput.accept = 'image/*';
    chapterImageInput.multiple = true;
    chapterImageInput.hidden = true;
    chapterImageInput.addEventListener('click', (event) => event.stopPropagation());
    chapterImageInput.addEventListener('change', async () => {
      const files = [...chapterImageInput.files];
      chapterImageInput.value = '';
      for (const file of files) {
        if (!file.type.startsWith('image/')) continue;
        if (file.size > 10 * 1024 * 1024) { showToast(`${file.name} は10MBを超えるため追加できません`); continue; }
        const dataUrl = await fileToDataUrl(file);
        chapter.attachments.push({
          id: `img-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          name: file.name, type: file.type, dataUrl,
        });
      }
      renderChapterImages();
      scheduleInlineSave(note);
    });
    addImageLabel.append(chapterImageInput);
    body.append(addImageLabel);

    // 開いた状態で作られた章(初期表示)は見えているのですぐ高さを合わせられるが、
    // 閉じた状態(hidden)で作られた章はscrollHeightが測れないため、開いた瞬間
    // (下のpointerupハンドラ)にも改めて高さを合わせ直す必要がある。
    if (open) requestAnimationFrame(chapterAutoResize);

    // 長押しで大項目(章)のタイトルを編集できるようにする。一度入れたら直せない、
    // という不便さの解消。短いタップは今まで通り開閉。
    // 左スワイプでの削除は、ノート本体のタイトル行(attachRowGestures)と同じ
    // ロジック(SWIPE_REVEAL_PX/SWIPE_DELETE_PX、途中まで引くとゴミ箱が覗き、
    // そこを超えて離すと即削除、すでに覗いてる状態でのタップでも削除確定)。
    let chapterLongPressTimer = null;
    let chapterLongPressTriggered = false;
    let chDragging = false, chSwiping = false, chStartX = 0, chStartY = 0, chCurrentX = 0, chRestingX = 0;

    function setChapterTranslate(x, animated) {
      head.classList.toggle('swiping', !animated);
      head.style.transform = x ? `translateX(${x}px)` : '';
    }
    function cancelChapterLongPress() { clearTimeout(chapterLongPressTimer); }
    async function deleteChapter() {
      setChapterTranslate(-400, true);
      const idx = note.chapters.indexOf(chapter);
      if (idx !== -1) note.chapters.splice(idx, 1);
      note.updatedAt = Date.now();
      await putNote(note);
      showToast('大項目を削除しました');
      setTimeout(renderLibrary, 160);
    }

    head.addEventListener('pointerdown', (event) => {
      if (event.button !== undefined && event.button !== 0) return;
      chStartX = event.clientX; chStartY = event.clientY;
      chCurrentX = chRestingX;
      chDragging = false; chSwiping = false;
      chapterLongPressTriggered = false;
      cancelChapterLongPress();
      chapterLongPressTimer = setTimeout(() => {
        if (chDragging) return;
        chapterLongPressTriggered = true;
        if (navigator.vibrate) navigator.vibrate(12);
        const newTitle = prompt('大項目のタイトルを編集', chapter.title);
        if (newTitle !== null && newTitle.trim()) {
          chapter.title = newTitle.trim();
          scheduleInlineSave(note);
          head.querySelector('.chapter-t').textContent = chapter.title;
        }
      }, 500);
    });
    head.addEventListener('pointermove', (event) => {
      const dx = event.clientX - chStartX;
      const dy = event.clientY - chStartY;
      if (!chDragging) {
        if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
        if (Math.abs(dy) > Math.abs(dx)) return; // 縦スクロール優先
        chDragging = true;
        chSwiping = true;
        cancelChapterLongPress();
        head.setPointerCapture?.(event.pointerId);
      }
      if (!chSwiping) return;
      event.preventDefault();
      const raw = chRestingX + dx;
      chCurrentX = Math.max(Math.min(raw, 0), -SWIPE_DELETE_PX - 40);
      setChapterTranslate(chCurrentX, false);
    });
    head.addEventListener('pointerup', (event) => {
      event.stopPropagation();
      cancelChapterLongPress();
      if (chSwiping) {
        head.releasePointerCapture?.(event.pointerId);
        if (chCurrentX <= -SWIPE_DELETE_PX) {
          deleteChapter();
        } else {
          chRestingX = chCurrentX <= -SWIPE_REVEAL_PX / 2 ? -SWIPE_REVEAL_PX : 0;
          setChapterTranslate(chRestingX, true);
        }
        chSwiping = false; chDragging = false;
        return;
      }
      chDragging = false;
      if (chapterLongPressTriggered) return;
      if (chRestingX !== 0) {
        deleteChapter();
        return;
      }
      open = !open;
      state.chapterOpen[key] = open;
      body.hidden = !open;
      head.querySelector('.chapter-caret').classList.toggle('open', open);
      if (open) requestAnimationFrame(chapterAutoResize);
    });
    head.addEventListener('pointerleave', () => cancelChapterLongPress());
    head.addEventListener('pointercancel', () => {
      cancelChapterLongPress();
      chDragging = false; chSwiping = false;
      setChapterTranslate(chRestingX, true);
    });
    chapterSwipeBg.addEventListener('pointerup', () => {
      if (chRestingX !== 0) deleteChapter();
    });
    head.addEventListener('click', (event) => event.stopPropagation());
    row.append(chapterSwipeWrap, body);

    chapterList.append(row);
  });

  const addChapterBtn = document.createElement('button');
  addChapterBtn.type = 'button';
  addChapterBtn.className = 'add-chapter-btn';
  addChapterBtn.textContent = '＋ 大項目を追加';
  addChapterBtn.addEventListener('click', (event) => {
    event.stopPropagation();
    const title = prompt('大項目(章)のタイトル');
    if (!title) return;
    note.chapters.push({ id: `ch-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`, title, content: '' });
    scheduleInlineSave(note);
    renderLibrary();
  });
  chapterList.append(addChapterBtn);

  inner.append(chapterList);
}

function updateEditorButtons(note) {
  els.pinButton.classList.toggle('active', note.pinned);
  els.favoriteButton.classList.toggle('active', note.favorite);
  els.favoriteButton.textContent = note.favorite ? '★' : '☆';
}

// 画像を長押しすると全画面で拡大表示する(どの一覧の画像でも共通)。
let imageLightboxEl = null;
function showImageLightbox(src, alt) {
  if (!imageLightboxEl) {
    imageLightboxEl = document.createElement('div');
    imageLightboxEl.className = 'image-lightbox';
    imageLightboxEl.hidden = true;
    const img = document.createElement('img');
    imageLightboxEl.append(img);
    imageLightboxEl.addEventListener('click', () => { imageLightboxEl.hidden = true; });
    document.body.append(imageLightboxEl);
  }
  imageLightboxEl.querySelector('img').src = src;
  imageLightboxEl.querySelector('img').alt = alt || '';
  imageLightboxEl.hidden = false;
}
function wireImageLongPressZoom(img) {
  let timer = null;
  const start = (event) => {
    event.stopPropagation();
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (navigator.vibrate) navigator.vibrate(12);
      showImageLightbox(img.src, img.alt);
    }, 500);
  };
  const cancel = () => clearTimeout(timer);
  img.addEventListener('pointerdown', start);
  img.addEventListener('pointerup', cancel);
  img.addEventListener('pointerleave', cancel);
  img.addEventListener('pointercancel', cancel);
  // 長押しでブラウザ標準の「画像を保存」メニューが割り込まないようにする。
  img.addEventListener('contextmenu', (event) => event.preventDefault());
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
    wireImageLongPressZoom(img);
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

async function handleAddButtonClick() {
  if (state.activeType === 'movie') {
    await openEditor(null, { noteType: 'movie', content: MOVIE_TEMPLATE });
    return;
  }
  if (state.activeType === 'book') {
    await createBookNoteInline();
    return;
  }
  await openEditor(null, { noteType: 'knowledge' });
}

// 「本」は概要・章立てを一覧上のインライン展開で入力する運用のため、
// 他タイプと違って既存の全画面エディタ(openEditor)は経由しない。
async function createBookNoteInline() {
  if (!(await canCreateNewNote())) {
    showUpgradePrompt();
    return;
  }
  const title = prompt('本のタイトル');
  if (!title) return;
  const note = createNote({ title, noteType: 'book' });
  state.notes.push(note);
  await putNote(note);
  state.bookLevel[note.id] = 1;
  state.query = '';
  els.searchInput.value = '';
  state.selectedTags.clear();
  renderLibrary();
  showToast('保存しました');
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
  showView('editor');
  requestAnimationFrame(() => {
    growAndScroll(els.contentInput);
    (note.title ? els.contentInput : els.titleInput).focus();
  });
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
  const editingType = normalizeNoteType(currentNote()?.noteType);
  const registryNames = (state.tagRegistries[editingType] || []).map((t) => t.name);
  // タグ作成ダイアログを経由せず、自由入力の時代に付けられたタグも候補に出す。
  // (登録済みタグ一覧だけだと、編集中のメモに元々ついていないタグは出てこなかった)
  // ノートの種類をまたいでタグ候補が出ないよう、同じ種類のメモだけから集める。
  const usedNames = state.notes
    .filter((note) => normalizeNoteType(note.noteType) === editingType)
    .flatMap((note) => note.tags || []);
  const seen = new Set(registryNames.map((name) => name.toLocaleLowerCase()));
  const extra = [];
  // 登録済み・既存メモ使用済みのタグで並び順を固定する。
  // (以前はeditingTagsを先頭で展開していたため、選択/解除するたびに
  // 表示順が入れ替わり分かりにくかった)
  for (const tag of usedNames) {
    const key = tag.toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    extra.push(tag);
  }
  // 登録済みにも既存メモにもまだ無い、今回新規作成したばかりのタグだけ末尾に追加。
  for (const tag of state.editingTags) {
    const key = tag.toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    extra.push(tag);
  }
  const allNames = [...registryNames, ...extra];
  const colorMap = resolveTagColorMap(allNames, editingType);

  els.tagsPicker.replaceChildren();
  for (const name of allNames) {
    const active = [...state.editingTags].some((tag) => tag.toLocaleLowerCase() === name.toLocaleLowerCase());
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = `tag-chip${active ? ' active' : ''}`;
    chip.style.setProperty('--tag-color', colorMap[name]);
    chip.append(tagChipCheck(), document.createTextNode(name));
    // 長押しでタグそのものを削除(登録解除+全メモから除去)できるようにする。
    // 短いタップは今まで通り選択/解除。
    let longPressTimer = null, longPressTriggered = false;
    chip.addEventListener('pointerdown', () => {
      longPressTriggered = false;
      clearTimeout(longPressTimer);
      longPressTimer = setTimeout(async () => {
        longPressTriggered = true;
        if (navigator.vibrate) navigator.vibrate(12);
        if (confirm(`「${name}」タグを削除しますか？(全てのメモから外れます)`)) {
          await deleteTagFromRegistry(name, editingType);
          renderTagsPicker();
        }
      }, 500);
    });
    chip.addEventListener('pointerup', () => clearTimeout(longPressTimer));
    chip.addEventListener('pointerleave', () => clearTimeout(longPressTimer));
    chip.addEventListener('click', () => {
      if (longPressTriggered) { longPressTriggered = false; return; }
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
  function selectSwatch(selected) {
    swatchButtons.forEach((b) => b.classList.remove('selected'));
    customPicker.classList.remove('selected');
    selected.classList.add('selected');
  }
  const swatchButtons = TAG_COLOR_SWATCHES.map((color) => {
    const sw = document.createElement('button');
    sw.type = 'button';
    sw.className = `swatch${color === chosenColor ? ' selected' : ''}`;
    sw.style.setProperty('--sw', color);
    sw.addEventListener('click', () => {
      chosenColor = color;
      selectSwatch(sw);
    });
    swatchRow.append(sw);
    return sw;
  });
  // プリセットのスウォッチだけでなく、好きな色を自由に選べるようにネイティブの
  // カラーピッカーも1つ置く(選ぶとその色が選択状態になる)。
  const customPicker = document.createElement('input');
  customPicker.type = 'color';
  customPicker.className = 'swatch swatch-custom';
  customPicker.value = chosenColor;
  customPicker.title = '好きな色を選ぶ';
  customPicker.addEventListener('input', () => {
    chosenColor = customPicker.value;
    selectSwatch(customPicker);
  });
  swatchRow.append(customPicker);

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
    await upsertTagInRegistry(name, chosenColor, normalizeNoteType(currentNote()?.noteType));
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
  if (els.trashEmptyAllButton) els.trashEmptyAllButton.disabled = notes.length === 0;
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

async function emptyTrash() {
  const notes = state.notes.filter((note) => note.deletedAt != null);
  if (!notes.length) return;
  if (!confirm(`ゴミ箱の${notes.length}件をすべて完全に削除しますか？この操作は取り消せません。`)) return;
  for (const note of notes) {
    await deleteNotePermanently(note.id);
  }
  const deletedIds = new Set(notes.map((note) => note.id));
  state.notes = state.notes.filter((note) => !deletedIds.has(note.id));
  renderTrash();
  renderLibrary();
  showToast('ゴミ箱を空にしました');
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

// Androidのネイティブアプリ(Capacitor)では、<a download>によるBlob
// ダウンロードもnavigator.share()も、生のWebViewにはダウンロード/共有への
// ブリッジが無いため黙って何も起きない。ネイティブ側ではFilesystem(書き込み)
// +Share(共有シート)のCapacitorプラグインを使う確実な経路にする。
// ブラウザ/PWA(GitHub Pages版)では従来通り<a download>で動くので維持する。
function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label}が${ms / 1000}秒たっても応答しませんでした`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function downloadJson(data) {
  const date = new Date().toISOString().slice(0, 10);
  const filename = `knowledge-backup-${date}.json`;
  const text = JSON.stringify(data, null, 2);

  const BackupExport = window.Capacitor?.Plugins?.BackupExport;
  const isNative = Boolean(window.Capacitor?.isNativePlatform?.());
  console.log(`[export] isNative=${isNative} BackupExportFound=${Boolean(BackupExport)} bytes=${text.length}`);

  if (isNative && BackupExport) {
    // ネイティブ側が call.resolve/rejectを一度も呼ばずに固まるケースがあると
    // ここが永久に無反応になる(「反応しない」不具合の有力な原因の一つ)ため、
    // 一定時間で必ずエラーとして扱う。
    await withTimeout(
      BackupExport.saveToDownloads({ filename, content: text }),
      15000,
      '書き出し処理',
    );
    return;
  }

  // ネイティブアプリなのにBackupExportプラグインが見つからない場合は、
  // Blobダウンロードが効かないことが分かっているので、ここで明示的に失敗させる
  // (「反応しない」ではなく、エラーとして見える化する)。
  if (isNative) {
    throw new Error('BackupExportプラグインが見つかりません(アプリの再インストールが必要かもしれません)');
  }

  const blob = new Blob([text], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
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

  if (signedIn && user.photoURL) {
    // 読み込みに失敗したら(googleusercontent.comへのアクセスが一時的に
    // 塞がれている場合など)、壊れた画像アイコンのまま残さずシルエットに戻す。
    els.accountAvatarImg.onerror = () => {
      els.accountAvatarImg.hidden = true;
      els.accountAvatarPlaceholder.hidden = false;
    };
    els.accountAvatarImg.src = user.photoURL;
    els.accountAvatarImg.hidden = false;
    els.accountAvatarPlaceholder.hidden = true;
  } else {
    els.accountAvatarImg.hidden = true;
    els.accountAvatarImg.removeAttribute('src');
    els.accountAvatarPlaceholder.hidden = false;
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
  // 書き出し同様、設定画面は<dialog>(ブラウザの最前面レイヤー)の中にあるため、
  // トーストは裏に隠れて見えない。結果は必ずalert(これは<dialog>より前面に出る)で示す。
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
    alert(`読み込みました(${state.notes.filter((n) => n.deletedAt == null).length}件)`);
  } catch (error) {
    console.error('[import] failed', error);
    alert(`読み込みに失敗しました:\n${error?.message || error}`);
  } finally {
    els.importInput.value = '';
  }
}

// ソフトキーボード表示中、フォーカスした直後の要素がキーボードに隠れないように
// 画面をスクロールする(タップした瞬間・キーボードの開閉時のみ使う簡易版)。
function keepFocusedFieldVisible() {
  const el = document.activeElement;
  if (!el || typeof el.matches !== 'function' || !el.matches('input, textarea')) {
    clearKeyboardScrollRoom();
    return;
  }
  const vv = window.visualViewport;
  // 中身が短いノート(本を作った直後など、章がまだ1つしかない時など)は、
  // ページ自体にスクロールできる余白が無く、下のwindow.scrollByが何も
  // 動かせない。キーボードで隠れた分だけ常に余白を作っておくことで、
  // ノートの長さに関係なく入力欄をキーボードの上までスクロールできるようにする。
  ensureKeyboardScrollRoom(vv);
  const viewTop = vv ? vv.offsetTop : 0;
  const viewBottom = vv ? vv.offsetTop + vv.height : window.innerHeight;
  const margin = 16;
  const rect = el.getBoundingClientRect();
  if (rect.bottom > viewBottom - margin) {
    window.scrollBy(0, rect.bottom - (viewBottom - margin));
  } else if (rect.top < viewTop + margin) {
    window.scrollBy(0, rect.top - (viewTop + margin));
  }
}
function ensureKeyboardScrollRoom(vv) {
  const kbHeight = vv ? Math.max(0, window.innerHeight - vv.height) : 0;
  document.body.style.paddingBottom = kbHeight ? `${kbHeight}px` : '';
}
function clearKeyboardScrollRoom() {
  document.body.style.paddingBottom = '';
}

// 自動で高さが伸びるtextareaで、入力のたびに「今回どれだけ背が伸びたか」を
// そのまま画面のスクロール量として使う。手動の改行(Enter)はもちろん、文字数が
// 増えて自動的に次の行へ折り返された場合も、どちらもtextareaの高さがその分
// 伸びるので同じ仕組みでまとめて対応できる。キャレットの正確な位置を計算する
// 必要がなく、今見えている行がそのまま同じ相対位置で見え続ける(伸びた分だけ
// ページを一緒に押し下げるイメージ)。
function growAndScroll(textarea) {
  const prevHeight = textarea.offsetHeight;
  textarea.style.height = 'auto';
  const newHeight = textarea.scrollHeight;
  textarea.style.height = `${newHeight}px`;
  if (document.activeElement === textarea) {
    const grown = newHeight - prevHeight;
    if (grown > 0) window.scrollBy(0, grown);
  }
}

// アプリ全体のinput/textareaに効くよう、個別の要素ごとではなくfocusin委譲+
// visualViewportの変化で一括対応する。キーボードが開くアニメーションの途中・
// 完了後の両方で正しい位置に合わせるため、少し間を空けて2回呼ぶ。
function wireKeyboardAvoidance() {
  document.addEventListener('focusin', (event) => {
    if (typeof event.target.matches !== 'function' || !event.target.matches('input, textarea')) return;
    setTimeout(keepFocusedFieldVisible, 50);
    setTimeout(keepFocusedFieldVisible, 350);
  });
  document.addEventListener('focusout', (event) => {
    if (typeof event.target.matches !== 'function' || !event.target.matches('input, textarea')) return;
    // フォーカスが別の入力欄に移っただけなら、そちらのfocusinがまた余白を
    // 作り直すのでそのままでいい。本当に編集が終わった時だけ余白を消す。
    setTimeout(() => {
      const active = document.activeElement;
      if (!active || typeof active.matches !== 'function' || !active.matches('input, textarea')) clearKeyboardScrollRoom();
    }, 50);
  });
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', keepFocusedFieldVisible);
    window.visualViewport.addEventListener('scroll', keepFocusedFieldVisible);
  }
}
function wireEvents() {
  wireKeyboardAvoidance();
  els.searchInput.addEventListener('input', () => {
    state.query = els.searchInput.value;
    renderLibrary();
  });
  els.sortSelect.addEventListener('change', () => {
    state.sort = els.sortSelect.value;
    renderLibrary();
  });
  els.addButton.addEventListener('click', handleAddButtonClick);
  if (els.bottomTabbar) {
    for (const btn of els.bottomTabbar.querySelectorAll('button')) {
      btn.addEventListener('click', () => {
        const type = normalizeNoteType(btn.dataset.noteType);
        if (state.activeType === type) return;
        state.activeType = type;
        state.query = '';
        els.searchInput.value = '';
        state.selectedTags.clear();
        renderLibrary();
      });
    }
  }
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
  els.trashEmptyAllButton?.addEventListener('click', emptyTrash);
  els.backButton.addEventListener('click', closeEditor);
  els.homeButton.addEventListener('click', goHome);
  els.appTitleInput.addEventListener('input', scheduleAppTitleSave);
  els.appTitleInput.addEventListener('blur', saveAppTitle);

  for (const input of [els.titleInput, els.contentInput]) input.addEventListener('input', scheduleAutosave);
  els.contentInput.addEventListener('input', () => growAndScroll(els.contentInput));

  els.favoriteButton.addEventListener('click', () => toggleFlag('favorite'));
  els.pinButton.addEventListener('click', () => toggleFlag('pinned'));
  els.deleteButton.addEventListener('click', moveActiveToTrash);

  els.attachmentInput.addEventListener('change', async () => {
    await addAttachments([...els.attachmentInput.files]);
    els.attachmentInput.value = '';
  });

  els.accountButton.addEventListener('click', () => {
    if (typeof els.settingsDialog.showModal === 'function') els.settingsDialog.showModal();
    else els.settingsDialog.setAttribute('open', '');
  });
  els.themeSelect.addEventListener('change', async () => {
    applyTheme(els.themeSelect.value);
    await setSetting('theme', els.themeSelect.value);
  });
  els.exportButton.addEventListener('click', async () => {
    // 「書き出す」が無反応に見える不具合の調査用。exportData()自体が失敗した場合や、
    // 添付画像が多くバックアップが巨大になった場合も、必ず何かしらの表示が出るようにする。
    // 結果はトースト(設定画面は<dialog>でブラウザの最前面レイヤーに乗るため、
    // 普通の要素であるトーストは開いている間ずっと裏に隠れて見えない)ではなく、
    // ダイアログ自身の中にあるボタンのラベルで示す。
    els.exportButton.disabled = true;
    const originalLabel = els.exportButton.textContent;
    els.exportButton.textContent = '書き出し中…';
    try {
      const data = await exportData();
      const sizeMb = JSON.stringify(data).length / (1024 * 1024);
      console.log(`[export] notes=${data.notes.length} size=${sizeMb.toFixed(2)}MB`);
      await downloadJson(data);
      els.exportButton.textContent = `✓ 保存しました(${data.notes.length}件)`;
      await new Promise((resolve) => setTimeout(resolve, 1800));
    } catch (error) {
      console.error('[export] failed', error);
      alert(`書き出しに失敗しました:\n${error?.message || error}`);
    } finally {
      els.exportButton.disabled = false;
      els.exportButton.textContent = originalLabel;
    }
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
      // トースト(1.8秒で消える)だとスクショが間に合わないため、手動で閉じるまで消えないalertで表示する。
      const detail = error?.code || error?.message || String(error);
      alert(`ログインできませんでした:\n${detail}`);
    }
  });
  els.signOutButton.addEventListener('click', async () => {
    await signOutCloud();
    showToast('ログアウトしました');
  });

  els.selectionCancelButton.addEventListener('click', exitSelectionMode);
  els.selectionDeleteButton.addEventListener('click', bulkDeleteSelected);
  els.selectionTagButton.addEventListener('click', openBulkTagDialog);
  els.bulkTagCloseButton.addEventListener('click', closeBulkTagDialog);
  els.bulkTagApplyButton.addEventListener('click', applyBulkTags);
  els.bulkTagDialog.addEventListener('click', (event) => {
    if (event.target === els.bulkTagDialog) closeBulkTagDialog();
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

  state.tagRegistries.knowledge = await getSetting('tagRegistry', []);
  state.tagRegistries.book = await getSetting('tagRegistry:book', []);
  const storedMovieTags = await getSetting('tagRegistry:movie', null);
  if (storedMovieTags === null) {
    // 映画タブを初めて使う時だけ、オーソドックスなジャンルを登録済みタグとして
    // 用意しておく。一度保存したら、あとはユーザーが自由に追加・削除できる。
    const seeded = DEFAULT_MOVIE_TAGS.map((name, i) => ({ name, color: TAG_COLOR_SWATCHES[i % TAG_COLOR_SWATCHES.length] }));
    await setSetting('tagRegistry:movie', seeded);
    state.tagRegistries.movie = seeded;
  } else {
    state.tagRegistries.movie = storedMovieTags;
  }

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
