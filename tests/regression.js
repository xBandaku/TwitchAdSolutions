const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { root } = require('./scripts');

const [ref, pattern, expectedError] = process.argv.slice(2);
if (!ref || !pattern || !expectedError) {
    throw new Error('Usage: node tests/regression.js <before-ref> <test-name-pattern> <expected-error>');
}
const commit = execFileSync('git', ['rev-parse', '--verify', ref + '^{commit}'], { cwd: root, encoding: 'utf8' }).trim();
const files = fs.readdirSync(__dirname).filter(file => file.endsWith('.test.js')).map(file => path.join(__dirname, file));
const matches = new RegExp(pattern);
const run = baseline => {
    const env = { ...process.env };
    delete env.TWITCH_TEST_SCRIPT_REF;
    if (baseline) env.TWITCH_TEST_SCRIPT_REF = commit;
    const result = spawnSync(process.execPath, ['--test', '--test-reporter=tap', '--test-name-pattern=' + pattern, ...files], {
        cwd: root, env, encoding: 'utf8', timeout: 60000
    });
    if (result.error) throw result.error;
    const selected = Array.from(result.stdout.matchAll(/^# Subtest: (.+)$/gm), match => match[1]).filter(name => matches.test(name));
    assert.ok(selected.length > 0, 'No matching regression tests ran');
    const summary = key => Number(new RegExp('^# ' + key + ' (\\d+)$', 'm').exec(result.stdout)?.[1]);
    if (baseline) {
        assert.equal(result.status, 1, 'Baseline must fail the selected tests');
        assert.equal(summary('fail'), selected.length, result.stdout + result.stderr);
        for (const block of result.stdout.split(/^# Subtest: /m).slice(1)) {
            if (!selected.includes(block.split('\n')[0])) continue;
            assert.ok(block.includes(expectedError), 'Baseline failed for a different reason:\n' + block);
        }
    } else {
        assert.equal(result.status, 0, result.stdout + result.stderr);
        for (const name of selected) {
            const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            assert.match(result.stdout, new RegExp('^ok \\d+ - ' + escaped + '$', 'm'), 'Selected test must pass, not skip');
        }
    }
    return selected.sort();
};
const before = run(true);
const after = run(false);
assert.deepEqual(after, before, 'Before and after must run the same tests');
console.log(before.length + ' regression tests failed at ' + commit.slice(0, 7) + ' with the expected error and passed in the working tree.');
console.log('Evidence remains whatever the tests declare; before/after verification does not establish live Twitch impact.');
