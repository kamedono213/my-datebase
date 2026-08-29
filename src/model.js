const makeId = (now) => `note-${now}-${Math.random().toString(36).slice(2, 10)}`;

export function normalizeTags(tags = []) {
  const seen = new Set();
  const output = [];
  for (const raw of tags) {
    const tag = String(raw ?? '').trim();
    if (!tag) continue;
    const key = tag.toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(tag);
  }
  return output;
}

export function createNote(input = {}, now = Date.now()) {
  return {
    id: input.id || makeId(now),
    title: String(input.title ?? ''),
    content: String(input.content ?? ''),
    tags: normalizeTags(input.tags ?? []),
    favorite: Boolean(input.favorite),
    pinned: Boolean(input.pinned),
    createdAt: Number.isFinite(input.createdAt) ? input.createdAt : now,
    updatedAt: Number.isFinite(input.updatedAt) ? input.updatedAt : now,
    deletedAt: input.deletedAt == null ? null : Number(input.deletedAt),
    relatedIds: Array.isArray(input.relatedIds) ? [...new Set(input.relatedIds.map(String))] : [],
    attachments: Array.isArray(input.attachments) ? input.attachments.map((a) => ({ ...a })) : [],
  };
}

export function matchesSearch(note, query = '') {
  const q = String(query).trim().toLocaleLowerCase();
  if (!q) return true;
  const haystack = [note.title, note.content, ...(note.tags ?? [])]
    .join('\n')
    .toLocaleLowerCase();
  return q.split(/\s+/).every((token) => haystack.includes(token));
}

function compareBase(a, b, sort) {
  if (sort === 'created') return b.createdAt - a.createdAt;
  if (sort === 'title') return a.title.localeCompare(b.title, 'ja', { sensitivity: 'base' });
  if (sort === 'favorite') {
    const fav = Number(b.favorite) - Number(a.favorite);
    return fav || b.updatedAt - a.updatedAt;
  }
  return b.updatedAt - a.updatedAt;
}

export function filterAndSortNotes(notes, options = {}) {
  const {
    query = '',
    tags = [],
    sort = 'updated',
    includeDeleted = false,
    onlyDeleted = false,
  } = options;
  const normalizedFilterTags = normalizeTags(tags).map((tag) => tag.toLocaleLowerCase());

  return [...notes]
    .filter((note) => {
      const deleted = note.deletedAt != null;
      if (onlyDeleted && !deleted) return false;
      if (!onlyDeleted && !includeDeleted && deleted) return false;
      if (!matchesSearch(note, query)) return false;
      if (normalizedFilterTags.length) {
        const noteTags = (note.tags ?? []).map((tag) => String(tag).toLocaleLowerCase());
        if (!normalizedFilterTags.every((tag) => noteTags.includes(tag))) return false;
      }
      return true;
    })
    .sort((a, b) => {
      const pin = Number(b.pinned) - Number(a.pinned);
      if (pin) return pin;
      return compareBase(a, b, sort);
    });
}

export function validateBackup(data) {
  if (!data || typeof data !== 'object') return false;
  if (data.version !== 1 || !Array.isArray(data.notes) || !data.settings || typeof data.settings !== 'object') return false;
  return data.notes.every((note) => {
    if (!note || typeof note !== 'object') return false;
    if (typeof note.id !== 'string') return false;
    if (typeof note.title !== 'string' || typeof note.content !== 'string') return false;
    if (!Array.isArray(note.tags) || !Array.isArray(note.relatedIds) || !Array.isArray(note.attachments)) return false;
    if (!Number.isFinite(note.createdAt) || !Number.isFinite(note.updatedAt)) return false;
    if (!(note.deletedAt == null || Number.isFinite(note.deletedAt))) return false;
    return true;
  });
}
