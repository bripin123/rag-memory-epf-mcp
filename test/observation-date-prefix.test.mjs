// A date prefix on an observation is the label a human reads as "when did we learn this".
// Three things were wrong with how it was produced (measured on a live 468-entity database):
//
//   29 active observations carry a day EARLIER than the local day they were written, because
//      the stamp came from `new Date().toISOString().slice(0, 10)` = UTC. At UTC+9 that is wrong
//      for every write between 00:00 and 08:59:59 local — which is exactly when this project's
//      sessions run.
//   82 active observations carry TWO different dates, because the skip test demanded a closing
//      bracket immediately after the date, so "[2026-08-11 session16] ..." looked un-prefixed.
//    2 of those 82 are the overlap between the two groups; the sets are otherwise disjoint.
//
// Widening the skip regex alone would have been worse than the bug: `stripDate` is defined
// separately for the dedup path, so stamping would accept an annotated prefix that dedup could
// not strip, and the same fact written in two sessions would be stored twice. Stamp and dedup
// therefore share one parser.
//
// TZ handling is an explicit project calendar timezone, not the ambient process TZ: the same DB
// is reachable from a laptop, CI and another country, and ambient TZ makes the stored label mean
// different things in each. Default stays UTC so the product does not inherit one user's setup.
process.env.RAG_MEMORY_CALENDAR_TZ = 'Asia/Seoul';

import { makeManager, assert } from './helpers/engine-test-db.mjs';

const dp = await import('../dist/src/observations/date-prefix.js');

// --- 1. calendarDate: one instant, several zones. -----------------------------------------
const instant = new Date('2026-08-10T21:28:00Z'); // 06:28 on the 11th in Seoul
for (const [tz, expected] of [
  ['UTC', '2026-08-10'],
  ['Asia/Seoul', '2026-08-11'],
  ['Europe/Paris', '2026-08-10'],
  ['America/Los_Angeles', '2026-08-10'],
]) {
  assert(dp.calendarDate(instant, tz) === expected, `${tz} -> ${expected}`);
}
assert(dp.calendarDate(new Date('2026-01-05T15:30:00Z'), 'Asia/Seoul') === '2026-01-06',
  'single-digit month and day stay zero-padded');

// --- 2. resolveCalendarTimeZone: default UTC, fail fast on nonsense. -----------------------
assert(dp.resolveCalendarTimeZone(undefined) === 'UTC', 'unset -> UTC (product default)');
assert(dp.resolveCalendarTimeZone('  ') === 'UTC', 'blank -> UTC');
assert(dp.resolveCalendarTimeZone('Asia/Seoul') === 'Asia/Seoul', 'valid zone passes through');
let threw = null;
try { dp.resolveCalendarTimeZone('Mars/Olympus'); } catch (e) { threw = e; }
assert(threw !== null && /RAG_MEMORY_CALENDAR_TZ/.test(threw.message),
  'invalid zone throws, naming the variable');

// --- 3. parseDatePrefix: what counts as a date prefix. -------------------------------------
const accepted = [
  ['[2026-08-11] fact', '2026-08-11', null],
  ['[2026-08-11 session16] fact', '2026-08-11', 'session16'],
  ['[2026-08-11 세션16] fact', '2026-08-11', '세션16'],
];
for (const [input, date, annotation] of accepted) {
  const got = dp.parseDatePrefix(input);
  assert(got && got.date === date && got.annotation === annotation,
    `accepted: ${JSON.stringify(input)} -> ${date}/${annotation}`);
}
// Rejected. Each of these used to be mis-handled by one regex or the other.
const rejected = [
  '[2026-13-99 session] invalid month and day',
  '[2026-02-30] a day that does not exist',
  '[2026-08-111] extra digit',
  '[2026-08-11oops] no boundary after the date',
  '[2026-08-11 unclosed annotation',
  '[2026-08-11\ncontinued] newline inside the bracket',
  'no prefix at all',
];
for (const input of rejected) {
  assert(dp.parseDatePrefix(input) === null, `rejected: ${JSON.stringify(input.slice(0, 32))}`);
}

// --- 4. stripDatePrefix: the dedup key. ----------------------------------------------------
// The annotation is recording metadata, not part of the fact, so it comes off with the date.
// Two sessions writing the same sentence must collapse to one observation.
assert(dp.stripDatePrefix('[2026-08-11] same fact') === 'same fact', 'bare date stripped');
assert(dp.stripDatePrefix('[2026-08-11 session16] same fact') === 'same fact',
  'date + annotation stripped');
assert(dp.stripDatePrefix('[2026-08-111] not a prefix') === '[2026-08-111] not a prefix',
  'malformed prefix is left alone (it is part of the text)');

// --- 5. Round trip through the real writers. -----------------------------------------------
const { manager, cleanup } = await makeManager();
try {
  assert(manager.calendarTimeZone === 'Asia/Seoul', 'manager picked up the configured zone');
  const today = dp.calendarDate(new Date(), 'Asia/Seoul');

  await manager.createEntities([
    { name: 'PrefixProbe', entityType: 'CONCEPT', observations: ['from createEntities'] },
  ]);
  await manager.addObservations([{
    entityName: 'PrefixProbe',
    contents: [
      'from addObservations',
      '[2026-08-11 session16] caller supplied its own date',
    ],
  }]);

  const graph = await manager.openNodes(['PrefixProbe']);
  const probe = graph.entities[0];
  const obs = probe.observations;

  assert(obs.includes(`[${today}] from createEntities`), 'createEntities stamps the local day');
  assert(obs.includes(`[${today}] from addObservations`), 'addObservations stamps the local day');
  assert(obs.includes('[2026-08-11 session16] caller supplied its own date'),
    'an annotated caller date is left verbatim — no second stamp');
  assert(!obs.some((o) => /^\[\d{4}-\d{2}-\d{2}[^\]]*\] \[\d{4}-\d{2}-\d{2}/.test(o)),
    'no observation carries two date prefixes');

  // Dedup must see through the annotation: same sentence, different session marker.
  const before = (await manager.openNodes(['PrefixProbe'])).entities[0].observations.length;
  const res = await manager.addObservations([{
    entityName: 'PrefixProbe',
    contents: ['[2026-08-12 session17] caller supplied its own date'],
  }]);
  const after = (await manager.openNodes(['PrefixProbe'])).entities[0].observations.length;
  assert(after === before, `same fact under a different session marker is deduped (${before} -> ${after})`);
  assert(res[0].observation_ids[0] === null, 'dedup reports no new revision');

  // --- 6. Documents use the same calendar. -------------------------------------------------
  // Deliberate: metadata.updated is also a date-only label a person reads. Keeping it on UTC
  // while observations moved would leave two calendars in one database with nothing saying so.
  const { writeFileSync } = await import('fs');
  const { join } = await import('path');
  const { tmpdir } = await import('os');
  const docPath = join(tmpdir(), `date-prefix-doc-${process.pid}.txt`);
  writeFileSync(docPath, 'a document written near the rollover.', 'utf-8');
  await manager.syncDocumentFromFile(docPath, 'date-probe', {});
  const { documents } = await manager.listDocuments();
  const doc = documents.find((d) => d.id === 'date-probe');
  const updated = (typeof doc.metadata === 'string' ? JSON.parse(doc.metadata) : doc.metadata).updated;
  assert(updated === today, `metadata.updated uses the configured calendar [got ${updated}]`);
} finally {
  cleanup();
}
