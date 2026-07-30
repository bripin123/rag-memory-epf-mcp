import { existsSync, statSync, openSync, readSync, closeSync, linkSync, unlinkSync } from 'node:fs';
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';

// 이 파일이 지켜야 하는 것은 두 줄이다:
//   ① 복구점을 절대 덮어쓰지 않는다
//   ② 재시작을 막지 않는다
//
// 이걸 "남아 있는 .bak 이 live 와 같은 상태인가"를 증명해서 풀려고 세 판본을 썼고
// 세 번 다 틀렸다(스키마 버전을 신원으로 착각 → DB 내부 UUID+집계 지문 → 전체 논리
// 다이제스트). 등가 증명은 애초에 필요하지 않았다: **백업은 스키마를 바꾸기 전에
// 만들어지므로, 시도마다 다음 빈 슬롯에 하나 더 만들면 그 모든 파일이 정의상 유효한
// pre-migration 스냅샷이다.** 덮어쓰지 않으니 ①, 막지 않으니 ②. 비교가 없으니
// 비교 정확성 문제가 전부 사라진다. (advisor beta r2~r7 결론)
//
// 대가 = 디스크. 슬롯을 유한하게 두고 다 차면 fail-closed 한다.
const MAX_RECOVERY_POINTS = 3;

// spec §5.1: 마이그레이션 전 일관 스냅샷.
//
// **`VACUUM INTO` 를 쓰지 않는다.** SQLite 문서는 VACUUM 이 명시적
// `INTEGER PRIMARY KEY` 가 없는 테이블의 ROWID 를 바꿀 수 있다고 명시한다. 이 스키마의
// `entities` 는 `TEXT PRIMARY KEY` 라 hidden ROWID 테이블이고, `entities_fts` 는
// `content_rowid='rowid'` 로 그 hidden ROWID 를 참조한다 — 재번호가 일어나면 백업
// **자체가** external-content 불일치를 안고 태어나며, `quick_check` 는 그것을 통과시킨다.
// 현재 빌드(SQLite 3.51.3, 이 스키마)에서는 재번호가 관측되지 않았다. 하지만
// **관측되지 않은 것과 계약으로 금지된 것은 다르고**, `better-sqlite3` 는 `^12.8.0`
// 부동이며 이 파일은 유일한 복구선이다. 그래서 bitwise-identical 스냅샷을 보장하는
// Online Backup API(`db.backup()`)를 쓴다. (advisor beta r7 P0-1)
//
// 실패는 전부 throw = fail-closed. 백업 없이 스키마를 바꾸지 않는다:
// 이 프로젝트군은 non-git 환경(Google Drive 폴더)에 배포되어 git 롤백이 없다.
//
// **단일 writer 전제**: 백업과 마이그레이션 사이에 다른 프로세스가 커밋하면 그 커밋은
// 마이그레이션에는 들어가고 복구점에는 없다. 이 엔진은 프로젝트당 서버 하나로 배포되며
// (프로젝트별 `.mcp.json`), 마이그레이션은 `server.connect()` 전에 끝난다. 같은 DB 를
// 두 프로세스가 동시에 여는 것은 지원 대상이 아니다 — 상세 = docs/UPDATING.md.
export async function backupBeforeMigration(
  db: Database.Database,
  dbPath: string,
  pendingVersions: number[],
  currentVersion: number
): Promise<{ path: string; sha256: string } | null> {
  if (pendingVersions.length === 0) return null;          // 대기 없으면 no-op
  if (!dbPath || dbPath === ':memory:') return null;      // 메모리 DB 는 대상 아님

  // 백업 대상 판정 = "잃을 데이터가 있는가". 테이블 목록을 하드코딩하면 그 목록 밖의
  // 데이터가 안 보인다 — `embedding_profiles` 에만 행이 있는 version-0 DB 가 그렇게
  // 무백업으로 통과했다(advisor beta r6 P0-3). 그래서 사용자 테이블 전체를 본다.
  if (currentVersion <= 0 && !hasAnyUserRows(db)) return null;

  const base = `${dbPath}.v${currentVersion}.bak`;
  // 임시 파일에 먼저 만든다 = 이 프로세스가 독점 소유한다. 검증까지 통과한 뒤에야
  // 슬롯에 게시하므로, 슬롯에는 절대 반쯤 만들어진 파일이 놓이지 않는다.
  const tmp = `${base}.partial-${process.pid}`;
  if (existsSync(tmp)) unlinkSync(tmp);
  await db.backup(tmp);

  try {
    verifyRecoveryPoint(tmp);
    const target = publishNoClobber(tmp, base);
    const sha256 = streamSha256(target);
    console.error(`  ├─ 🛟 backup ${target} (sha256 ${sha256.slice(0, 12)}…)`);
    return { path: target, sha256 };
  } catch (e) {
    try { if (existsSync(tmp)) unlinkSync(tmp); } catch { /* 정리 실패는 원인을 가리지 않는다 */ }
    throw e;
  }
}

// 이 파일이 실제로 복구점인가. `quick_check` 는 페이지 구조만 본다 — external-content
// FTS5 의 rowid 불일치는 통과시킨다. FTS5 자신의 `integrity-check` 가 그 대조를 한다.
function verifyRecoveryPoint(path: string): void {
  // 우리가 독점 소유한 임시 파일이므로 쓰기 모드로 연다(integrity-check 는 명령 삽입이다).
  const v = new Database(path);
  try {
    const ok = v.pragma('quick_check', { simple: true });
    if (ok !== 'ok') throw new Error(`migration backup failed quick_check: ${ok}`);
    const n = v.prepare(`SELECT COUNT(*) c FROM sqlite_master`).get() as { c: number };
    if (!n || n.c === 0) throw new Error('migration backup has empty schema');

    const fts = (v.prepare(
      `SELECT name FROM sqlite_schema WHERE type='table' AND sql LIKE '%USING fts5%'`)
      .all() as Array<{ name: string }>);
    for (const { name } of fts) {
      const q = `"${name.replace(/"/g, '""')}"`;
      try {
        // **`rank = 1` 이 필수다.** 인자 없는 integrity-check 는 인덱스가 자기 자신과
        // 정합한지만 본다 — external-content 테이블과의 대조는 하지 않는다. 실측:
        // 인덱스에 content 없는 rowid 를 심어 놓으면 `quick_check` 도, 인자 없는
        // integrity-check 도 **통과**하고 `rank=1` 만 malformed 를 던진다.
        // 즉 rank 없이 부르면 이 검사를 넣은 이유였던 실패 모드를 못 잡는다
        // (advisor beta r8 P0, 같은 런타임에서 재현).
        v.exec(`INSERT INTO ${q}(${q}, rank) VALUES('integrity-check', 1)`);
      } catch (e) {
        throw new Error(
          `migration backup failed FTS5 integrity-check on ${name}: ${(e as Error).message}. ` +
          `The snapshot would not be a usable recovery point.`);
      }
    }
  } finally {
    v.close();
  }
}

// 슬롯 게시. `link()` 는 목적지가 있으면 EEXIST 로 실패하므로 **원자적 no-clobber** 다
// (rename 은 조용히 덮어쓴다). 그래서 경쟁하는 프로세스가 있어도 복구점을 잃지 않는다.
function publishNoClobber(tmp: string, base: string): string {
  for (let attempt = 0; attempt < MAX_RECOVERY_POINTS; attempt++) {
    const slot = pickRecoverySlot(base);
    try {
      linkSync(tmp, slot);
      unlinkSync(tmp);
      return slot;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      // 그 슬롯을 누가 먼저 가져갔다 — 다음 빈 슬롯으로.
    }
  }
  throw slotsFullError(base);
}

// 다음 빈 복구점 슬롯. 기존 파일은 읽지도, 검증하지도, 건드리지도 않는다 —
// 그것들이 무엇인지 판정하려는 시도가 앞선 세 판본의 결함 전부였다.
function pickRecoverySlot(base: string): string {
  if (!existsSync(base)) return base;
  for (let i = 1; i < MAX_RECOVERY_POINTS; i++) {
    const candidate = `${base}.${i}`;
    if (!existsSync(candidate)) return candidate;
  }
  throw slotsFullError(base);
}

// 슬롯이 찬 상태는 **이 스키마 버전에 대한 circuit breaker** 다. 전역 용량 상한이 아니고
// (버전마다 자기 세트를 갖는다), "3회 실패"의 증거도 아니다 — 손상 파일이나 남의 파일이
// 슬롯을 차지할 수도 있다. 그리고 이 오류는 `server.connect()` **전에** 나가므로
// 클라이언트에는 MCP unavailable 로 보인다. 복구 절차를 아는 유일한 경로가 stderr 다.
function slotsFullError(base: string): Error {
  return new Error(
    `migration refused: all ${MAX_RECOVERY_POINTS} recovery-point slots for this schema version ` +
    `are taken (${base} plus ${MAX_RECOVERY_POINTS - 1} numbered siblings). Nothing was written ` +
    `and no existing file was touched. This is a circuit breaker for this version, not a disk ` +
    `quota, and the files are not necessarily failed attempts — a stale or unrelated file occupies ` +
    `a slot just the same. Inspect them, move the ones you do not need aside, then start the ` +
    `server again. Runbook: docs/UPDATING.md "Recovery-point slots are full".`);
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
