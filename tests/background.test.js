const test = require('node:test');
const assert = require('node:assert/strict');
const { parseArgs, summarize } = require('./background');

const sample = (at, phase, time, inAdBreak, paused = false) => ({ at: at * 1000, phase, state: { time, inAdBreak, paused } });

test('synthetic resilience: background harness parses its options', () => {
    const options = parseArgs(['streamerhouse', '--hide', 'minimize', '--no-auto-pip', '--seconds', '120', '--port', '9400']);
    assert.equal(options.channel, 'streamerhouse');
    assert.equal(options.hide, 'minimize');
    assert.equal(options.autoPip, false);
    assert.equal(options.seconds, 120);
    assert.equal(options.port, 9400);
    assert.equal(options.script, 'vaft/vaft.user.js');
});

test('synthetic resilience: background harness rejects bad options', () => {
    assert.throws(() => parseArgs([]), /exactly one channel/);
    assert.throws(() => parseArgs(['Some/Channel']), /lowercase Twitch login/);
    assert.throws(() => parseArgs(['streamerhouse', '--hide', 'away']), /--hide/);
    assert.throws(() => parseArgs(['streamerhouse', '--seconds']), /needs a value/);
    assert.throws(() => parseArgs(['streamerhouse', '--bogus']), /Unknown option/);
    assert.deepEqual(parseArgs(['--help']), { help: true });
});

test('synthetic resilience: background harness reports a stall after a hidden break', () => {
    const samples = [sample(0, 'hidden', 1, true), sample(3, 'hidden', 4, true), sample(6, 'hidden', 0, false)];
    for (let at = 9; at <= 30; at += 3) samples.push(sample(at, 'hidden', 0, false));
    samples.push(sample(33, 'shown', 2, false), sample(36, 'shown', 5, false));
    const summary = summarize(samples);
    assert.equal(summary.adEndedHidden, true);
    assert.ok(summary.stallsAfterBreak > 0);
    assert.equal(summary.longestStallSeconds, 24);
    assert.equal(summary.playingAfterShow, true);
    assert.equal(summary.exitCode, 1);
});

test('synthetic resilience: background harness passes playback that keeps advancing with no decoded frames', () => {
    const samples = [sample(0, 'hidden', 1, true), sample(3, 'hidden', 4, false)];
    for (let at = 6; at <= 30; at += 3) samples.push(sample(at, 'hidden', at + 1, false));
    samples.push(sample(33, 'shown', 34, false), sample(36, 'shown', 37, false));
    const summary = summarize(samples);
    assert.equal(summary.stallsAfterBreak, 0);
    assert.equal(summary.exitCode, 0);
});

test('synthetic resilience: background harness treats a run without a hidden break end as inconclusive', () => {
    const summary = summarize([sample(0, 'hidden', 1, false), sample(3, 'hidden', 4, false)]);
    assert.equal(summary.adSeen, false);
    assert.equal(summary.exitCode, 2);
});
