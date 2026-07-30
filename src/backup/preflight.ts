import { existsSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';

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

  // 기존 backup 절대 overwrite 금지 (spec §5.1-3)
  if (existsSync(target)) {
    throw new Error(
      `migration backup refused: ${target} already exists. ` +
      `Move or remove it deliberately — overwriting it would destroy the only recovery point.`);
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
  // 스트리밍 해시. readFileSync 로 전체를 메모리에 올리면 fleet 의 큰 DB 에서
  // OOM 위험이 있다(advisor 구현리뷰 r1 발견 6).
  const sha256 = (() => {
    const h = createHash('sha256');
    const fd = openSync(target, 'r');
    try {
      const buf = Buffer.allocUnsafe(1 << 20);
      let n: number;
      while ((n = readSync(fd, buf, 0, buf.length, null)) > 0) h.update(buf.subarray(0, n));
    } finally { closeSync(fd); }
    return h.digest('hex');
  })();
  console.error(`  ├─ 🛟 backup ${target} (sha256 ${sha256.slice(0, 12)}…)`);
  return { path: target, sha256 };
}
