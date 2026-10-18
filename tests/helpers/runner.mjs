// Minimal assertion runner so the suite needs no test framework beyond Node itself.
export function createRunner(suiteName) {
  let passed = 0;
  let failed = 0;
  const failures = [];

  function check(name, condition, detail = '') {
    if (condition) {
      passed++;
      console.log(`  ok   ${name}`);
    } else {
      failed++;
      failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
      console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
    }
  }

  function report() {
    console.log(`\n${suiteName}: ${passed} passed, ${failed} failed`);
    if (failed > 0) {
      console.log('Failures:');
      for (const f of failures) console.log(`  - ${f}`);
    }
    return failed === 0 ? 0 : 1;
  }

  console.log(`${suiteName}\n`);
  return { check, report, counts: () => ({ passed, failed }) };
}
