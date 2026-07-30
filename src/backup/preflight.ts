import { existsSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';

// 이 파일이 지켜야 하는 것은 두 줄이다:
//   ① 복구점을 절대 덮어쓰지 않는다
//   ② 재시작을 막지 않는다
//
// 이걸 "남아 있는 .bak 이 live 와 같은 상태인가"를 증명해서 풀려고 세 판본을 썼고
// 세 번 다 틀렸다(스키마 버전을 신원으로 착각 → DB 내부 UUID+집계 지문 → 전체 논리
// 다이제스트). 마지막 판본조차 `sqlite_sequence`·hidden rowid·INTEGER 정밀도·
// INTEGER/REAL 구분이 새고, `VACUUM INTO` 는 명시적 INTEGER PRIMARY KEY 가 없는
// 테이블의 ROWID 를 바꿀 수 있어서 **비교의 전제 자체가 흔들린다**.
//
// 등가 증명은 애초에 필요하지 않았다. **백업은 마이그레이션 전에 만들어지므로,
// 시도마다 새 슬롯에 하나 더 만들면 그 모든 파일이 정의상 유효한 pre-migration
// 스냅샷이다.** 덮어쓰지 않으니 ①, 막지 않으니 ②. 비교가 없으니 비교의 정확성
// 문제가 전부 사라진다. (advisor beta r2~r6 6라운드의 결론)
//
// 대가 = 디스크. 그래서 슬롯을 유한하게 두고, 다 차면 fail-closed 한다 —
// 마이그레이션이 세 번 연속 실패하는 상태는 사람이 봐야 한다.
const MAX_RECOVERY_POINTS = 3;

// spec §5.1: 마이그레이션 전 SQLite-consistent snapshot.
// 파일 복사는 금지 — WAL 이 반영되지 않는다. `VACUUM INTO` 는 WAL 을 반영한 일관
// 스냅샷을 **동기로** 만든다(better-sqlite3 의 backup() 은 Promise 라 마이그레이션
// 흐름에 섞이면 순서를 잃는다).
//
// 실패는 전부 throw = fail-closed. 백업 없이 스키마를 바꾸지 않는다:
// 이 프로젝트군은 non-git 환경(Google Drive 폴더)에 배포되어 git 롤백이 없고,
// 이 파일이 유일한 복구선이다.
export function backupBeforeMigration(
  db: Database.Database,
  dbPath: string,
  pendingVersions: number[],
  currentVersion: number
): { path: string; sha256: string } | null {
  if (pendingVersions.length === 0) return null;          // 대기 없으면 no-op
  if (!dbPath || dbPath === ':memory:') return null;      // 메모리 DB 는 대상 아님

  // 백업 대상 판정 = "잃을 데이터가 있는가". 스키마 버전만으로 판정하면 migration
  // metadata 가 없는데 실제 데이터는 있는 DB(수동 복사본·부분 복구본)를 무백업으로
  // 통과시킨다. 그리고 **테이블 목록을 하드코딩하면 그 목록 밖의 데이터가 안 보인다**
  // — `embedding_profiles` 에만 행이 있는 version-0 DB 가 그렇게 통과했다
  // (advisor beta r6 발견 P0-3). 그래서 사용자 테이블 전체를 본다.
  if (currentVersion <= 0 && !hasAnyUserRows(db)) return null;

  const target = pickRecoverySlot(`${dbPath}.v${currentVersion}.bak`);
  db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);

  // quick_check + 복원 시험 (spec §5.1-2)
  const verify = new Database(target, { readonly: true });
  try {
    const ok = verify.pragma('quick_check', { simple: true });
    if (ok !== 'ok') throw new Error(`migration backup failed quick_check: ${ok}`);
    const n = verify.prepare(`SELECT COUNT(*) c FROM sqlite_master`).get() as { c: number };
    if (!n || n.c === 0) throw new Error('migration backup has empty schema');
  } finally {
    verify.close();
  }

  if (statSync(target).size === 0) throw new Error('migration backup is empty');
  const sha256 = streamSha256(target);
  console.error(`  ├─ 🛟 backup ${target} (sha256 ${sha256.slice(0, 12)}…)`);
  return { path: target, sha256 };
}

// 다음 빈 복구점 슬롯. 기존 파일은 읽지도, 검증하지도, 건드리지도 않는다 —
// 그것들이 무엇인지 판정하려는 시도가 앞선 세 판본의 결함 전부였다.
function pickRecoverySlot(base: string): string {
  if (!existsSync(base)) return base;
  for (let i = 1; i < MAX_RECOVERY_POINTS; i++) {
    const candidate = `${base}.${i}`;
    if (!existsSync(candidate)) return candidate;
  }
  throw new Error(
    `migration refused: ${MAX_RECOVERY_POINTS} recovery points already exist for this schema ` +
    `version (${base} and ${MAX_RECOVERY_POINTS - 1} numbered siblings). The migration has failed ` +
    `repeatedly — inspect the database and move the backups aside deliberately rather than letting ` +
    `another attempt run.`);
}

// 사용자 테이블 중 하나라도 행이 있으면 잃을 데이터가 있다.
// 목록은 스키마에서 얻는다(하드코딩하면 새 테이블이 조용히 검사 밖에 남는다).
// `schema_migrations` 는 순수 메타데이터라 제외한다 — 그것만 있는 DB 는 빈 DB 다.
// 가상 테이블은 자기 shadow 테이블을 통해 이미 세어진다.
function hasAnyUserRows(db: Database.Database): boolean {
  const tables = db.prepare(
    `SELECT name, sql FROM sqlite_schema WHERE type='table'
       AND name <> 'schema_migrations'
     ORDER BY name`).all() as Array<{ name: string; sql: string | null }>;
  for (const t of tables) {
    if (/CREATE VIRTUAL TABLE/i.test(t.sql ?? '')) continue;
    const qt = `"${t.name.replace(/"/g, '""')}"`;
    try {
      const n = db.prepare(`SELECT EXISTS(SELECT 1 FROM ${qt}) e`).get() as { e: number };
      if (n.e) return true;
    } catch {
      // 읽을 수 없는 테이블이 있으면 "빈 DB"라고 단정하지 않는다 = 백업한다.
      return true;
    }
  }
  return false;
}

// 스트리밍 해시. readFileSync 로 전체를 메모리에 올리면 fleet 의 큰 DB 에서
// OOM 위험이 있다(advisor 구현리뷰 r1 발견 6).
function streamSha256(path: string): string {
  const h = createHash('sha256');
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.allocUnsafe(1 << 20);
    let n: number;
    while ((n = readSync(fd, buf, 0, buf.length, null)) > 0) h.update(buf.subarray(0, n));
  } finally { closeSync(fd); }
  return h.digest('hex');
}
