// One place that decides what a leading "[date]" on an observation means.
//
// Why this is a module and not two regexes inline: the stamp path and the dedup path each had
// their own copy of the pattern, and they disagreed. Stamping asked "does this already start
// with a date?" while dedup asked "what is this text without its date?", so widening one without
// the other let the same sentence be stored twice under two session markers. Both now call in
// here.
//
// Why an explicit timezone instead of the process one: a date-only label has no meaning until
// you say which calendar produced it. The same database is reached from a laptop, from CI and
// from another country; deriving the day from the ambient TZ makes the stored string mean
// something different on each. The default stays UTC so the product does not inherit whichever
// zone its first author happened to sit in — a deployment that wants local days says so.

/** The calendar day of `instant` in `timeZone`, as YYYY-MM-DD. */
export function calendarDate(instant: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(instant);
  const part = (type: string): string => {
    const found = parts.find(p => p.type === type);
    if (!found) throw new Error(`calendarDate: missing ${type} for timeZone ${timeZone}`);
    return found.value;
  };
  return `${part('year')}-${part('month')}-${part('day')}`;
}

/**
 * Resolve RAG_MEMORY_CALENDAR_TZ. Unset or blank means UTC. An unrecognised zone throws at
 * boot rather than silently falling back — a wrong-but-quiet calendar writes wrong labels for
 * as long as nobody looks, which is the failure this whole module exists to end.
 */
export function resolveCalendarTimeZone(raw: string | undefined | null): string {
  const value = (raw ?? '').trim();
  if (!value) return 'UTC';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
  } catch {
    throw new Error(
      `RAG_MEMORY_CALENDAR_TZ is not a recognised IANA time zone: ${JSON.stringify(value)}. ` +
      `Use a name like "Asia/Seoul", or leave it unset for UTC.`,
    );
  }
  return value;
}

export interface DatePrefix {
  /** YYYY-MM-DD, already validated as a real calendar day. */
  date: string;
  /** Text between the date and the closing bracket, e.g. a session marker. */
  annotation: string | null;
  /** The matched prefix including the brackets, without trailing whitespace. */
  matched: string;
}

// The annotation may not contain a newline or a bracket: an unclosed or multi-line "[2026-…"
// is prose that happens to start with a digit, not a prefix. Requiring the closing bracket is
// what keeps "[2026-08-11 unclosed" and "[2026-08-111]" out.
const PREFIX_RE = /^\[(\d{4})-(\d{2})-(\d{2})(?:[ \t]([^\]\n]*))?\]/;

function isRealCalendarDay(year: number, month: number, day: number): boolean {
  const asUtc = new Date(Date.UTC(year, month - 1, day));
  return asUtc.getUTCFullYear() === year
    && asUtc.getUTCMonth() === month - 1
    && asUtc.getUTCDate() === day;
}

/** Parse a leading date prefix, or null when the text does not start with one. */
export function parseDatePrefix(content: string): DatePrefix | null {
  const m = PREFIX_RE.exec(content);
  if (!m) return null;
  const [matched, year, month, day, annotation] = m;
  if (!isRealCalendarDay(Number(year), Number(month), Number(day))) return null;
  const trimmed = annotation === undefined ? null : annotation.trim();
  return {
    date: `${year}-${month}-${day}`,
    annotation: trimmed === '' ? null : trimmed,
    matched,
  };
}

/**
 * The dedup key: the text with its date prefix removed. The annotation comes off with the date
 * because it records *when and in which session the line was written*, not what the line claims
 * — the same sentence written in two sessions is one fact, and dedup has to see that.
 */
export function stripDatePrefix(content: string): string {
  const prefix = parseDatePrefix(content);
  if (!prefix) return content;
  return content.slice(prefix.matched.length).replace(/^\s+/, '');
}

/** Prepend today's calendar day unless the text already carries a valid date prefix. */
export function stampDatePrefix(content: string, timeZone: string, now: Date = new Date()): string {
  if (parseDatePrefix(content)) return content;
  return `[${calendarDate(now, timeZone)}] ${content}`;
}
