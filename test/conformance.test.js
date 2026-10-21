// THE CONFORMANCE FIXTURE, and this producer is checked against it.
//
// WHY A FIXTURE AND NOT A CORPUS. The rules are said ONCE, in the package `system1-measure/rules`, and the FIXTURE says
// what they produce. This repository vendors the fixture and pins its digest, so a fixture that changes in the
// package cannot be quietly different here.
//
// THE POINT OF THIS TEST, SPECIFICALLY. The fixture is a **dsh** log, and this repository's producer is the **pi**
// one. So the test is not "does the pi producer agree with itself" -- it is: **does a producer that knows nothing
// about dsh produce the dsh channel's rows from a dsh log?** That is the claim the format makes, and this is where it
// is checked. A producer that had to know which harness wrote the log would fail this test, and that is the point.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { toRows } from '../src/rows.js'

/** The vendored fixture, and the digest the package computes for it. */
const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures/session-rows')

/**
 * THE PINNED DIGEST, and it is the package's own: the package hashes the file NAME and then the bytes, in the order
 * it declares them, so a swapped pair or a renamed file changes it.
 */
const PINNED_DIGEST = '27bb1c0c893adb4f6b52648fdff32cb17b39022f8dbea53451ac5f84058cdb66'

const FIXTURE_FILES = ['fixture/session.v4.jsonl', 'fixture/rows.jsonl']

/** The digest of a fixture held here, computed the way the package computes it. */
const digestOf = (root) => {
    const hash = createHash('sha256')
    for (const file of FIXTURE_FILES) {
        hash.update(file)
        hash.update(readFileSync(join(root, file.split('/').pop())))
    }
    return hash.digest('hex')
}

/** The fixture's records, parsed. */
const recordsOf = () => readFileSync(join(FIXTURE, 'session.v4.jsonl'), 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line))

/** The fixture's expected rows, read as they are written. */
const expectedRows = () => readFileSync(join(FIXTURE, 'rows.jsonl'), 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line))

/** The rows this producer makes of the fixture. */
const producedRows = () => toRows(recordsOf(), {
    harness: 'pi',
    id: 'conformance-1',
    source: '/fixture/session.v4.jsonl',
    sourceBytes: 1,
    sourceSha256: '0'.repeat(64),
    highWater: 7,
})

test('THE VENDORED FIXTURE IS THE PACKAGE\'S, and the digest says so', () => {
    assert.equal(digestOf(FIXTURE), PINNED_DIGEST, 'the vendored fixture is not the one the package ships; update it and the digest together')
})

test('A PRODUCER THAT KNOWS NOTHING ABOUT dsh MAKES THE dsh CHANNEL\'S ROWS, byte for byte', () => {
    // THE RECEIPT CARRIES WHAT WAS READ, so it names the file it read and is not part of the fixture -- which is about
    // the ROWS, and about the rows only.
    const produced = producedRows().filter((row) => row.kind !== 'receipt')
    assert.deepEqual(produced, expectedRows(), 'this producer and the fixture disagree')
})

test('AND THE RECEIPT NAMES THE FORMAT, so the same session measured two ways carries the same receipt', () => {
    const receipt = producedRows().find((row) => row.kind === 'receipt')
    assert.equal(receipt.harness, 'pi:v4', 'the harness and the version of the format it read')
    assert.equal(receipt.sourceSha256, '0'.repeat(64))
    assert.equal(receipt.highWater, 7)
})

test('AND THE FIXTURE EXERCISES EVERY RULE, or it is decoration', () => {
    const rows = expectedRows()
    const messages = rows.filter((row) => row.kind === 'message')
    // THE TRAILING SPACE IS GONE, because the text is trimmed.
    assert.ok(messages.some((row) => row.text === 'push this repo'), 'a trimmed text')
    // AND THE NUL BECAME U+FFFD, because SQLite would have kept only the characters before it.
    assert.ok(messages.some((row) => row.text.includes('\uFFFD')), 'a NUL byte, replaced')
    assert.ok(!JSON.stringify(rows).includes('\u0000'), 'and no row carries a NUL')
    // AND THE COMPACTION\'S MESSAGE IS SHADOWED, because the log holds what the surface withdrew.
    assert.ok(messages.some((row) => row.shadowed === true), 'a shadowed message')
    // AND THE HARNESS SPEAKING IS `system`, and the human is `user`.
    assert.ok(messages.some((row) => row.role === 'system'), 'the harness speaking')
    assert.ok(messages.some((row) => row.role === 'user'), 'and the human')
    // AND THE INTERRUPTION IS A FACT, and its absence is null.
    assert.ok(messages.some((row) => row.interrupted === true), 'an interrupted message')
    assert.ok(messages.some((row) => row.interrupted === null), 'and one that never said')
    // AND A TOOL CALL IS EVIDENCE, with its name and its arguments.
    const call = rows.find((row) => row.kind === 'tool_call')
    assert.equal(call.name, 'bash')
    assert.match(call.args, /git push/)
})
