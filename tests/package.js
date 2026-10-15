const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { root, scripts } = require('./scripts');

const output = path.resolve(process.argv[2] || 'release-artifact');
const checksums = [];
for (const { file } of scripts) {
    const source = fs.readFileSync(path.join(root, file));
    const target = path.join(output, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, source);
    assert.deepEqual(fs.readFileSync(target), source, file + ' changed during packaging');
    checksums.push(createHash('sha256').update(source).digest('hex') + '  ' + file);
}
fs.writeFileSync(path.join(output, 'SHA256SUMS'), checksums.join('\n') + '\n');
console.log('Packaged and verified ' + scripts.length + ' installable scripts in ' + output);
