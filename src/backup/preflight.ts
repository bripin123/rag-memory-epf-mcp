import { existsSync, statSync, readFileSync } from 'node:fs';
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

  // 신규 DB(스키마 버전 0)는 백업 대상이 아니다 — 잃을 데이터가 없다.
  // 이 가드가 없으면 같은 경로를 재사용하는 정상 경로(서버 재시작·테스트가
  // DB 파일을 지우고 다시 만드는 경우)에서 남아 있던 .bak 때문에 두 번째
  // 부팅이 죽는다. fail-closed 가 정상 운영을 막으면 그것은 게이트가 아니다.
  if (currentVersion <= 0) return null;

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
  const sha256 = createHash('sha256').update(readFileSync(target)).digest('hex');
  console.error(`  ├─ 🛟 backup ${target} (sha256 ${sha256.slice(0, 12)}…)`);
  return { path: target, sha256 };
}
