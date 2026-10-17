export const SERIES_ID = 'teachers-training';
export const SERIES_TITLE = "Teacher's Training";

const TITLE_EXTENSION = /\.(mp3|mp4|m4a|wav|webm|ogg|flac|aac|mpeg|mpg|mov|mkv|avi|wmv|html)$/i;

export function sessionTitle(name) {
  const trimmed = String(name || '').trim();
  const slash = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  const base = (slash >= 0 ? trimmed.slice(slash + 1) : trimmed) || 'Session';
  return base.replace(TITLE_EXTENSION, '') || 'Session';
}

export function sessionOrder(name) {
  const labeled = sessionTitle(name).match(/session\s*(\d+)/i);
  if (!labeled) return null;
  return Number(labeled[1]);
}

export function paragraphRecord(paragraph) {
  const record = {
    speaker: paragraph && paragraph.speaker != null ? String(paragraph.speaker) : '',
    text: paragraph && paragraph.text != null ? String(paragraph.text) : '',
  };
  const start = Number(paragraph?.start);
  const end = Number(paragraph?.end);
  if (Number.isFinite(start) && start >= 0) record.start = start;
  if (Number.isFinite(end) && end >= 0) record.end = end;
  return record;
}

export function paragraphsHaveTimes(paragraphs) {
  return Array.isArray(paragraphs) && paragraphs.some((paragraph) => Number.isFinite(Number(paragraph?.start)));
}

export function paragraphsForCatalog(visible, timed) {
  const shown = Array.isArray(visible) ? visible.map(paragraphRecord) : [];
  const source = Array.isArray(timed) ? timed.map(paragraphRecord) : [];
  if (!shown.length) return source;
  if (paragraphsHaveTimes(shown)) return shown;
  if (shown.length === source.length) {
    return shown.map((paragraph, index) => {
      const next = { ...paragraph };
      if (source[index].start != null) next.start = source[index].start;
      if (source[index].end != null) next.end = source[index].end;
      return next;
    });
  }
  return source.length ? source : shown;
}

function sessionRecord(session) {
  if (!session || typeof session !== 'object') return null;
  const id = typeof session.id === 'string' ? session.id : '';
  const driveFileId = typeof session.driveFileId === 'string' ? session.driveFileId : '';
  if (!id || !driveFileId) return null;
  const order = Number(session.order);
  return {
    id,
    title: sessionTitle(session.title || 'Session'),
    order: Number.isFinite(order) ? order : 0,
    driveFileId,
    mimeType: typeof session.mimeType === 'string' ? session.mimeType : '',
    paragraphs: Array.isArray(session.paragraphs) ? session.paragraphs.map(paragraphRecord) : [],
  };
}

export function normalizeCatalog(catalog) {
  const rawSeries = catalog && typeof catalog === 'object' && catalog.series && typeof catalog.series === 'object'
    ? catalog.series
    : {};
  const stored = rawSeries[SERIES_ID] && typeof rawSeries[SERIES_ID] === 'object' ? rawSeries[SERIES_ID] : {};
  const sessions = (Array.isArray(stored.sessions) ? stored.sessions : [])
    .map(sessionRecord)
    .filter(Boolean)
    .sort((a, b) => a.order - b.order || a.title.localeCompare(b.title));
  return {
    series: {
      [SERIES_ID]: {
        id: SERIES_ID,
        title: SERIES_TITLE,
        sessions,
      },
    },
  };
}

export function upsertPublishedSession(catalog, session) {
  const next = normalizeCatalog(catalog);
  const sessions = next.series[SERIES_ID].sessions.filter((item) => item.id !== session.id);
  let order = Number(session.order);
  if (!Number.isFinite(order)) {
    order = sessions.reduce((max, item) => Math.max(max, item.order), 0) + 1;
  }
  const record = sessionRecord({ ...session, order });
  if (record) sessions.push(record);
  sessions.sort((a, b) => a.order - b.order || a.title.localeCompare(b.title));
  next.series[SERIES_ID].sessions = sessions;
  return next;
}

export function publicCatalog(catalog) {
  const series = normalizeCatalog(catalog).series[SERIES_ID];
  return {
    series: [{
      id: series.id,
      title: series.title,
      sessions: series.sessions.map((session) => ({
        id: session.id,
        title: session.title,
        order: session.order,
      })),
    }],
  };
}

export function findPublishedSession(catalog, sessionId) {
  return normalizeCatalog(catalog).series[SERIES_ID].sessions.find((session) => session.id === sessionId) || null;
}

export function publicMediaUrl(fileId) {
  return `https://drive.google.com/uc?export=download&id=${encodeURIComponent(fileId)}`;
}

export function paragraphIndexAt(paragraphs, time) {
  const items = paragraphs || [];
  const seconds = Number(time);
  if (!Number.isFinite(seconds)) return -1;
  let found = -1;
  for (let i = 0; i < items.length; i += 1) {
    const start = Number(items[i]?.start);
    if (!Number.isFinite(start)) continue;
    const end = Number(items[i]?.end);
    const until = Number.isFinite(end) ? end : start;
    const inside = seconds + 0.001 >= start && seconds < until;
    const point = until === start && seconds + 0.001 >= start && seconds < start + 0.25;
    if (inside || point) found = i;
  }
  if (found === -1) {
    for (let i = 0; i < items.length; i += 1) {
      const start = Number(items[i]?.start);
      if (Number.isFinite(start) && start <= seconds + 0.001) found = i;
    }
  }
  return found;
}
