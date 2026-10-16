// C1 bookkeeping (kg-relation-evidence). Four outcomes, never merged:
//   PASS    - control passed and every target assertion held.
//   RED     - control passed, then a TARGET assertion failed (defect(cond, msg)), or the call failed with
//             the error that IS the defect (expectDefectError). Only this counts as "reproduced".
//   NOT-RUN - the positive control failed, or a fixture precondition inside the case did not hold
//             (fixture(cond, msg): e.g. the injected side effect never fired). The oracle proved nothing.
//   ERROR   - anything else thrown inside the case (TypeError, an unexpected exception, a model or
//             environment failure). Never counted as RED, never as "did not reproduce".
// All but PASS set exit code 1, so the same file passes (exit 0) only once the defect is fixed.
export class DefectError extends Error { constructor(msg) { super(msg); this.name = 'DefectError'; } }
export class FixtureNotRun extends Error { constructor(msg) { super(msg); this.name = 'FixtureNotRun'; } }
export function defect(cond, msg) { if (!cond) throw new DefectError(msg); }
export function fixture(cond, msg) { if (!cond) throw new FixtureNotRun(msg); }
// The call is expected to succeed after the fix; on 6.4.0 it throws `pattern`, which is the defect.
export async function expectDefectError(fn, pattern, msg) {
  try { return await fn(); }
  catch (e) { if (pattern.test(String(e?.message))) throw new DefectError(`${msg}: ${e.message}`); throw e; }
}
export async function redCase(name, { control, defect: body }) {
  try { await control(); }
  catch (e) { process.exitCode = 1; console.log(`  NOT-RUN ${name}: control failed: ${e.message}`); return 'not-run'; }
  try { await body(); console.log(`  PASS ${name}`); return 'pass'; }
  catch (e) {
    process.exitCode = 1;
    if (e instanceof DefectError) { console.log(`  RED ${name}: ${e.message}`); return 'red'; }
    if (e instanceof FixtureNotRun) { console.log(`  NOT-RUN ${name}: fixture: ${e.message}`); return 'not-run'; }
    console.log(`  ERROR ${name}: ${e?.name ?? 'Error'}: ${e?.message ?? String(e)}`); return 'error';
  }
}
