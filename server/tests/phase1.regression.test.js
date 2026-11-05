const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { spawn } = require('child_process');

// Runs the original Phase 1 checks (102, now 103) (tests/legacy/phase1-checks.js) in their own
// process, because that suite boots server.js with its own in-memory database.
test('Phase 1 regression: all 103 security and booking checks pass', { timeout: 300000 }, async () => {
    const { code, out } = await new Promise((resolve) => {
        const child = spawn(process.execPath, [path.join(__dirname, 'legacy', 'phase1-checks.js')], {
            cwd: __dirname,
            stdio: ['ignore', 'pipe', 'pipe']
        });
        let output = '';
        child.stdout.on('data', (d) => { output += d; });
        child.stderr.on('data', (d) => { output += d; });
        child.on('exit', (exitCode) => resolve({ code: exitCode, out: output }));
    });

    const summary = out.match(/(\d+)\/(\d+) checks passed/);
    const failures = out.split('\n').filter((line) => line.startsWith('FAIL'));
    assert.ok(summary, `no summary line in output:\n${out.slice(-2000)}`);
    assert.equal(failures.length, 0, failures.join('\n'));
    assert.equal(summary[1], summary[2]);
    // 102 original checks; one became two when organisers could submit events (WP5).
    assert.equal(Number(summary[2]), 103);
    assert.equal(code, 0);
});
