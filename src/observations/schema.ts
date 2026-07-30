// v13 observation lifecycle schema (spec 2026-07-30 §4.1~4.3).
// 마이그레이션과 테스트가 이 상수를 공유한다 — 두 곳에 DDL 을 복제하면 갈라진다.
//
// SQLite 함정 3가지가 이 DDL 의 형태를 결정했다 (전부 실측):
//   1. INTEGER NOT NULL 은 타입 강제가 아니다      -> CHECK (typeof(x)='integer')
//   2. TEXT PRIMARY KEY 는 NULL 을 허용한다        -> NOT NULL 명시
//   3. BEFORE 트리거가 CHECK 보다 먼저 실행된다    -> 오류 문자열 순서가 정해진다
export const OBSERVATION_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS observation_roots (
  root_id          TEXT PRIMARY KEY NOT NULL,
  entity_id        TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  projection_order INTEGER NOT NULL
                   CHECK (typeof(projection_order) = 'integer' AND projection_order >= 0),
  created_at       DATETIME NOT NULL,
  UNIQUE (entity_id, projection_order)
);

CREATE TABLE IF NOT EXISTS entity_observations (
  observation_id   TEXT PRIMARY KEY NOT NULL,
  root_id          TEXT NOT NULL REFERENCES observation_roots(root_id) ON DELETE CASCADE,
  entity_id        TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  revision_no      INTEGER NOT NULL
                   CHECK (typeof(revision_no) = 'integer' AND revision_no >= 1),
  projection_order INTEGER NOT NULL
                   CHECK (typeof(projection_order) = 'integer' AND projection_order >= 0),
  content          TEXT NOT NULL,
  status           TEXT NOT NULL CHECK (status IN
                     ('active','superseded','retracted','provisional')),
  supersedes_id    TEXT REFERENCES entity_observations(observation_id),
  recorded_at      DATETIME NOT NULL,
  superseded_at    DATETIME,
  UNIQUE (root_id, revision_no)
);

CREATE TABLE IF NOT EXISTS observation_sources (
  observation_id TEXT NOT NULL REFERENCES entity_observations(observation_id) ON DELETE CASCADE,
  source_kind    TEXT NOT NULL CHECK (source_kind IN
                   ('document','conversation','decision','import')),
  source_ref     TEXT NOT NULL,
  source_hash    TEXT,
  recorded_at    DATETIME NOT NULL,
  PRIMARY KEY (observation_id, source_kind, source_ref)
);

CREATE TABLE IF NOT EXISTS observation_events (
  event_id     TEXT PRIMARY KEY NOT NULL,
  root_id      TEXT NOT NULL REFERENCES observation_roots(root_id) ON DELETE CASCADE,
  from_id      TEXT,
  to_id        TEXT,
  event        TEXT NOT NULL CHECK (event IN
                 ('add','correct','retract','restore','approve','decline','import')),
  change_kind  TEXT CHECK (change_kind IN ('correction','world_change','retraction')),
  reason       TEXT,
  actor        TEXT,
  batch_id     TEXT,
  recorded_at  DATETIME NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_obs_active_per_root
  ON entity_observations(root_id) WHERE status = 'active';

CREATE UNIQUE INDEX IF NOT EXISTS idx_obs_active_order
  ON entity_observations(entity_id, projection_order) WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_obs_entity ON entity_observations(entity_id);
CREATE INDEX IF NOT EXISTS idx_obs_root ON entity_observations(root_id);
CREATE INDEX IF NOT EXISTS idx_obs_events_root ON observation_events(root_id);

CREATE TRIGGER IF NOT EXISTS trg_roots_immutable
BEFORE UPDATE ON observation_roots
BEGIN
  SELECT RAISE(ABORT, 'observation_roots is immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_obs_content_immutable
BEFORE UPDATE OF content ON entity_observations
BEGIN
  SELECT RAISE(ABORT, 'observation content is immutable; create a new revision');
END;

CREATE TRIGGER IF NOT EXISTS trg_obs_identity_immutable
BEFORE UPDATE OF observation_id, root_id, entity_id, revision_no, supersedes_id,
                 projection_order, recorded_at
ON entity_observations
BEGIN
  SELECT RAISE(ABORT, 'identity/order fields are immutable after insert');
END;

CREATE TRIGGER IF NOT EXISTS trg_obs_matches_root
BEFORE INSERT ON entity_observations
BEGIN
  SELECT RAISE(ABORT, 'root_id must exist and (entity_id, projection_order) must match it')
  WHERE NOT EXISTS (
    SELECT 1 FROM observation_roots r
    WHERE r.root_id = NEW.root_id
      AND r.entity_id = NEW.entity_id
      AND r.projection_order = NEW.projection_order);
END;

CREATE TRIGGER IF NOT EXISTS trg_obs_chain_wellformed
BEFORE INSERT ON entity_observations
BEGIN
  SELECT RAISE(ABORT, 'revision_no must be >= 1') WHERE NEW.revision_no < 1;
  SELECT RAISE(ABORT, 'first revision must have NULL supersedes_id')
  WHERE NEW.revision_no = 1 AND NEW.supersedes_id IS NOT NULL;
  SELECT RAISE(ABORT, 'non-first revision must have a predecessor')
  WHERE NEW.revision_no > 1 AND NEW.supersedes_id IS NULL;
  SELECT RAISE(ABORT, 'supersedes must be the immediately preceding revision of the same root')
  WHERE NEW.supersedes_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM entity_observations p
    WHERE p.observation_id = NEW.supersedes_id
      AND p.root_id = NEW.root_id
      AND p.revision_no = NEW.revision_no - 1);
END;
`;
