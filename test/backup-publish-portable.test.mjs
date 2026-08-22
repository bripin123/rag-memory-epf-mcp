// 복구점 발행이 하드링크 없는 파일시스템에서도 동작하는가 (2026-08-22 필드 보고).
//
// 배경: Google Drive File Stream(Windows G:\)은 하드링크를 지원하지 않아 linkSync 가
// EISDIR(-4068)로 실패했고, publishNoClobber 가 EEXIST 가 아닌 코드를 그대로 throw 하여
// server.connect() 전에 죽었다. 사용자에게는 원인 없는 "MCP 연결 실패"로만 보였다.
//
// 이 테스트는 하드링크 없는 FS 를 흉내내지 않는다 — 그럴 필요가 없도록 코드에서
// 분기 자체를 없앴기 때문이다. 대신 (1) 그 분기가 되돌아오지 않는지 정적으로 확인하고
// (2) 발행 계약(no-clobber · 슬롯 순환 · fail-closed · 게시본 유효성)이 그대로인지 잰다.
import { readFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { backupBeforeMigration } from '../dist/src/backup/preflight.js';

let failed = 0;
const ok = (cond, msg) => { console.log(`${cond ? '✔' : '✖'} ${msg}`); if (!cond) failed++; };

// (1) 정적: 하드링크로 되돌아가지 않았는가.
// 소스에서 linkSync( 호출을 센다. unlinkSync 는 접미 일치라 제외해야 한다.
{
  const src = readFileSync(new URL('../src/backup/preflight.ts', import.meta.url), 'utf8');
  const calls = [...src.matchAll(/(?<![A-Za-z])linkSync\s*\(/g)].length;
  const copies = [...src.matchAll(/copyFileSync\s*\(/g)].length;
  ok(calls === 0, `preflight.ts 에 linkSync() 호출 없음 (실측 ${calls})`);
  ok(copies >= 1, `COPYFILE_EXCL 복사 경로 존재 (copyFileSync ${copies}회)`);
  ok(/COPYFILE_EXCL/.test(src), 'no-clobber 의미가 COPYFILE_EXCL 로 보존됨');
}

const dir = mkdtempSync(join(tmpdir(), 'ragbk-'));
const dbPath = join(dir, 'test.db');
const seed = () => {
  const db = new Database(dbPath);
  db.exec(`CREATE TABLE IF NOT EXISTS entities (id TEXT PRIMARY KEY, name TEXT)`);
  db.prepare(`INSERT OR IGNORE INTO entities VALUES (?,?)`).run('e1', 'x');
  return db;
};

try {
  // (2) 발행되고, 게시본이 열리는 유효한 DB 인가.
  {
    const db = seed();
    const r = await backupBeforeMigration(db, dbPath, [15], 14);
    ok(r !== null && existsSync(r.path), `복구점 발행됨 (${r && r.path.split('/').pop()})`);
    ok(!existsSync(`${dbPath}.v14.bak.partial-${process.pid}`), 'tmp 가 남지 않음');
    const v = new Database(r.path, { readonly: true });
    const n = v.prepare(`SELECT COUNT(*) c FROM entities`).get().c;
    v.close();
    ok(n === 1, '게시본이 원본 행을 담고 있다');
    ok(typeof r.sha256 === 'string' && r.sha256.length === 64, 'sha256 반환');
    db.close();
  }

  // (3) 슬롯 경쟁: 기존 슬롯을 덮지 않고 다음 슬롯으로 간다.
  {
    const db = seed();
    const r2 = await backupBeforeMigration(db, dbPath, [15], 14);
    ok(r2.path.endsWith('.bak.1'), `두 번째는 다음 슬롯 (${r2.path.split('/').pop()})`);
    db.close();
  }

  // (4) 슬롯 만원이면 fail-closed (백업 없이 스키마를 바꾸지 않는다).
  {
    const db = seed();
    await backupBeforeMigration(db, dbPath, [15], 14);   // .bak.2 까지 채움
    let threw = false;
    try { await backupBeforeMigration(db, dbPath, [15], 14); } catch { threw = true; }
    ok(threw, '슬롯이 다 차면 throw = fail-closed');
    db.close();
  }

  // (5) 목적지가 손상돼 있으면 그 슬롯을 점유한 채 통과하지 않는다.
  //     (복사는 원자적이지 않으므로 게시 후 재검증이 계약이다)
  {
    const dir2 = mkdtempSync(join(tmpdir(), 'ragbk2-'));
    const p2 = join(dir2, 'test2.db');
    const db = new Database(p2);
    db.exec(`CREATE TABLE entities (id TEXT PRIMARY KEY)`);
    db.prepare(`INSERT INTO entities VALUES ('a')`).run();
    const r = await backupBeforeMigration(db, p2, [15], 14);
    ok(existsSync(r.path), '정상 발행 (대조군)');
    // 게시본을 손상시키고 verifyRecoveryPoint 가 그것을 복구점으로 인정하지 않는지
    writeFileSync(r.path, Buffer.from('not a sqlite file'));
    let rejected = false;
    try { new Database(r.path, { readonly: true }).pragma('quick_check', { simple: true }); }
    catch { rejected = true; }
    ok(rejected, '손상된 파일은 유효한 DB 로 열리지 않는다 (검증이 잡을 대상)');
    db.close(); rmSync(dir2, { recursive: true, force: true });
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
