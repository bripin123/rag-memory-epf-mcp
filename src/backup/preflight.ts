import { existsSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';

// 이 DB 파일의 신원. 백업은 파일 복사이므로 같은 값을 갖는다 — 그래서 남아 있는
// .bak 이 *이 DB* 의 백업인지 판정할 수 있다. 스키마 버전은 신원이 아니다:
// 같은 fleet 의 다른 프로젝트 DB 도 v12 이고 quick_check 도 통과한다
// (advisor beta r3 발견 1, 두 DB 로 실행 재현).
function dbInstanceId(db: Database.Database, create: boolean): string | null {
  const hasMeta = db.prepare(
    `SELECT 1 FROM sqlite_master WHERE type='table' AND name='server_meta'`).get();
  if (!hasMeta) return null;
  const row = db.prepare(`SELECT value FROM server_meta WHERE key='db_instance_id'`)
    .get() as { value: string } | undefined;
  if (row?.value) return row.value;
  if (!create) return null;
  const id = randomUUID();
  db.prepare(`INSERT OR REPLACE INTO server_meta (key, value) VALUES ('db_instance_id', ?)`).run(id);
  return id;
}

// 내용·계보 지문. 롤백된 마이그레이션은 아무것도 바꾸지 않으므로 재시도 시에도
// 같아야 하고, 그 사이에 실제 쓰기가 있었다면 달라져야 한다. 집계라 큰 DB 에서도 싸다.
function contentFingerprint(db: Database.Database): string {
  const parts: string[] = [];
  for (const t of ['entities', 'relationships', 'documents']) {
    const exists = db.prepare(
      `SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`).get(t);
    if (!exists) { parts.push(`${t}:absent`); continue; }
    const n = db.prepare(`SELECT COUNT(*) c FROM ${t}`).get() as { c: number };
    parts.push(`${t}:${n.c}`);
  }
  const hasEntities = db.prepare(
    `SELECT 1 FROM sqlite_master WHERE type='table' AND name='entities'`).get();
  if (hasEntities) {
    const agg = db.prepare(
      `SELECT COALESCE(SUM(LENGTH(observations)), 0) obs, COALESCE(MAX(id), '') maxid,
              COALESCE(MIN(id), '') minid FROM entities`).get() as
      { obs: number; maxid: string; minid: string };
    parts.push(`obs:${agg.obs}`, `id:${agg.minid}..${agg.maxid}`);
  }
  return createHash('sha256').update(parts.join('|')).digest('hex');
}

// spec §5.1: 마이그레이션 전 SQLite-consistent snapshot.
// 파일 복사는 금지 — WAL 이 반영되지 않는다. better-sqlite3 의 backup() 은
// SQLite backup API 를 쓰므로 WAL 을 포함한 일관 스냅샷을 만든다.
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

  // 백업 대상 판정 = "잃을 데이터가 있는가". 스키마 버전만으로 판정하면
  // migration metadata 가 없거나 비어 있는데 실제 데이터는 있는 DB(수동 복사본,
  // 부분 복구본)를 백업 없이 통과시킨다(advisor 구현리뷰 r1 발견 6).
  // 그래서 버전과 실제 행 수를 함께 본다.
  const hasData = (() => {
    for (const t of ['entities', 'documents', 'relationships']) {
      const exists = db.prepare(
        `SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`).get(t);
      if (!exists) continue;
      const n = db.prepare(`SELECT COUNT(*) c FROM ${t}`).get() as { c: number };
      if (n.c > 0) return true;
    }
    return false;
  })();
  // 진짜 빈 신규 DB 만 건너뛴다. 이 가드가 없으면 같은 경로를 재사용하는
  // 정상 경로(서버 재시작·테스트가 DB 를 지우고 재생성)에서 남은 .bak 때문에
  // 두 번째 부팅이 죽는다 — fail-closed 가 정상 운영을 막으면 게이트가 아니다.
  if (currentVersion <= 0 && !hasData) return null;

  const target = `${dbPath}.v${currentVersion}.bak`;

  // 기존 backup 은 절대 overwrite 하지 않는다 (spec §5.1-3). 다만 "존재하면 거부"는
  // 너무 강했다: 마이그레이션이 한 번 실패하면 .bak 이 남고, 그 뒤 모든 재시작이
  // 마이그레이션에 진입하기도 전에 죽는다 = fleet 자동 재시작 환경에서 영구 crashloop
  // 이고, spec 의 crash 후 resume 요구와 정면으로 충돌한다(advisor beta 발견 3).
  //
  // 필요한 보장은 "지금의 pre-migration 상태에 대한 유효한 복구점이 존재한다"이고,
  // 남아 있는 .bak 이 (a) 온전하고 (b) 이 DB 와 같은 스키마 버전이면 그 보장은
  // 이미 충족된다 — 새로 만들 이유가 없고, 덮어쓸 이유도 없다. 그래서 **검증 후
  // 재사용**한다. 검증에 실패하면 그때는 거부한다(그건 진짜 사람이 봐야 하는 상태다).
  // 신원을 먼저 확정한다 — 백업이 이 값을 담아야 나중에 대조할 수 있다.
  const liveId = dbInstanceId(db, true);
  const liveFingerprint = contentFingerprint(db);

  if (existsSync(target)) {
    const reused = verifyExistingBackup(target, currentVersion, liveId, liveFingerprint);
    if (!reused.ok) {
      throw new Error(
        `migration backup refused: ${target} already exists but is not a usable recovery point ` +
        `for this database (${reused.reason}). Move or remove it deliberately — overwriting it ` +
        `would destroy whatever it does contain.`);
    }
    console.error(`  ├─ 🛟 reusing verified backup ${target} (schema v${currentVersion}, same database)`);
    return { path: target, sha256: reused.sha256 };
  }

  // SQLite backup API. 동기 완료를 보장하려면 VACUUM INTO 가 더 단순하고
  // better-sqlite3 의 backup() 은 Promise 라 마이그레이션 흐름과 섞이면
  // 순서를 잃는다. VACUUM INTO 는 WAL 을 반영한 일관 스냅샷을 동기로 만든다.
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

// 남아 있는 .bak 이 이 DB 의 pre-migration 복구점으로 쓸 수 있는가.
// 파일명이 이미 버전을 담고 있으므로(.vN.bak) 내부 버전이 N 과 다르면 그 파일은
// 이 자리에 있을 이유가 없다 = 사람이 봐야 하는 상태다.
function verifyExistingBackup(
  target: string, expectedVersion: number, liveId: string | null, liveFingerprint: string
): { ok: true; sha256: string } | { ok: false; reason: string } {
  try {
    if (statSync(target).size === 0) return { ok: false, reason: 'zero bytes' };
    const db = new Database(target, { readonly: true });
    try {
      const ok = db.pragma('quick_check', { simple: true });
      if (ok !== 'ok') return { ok: false, reason: `quick_check ${ok}` };
      const n = db.prepare(`SELECT COUNT(*) c FROM sqlite_master`).get() as { c: number };
      if (!n || n.c === 0) return { ok: false, reason: 'empty schema' };
      const hasVersions = db.prepare(
        `SELECT 1 FROM sqlite_master WHERE type='table' AND name='schema_migrations'`).get();
      const v = hasVersions
        ? (db.prepare(`SELECT COALESCE(MAX(version), 0) v FROM schema_migrations`)
            .get() as { v: number }).v
        : 0;
      if (v !== expectedVersion) {
        return { ok: false, reason: `holds schema v${v}, expected v${expectedVersion}` };
      }
      // 신원: 이 백업이 *이 DB* 에서 나왔는가. 같은 경로에 다른 DB 가 놓였거나
      // 백업 이후 live 가 교체됐으면 여기서 걸린다.
      if (!liveId) return { ok: false, reason: 'live database has no instance id to compare' };
      const bakId = dbInstanceId(db, false);
      if (!bakId) return { ok: false, reason: 'backup carries no instance id' };
      if (bakId !== liveId) {
        return { ok: false, reason: `belongs to database ${bakId.slice(0, 8)}…, live is ${liveId.slice(0, 8)}…` };
      }
      // 계보: 실패 이후 live 에 실제 쓰기가 있었으면 이 백업은 더 이상 현 상태의
      // 복구점이 아니다. 그때는 기존 백업을 보존한 채 멈춘다.
      const bakFingerprint = contentFingerprint(db);
      if (bakFingerprint !== liveFingerprint) {
        return { ok: false, reason:
          `content diverged from live (backup ${bakFingerprint.slice(0, 12)}…, ` +
          `live ${liveFingerprint.slice(0, 12)}…) — it is no longer a snapshot of the current state` };
      }
    } finally {
      db.close();
    }
    return { ok: true, sha256: streamSha256(target) };
  } catch (e) {
    return { ok: false, reason: `unreadable: ${(e as Error).message}` };
  }
}
