const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { execFileSync, spawnSync } = require('node:child_process');
const { test, after } = require('node:test');

const workflow = fs.readFileSync(path.join(__dirname, '..', '.github/workflows/release.yml'), 'utf8').replace(/\r\n/g, '\n');
const prepare = workflow.match(/        node <<'NODE'\n([\s\S]*?)\n        NODE/)[1].replace(/^        /gm, '');
const gate = workflow.slice(workflow.indexOf('    - name: Check publish target'), workflow.indexOf('    - name: Publish release')).split('      run: |\n')[1].replace(/^        /gm, '');
const buildArchive = workflow.match(/        python <<'PY'\n([\s\S]*?)\n        PY/)[1].replace(/^        /gm, '');

function releaseNotes(version, changelog) {
    const writes = new Map();
    const fixtureFs = {
        readFileSync(file) {
            if (file === 'vaft/vaft.user.js') return '// @version      ' + version + '\r\n';
            if (file === 'CHANGELOG.md') return changelog;
            throw new Error('Unexpected release input: ' + file);
        },
        writeFileSync: (file, body) => writes.set(file, body),
        appendFileSync: (file, body) => writes.set(file, (writes.get(file) || '') + body)
    };
    vm.runInNewContext(prepare, {
        require: name => name === 'node:fs' ? fixtureFs : require(name),
        process: { env: { RUNNER_TEMP: 'release-fixture', GITHUB_OUTPUT: 'outputs' } },
        console: { log() {} }
    });
    return { notes: writes.get(path.join('release-fixture', 'release-notes.md')), output: writes.get('outputs') };
}

test('release notes select the exact version and handle CRLF', () => {
    assert.deepEqual(releaseNotes('1.2.3', '## Unreleased\r\n\r\nfuture\r\n\r\n## v1.2.3 (date)\r\n\r\ncurrent\r\n\r\n## v1.2.2\r\n\r\nold\r\n'), {
        notes: 'current\n', output: 'version=1.2.3\n'
    });
});

test('new versions use Unreleased notes', () => {
    assert.equal(releaseNotes('1.2.4', '## Unreleased\n\nnew fixes\n\n## v1.2.3\n\nold\n').notes, 'new fixes\n');
});

test('version matching cannot select a longer version prefix', () => {
    assert.equal(releaseNotes('1.2.3', '## v1.2.30\n\nwrong\n\n## Unreleased\n\ncorrect\n').notes, 'correct\n');
});

test('missing release notes fail', () => {
    assert.throws(() => releaseNotes('1.2.4', '## Unreleased\n\n'), /No release notes/);
});

for (const version of ['1.2.4beta1', '1.2.4;echo bad']) {
    test('stable release preparation rejects ' + version, () => {
        assert.throws(() => releaseNotes(version, '## Unreleased\n\nfixes\n'), /Expected a stable/);
    });
}

// Publish-gate tests create tags only in a temporary repository.
const tempRoot = path.resolve(os.tmpdir());
const repository = fs.mkdtempSync(path.join(tempRoot, 'tas-release-gate-'));
execFileSync('git', ['init', '--quiet'], { cwd: repository });
execFileSync('git', ['-c', 'user.name=CI Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-m', 'fixture'], { cwd: repository, stdio: 'pipe' });
execFileSync('git', ['tag', 'v1.2.3'], { cwd: repository });
after(() => {
    if (path.dirname(path.resolve(repository)) !== tempRoot) throw new Error('Temporary repository is outside the test directory');
    fs.rmSync(repository, { recursive: true });
});
const bash = process.platform === 'win32' ? path.join(process.env.ProgramFiles, 'Git/bin/bash.exe') : 'bash';
for (const [ref, tag, expected] of [
    ['refs/heads/feature', 'v1.2.4', 1],
    ['refs/heads/master', 'v1.2.3', 1],
    ['refs/heads/master', 'v1.2.4', 0]
]) {
    test('publish gate checks ' + ref + ' ' + tag, () => {
        const result = spawnSync(bash, ['-e', '-o', 'pipefail'], {
            cwd: repository, input: gate, encoding: 'utf8',
            env: { ...process.env, GITHUB_REF: ref, TAG: tag }
        });
        assert.ifError(result.error);
        assert.equal(result.status, expected, result.stdout + result.stderr);
        assert.equal(execFileSync('git', ['tag'], { cwd: repository, encoding: 'utf8' }).trim(), 'v1.2.3');
    });
}

test('publishing requires an explicit opt-in after unit tests', () => {
    assert.match(workflow, /dry_run:\n\s+description:[^\n]+\n\s+type: boolean\n\s+default: true/);
    assert.equal((workflow.match(/if: \$\{\{ !inputs\.dry_run \}\}/g) || []).length, 2);
    const unitTests = workflow.indexOf('    - name: Run unit tests');
    assert.ok(unitTests >= 0 && unitTests < workflow.indexOf('    - name: Check publish target'));
    assert.match(workflow, /target_commitish: \$\{\{ github\.sha \}\}/);
    assert.match(workflow, /release-artifact\/vaft\/vaft\.user\.js/);
    assert.match(workflow, /release-artifact\/vaft\/vaft-ublock-origin\.js/);
    assert.match(workflow, /release-artifact\/TwitchAdSolutions-v\$\{\{ steps\.release\.outputs\.version \}\}\.zip/);
    assert.match(workflow, /release-artifact\/SHA256SUMS/);
    assert.match(workflow, /fail_on_unmatched_files: true/);
    assert.doesNotMatch(workflow, /git (?:commit|push|tag) /);
});

test('publishing runs locked dependencies, the full Node suite, browsers and packaging first', () => {
    const commands = ['npm ci --ignore-scripts', 'npm test', 'npx playwright install --with-deps', 'npm run test:browser', 'npm run test:package'];
    const publish = workflow.indexOf('    - name: Check publish target');
    let previous = 0;
    for (const command of commands) {
        const index = workflow.indexOf('run: ' + command);
        assert.ok(index > previous && index < publish, command);
        previous = index;
    }
    assert.doesNotMatch(workflow, /npm install -g/);
    assert.match(workflow, /if: \$\{\{ inputs\.dry_run \}\}\n\s+uses: actions\/upload-artifact/);
});

test('release packaging normalizes line endings and verifies a repeatable bundle', () => {
    const { createHash } = require('node:crypto');
    const { scripts, root } = require('./scripts');
    const output = path.join(repository, 'package');
    execFileSync(process.execPath, [path.join(__dirname, 'package.js'), output], { stdio: 'pipe' });
    const manifest = fs.readFileSync(path.join(output, 'SHA256SUMS'), 'utf8');
    for (const { file } of scripts) {
        const expected = Buffer.from(fs.readFileSync(path.join(root, file), 'utf8').replace(/\r\n/g, '\n'));
        const actual = fs.readFileSync(path.join(output, file));
        assert.deepEqual(actual, expected, file);
        assert.ok(manifest.includes(createHash('sha256').update(actual).digest('hex') + '  ' + file));
    }
    const build = () => execFileSync('python', ['-c', buildArchive], {
        env: { ...process.env, VERSION: '1.2.4', RELEASE_DIR: output }, stdio: 'pipe'
    });
    build();
    const archive = path.join(output, 'TwitchAdSolutions-v1.2.4.zip');
    const first = fs.readFileSync(archive);
    build();
    assert.deepEqual(fs.readFileSync(archive), first);
    const entries = JSON.parse(execFileSync('python', ['-c', 'import json,sys,zipfile; print(json.dumps(zipfile.ZipFile(sys.argv[1]).namelist()))', archive], { encoding: 'utf8' }));
    assert.deepEqual(entries, [...scripts.map(script => script.file), 'SHA256SUMS']);
    fs.appendFileSync(path.join(output, scripts[0].file), '\n// tampered fixture\n');
    assert.throws(build, /Checksum mismatch/);
});

test('the current checkout prepares nonempty notes for its userscript version', () => {
    const output = path.join(repository, 'release-output');
    vm.runInNewContext(prepare, { require, console: { log() {} }, process: { env: { RUNNER_TEMP: repository, GITHUB_OUTPUT: output } } });
    const script = fs.readFileSync(path.join(__dirname, '..', 'vaft/vaft.user.js'), 'utf8');
    const version = /@version\s+(\S+)/.exec(script)[1];
    assert.equal(fs.readFileSync(output, 'utf8'), 'version=' + version + '\n');
    assert.ok(fs.readFileSync(path.join(repository, 'release-notes.md'), 'utf8').trim().length > 0);
});
