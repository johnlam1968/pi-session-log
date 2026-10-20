// THE EXTENSION, and the parts of it that touch pi.
//
// WHY THE EXTENSION IS TESTED AT ALL, and why it is tested with a FAKE `pi` rather than a real one. The extension is
// the deliverable: it is what a pi user loads. A unit test that drives it with a fake `ExtensionAPI` proves the
// wiring -- which event writes, which flag chooses the root, what happens when the session manager is absent -- and
// a REAL pi run proves the rest, which is `docs/measurement.md`'s receipt: a live pi, a real prompt, a real model
// answer, and the two files on disk.
//
// WHAT MUST NOT HAPPEN, and is asserted here: a failure inside the extension must NOT throw into pi's loop. An
// extension that stops the agent it is measuring has changed the thing it measured.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import sessionLogExtension, { DEFAULT_ROOT, pathsFor, slugOf } from '../extensions/session-log.js'

/** A scratch directory, and a way to take it away again. */
const scratch = async () => mkdtemp(join(tmpdir(), 'pi-session-log-'))
const cleanup = async (root) => { await rm(root, { recursive: true, force: true }) }

/** pi's session entries, as pi writes them. */
const entries = () => [
    { type: 'message', id: 'a', parentId: null, timestamp: '2026-08-20T17:41:05.100Z', message: { role: 'user', content: 'the ask' } },
    { type: 'message', id: 'b', parentId: 'a', timestamp: '2026-08-20T17:41:09.200Z', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'hmm' }, { type: 'text', text: 'the answer' }] } },
]

/** pi's session header. */
const header = () => ({ type: 'session', version: 3, id: 'pi-1', timestamp: '2026-08-20T17:41:00.907Z', cwd: '/tmp/x' })

/** A FAKE `pi`, and the handlers it collected. */
function fakePi({ flag = null } = {}) {
    const handlers = new Map()
    const commands = new Map()
    return {
        handlers,
        commands,
        registerFlag: (name, options) => { handlers.set(`flag:${name}`, options) },
        getFlag: (name) => (name === 'session-log-dir' ? flag : null),
        on: (name, handler) => { handlers.set(name, handler) },
        registerCommand: (name, options) => { commands.set(name, options) },
    }
}

/** A FAKE `ctx`, and the session manager it carries. The session FILE is real, because that is where the extension
 *  reads the header -- and the header is where the working directory comes from. */
function fakeCtx({ sessionId = 'pi-1', file = null, entries: list = entries(), leaf = undefined, throws = false, noManager = false } = {}) {
    if (file === null && !throws && !noManager) {
        file = join(mkdtempSync(join(tmpdir(), 'pi-session-file-')), 'session.jsonl')
        writeFileSync(file, JSON.stringify(header()) + '\n')
    }
    return {
        sessionManager: noManager ? undefined : (throws
            ? { getEntries: () => { throw new Error('the session manager is unavailable') } }
            : {
                getEntries: () => list,
                getSessionFile: () => file,
                getSessionId: () => sessionId,
                getLeafEntry: () => leaf,
            }),
        ui: { notify: () => {} },
    }
}

test('THE SLUG IS PI\'S OWN CONVENTION, so the two corpora are walked the same way', () => {
    assert.equal(slugOf('/home/john/.penguin'), '--home-john-.penguin--')
    assert.equal(slugOf('/home/john/CodingProjects/option_finder'), '--home-john-CodingProjects-option_finder--')
    assert.equal(slugOf('/'), '--root--', 'and the root is a name rather than an empty path')
})

test('THE FILES GO WHERE THE DSH CORPUS PUTS ITS OWN, so the same store reads them', () => {
    const paths = pathsFor('/corpus', '/home/john/.penguin', 'session-1')
    assert.equal(paths.dir, '/corpus/--home-john-.penguin--/session-1')
    assert.equal(paths.log, '/corpus/--home-john-.penguin--/session-1/session.v4.jsonl')
    assert.equal(paths.rows, '/corpus/--home-john-.penguin--/session-1/rows.jsonl')
})

test('A SESSION IS WRITTEN DOWN, and the receipt names the bytes that were written', async () => {
    const root = await scratch()
    try {
        const { writeSession } = await import('../extensions/session-log.js')
        const result = await writeSession({
            root,
            cwd: '/tmp/x',
            sessionId: 'pi-1',
            entries: entries(),
            header: header(),
        })
        assert.equal(result.records, 3, 'a header, an ask and an answer')
        assert.equal(result.rowCount, 3, 'a receipt and two messages')

        // THE LOG IS THE FORMAT: a header with `id`, `createdAt` and `cwd` at the TOP LEVEL, and a version that is
        // the FORMAT's and not pi's own session-file version.
        const log = (await readFile(result.log, 'utf8')).split('\n').filter(Boolean).map((line) => JSON.parse(line))
        assert.equal(log[0].type, 'session')
        assert.equal(log[0].version, 4, "the format's version, not pi's")
        assert.equal(log[0].id, 'pi-1')
        assert.equal(log[0].cwd, '/tmp/x')
        assert.ok(log[0].createdAt > 0, 'and the session does not claim the epoch')
        assert.equal(log[1].data.source.kind, 'user', 'the ask is the human')
        assert.deepEqual(log[2].data.message.content, [
            { type: 'reasoning', text: 'hmm' },
            { type: 'text', text: 'the answer' },
        ])

        // THE RECEIPT NAMES THE FILE, ITS SIZE AND ITS DIGEST, because a measurement that cannot name the evidence
        // it read cannot be reproduced or argued with.
        const rows = (await readFile(result.rows, 'utf8')).split('\n').filter(Boolean).map((line) => JSON.parse(line))
        const receipt = rows.find((row) => row.kind === 'receipt')
        assert.equal(receipt.harness, 'pi:v4')
        assert.equal(receipt.source, result.log)
        assert.equal(receipt.sourceBytes, Buffer.byteLength((await readFile(result.log, 'utf8')), 'utf8'))
        assert.match(receipt.sourceSha256, /^[0-9a-f]{64}$/)
        assert.equal(rows.filter((row) => row.kind === 'message').length, 2)
    } finally {
        await cleanup(root)
    }
})

test('THE EXTENSION WRITES ON SETTLE, ON SHUTDOWN, AND ON THE COMMAND', async () => {
    const root = await scratch()
    try {
        const pi = fakePi({ flag: root })
        sessionLogExtension(pi)
        // THE THREE POINTS, and the flag and the command are registered.
        assert.ok(pi.handlers.has('agent_settled'), 'the agent settling writes')
        assert.ok(pi.handlers.has('session_shutdown'), 'the session shutting down writes')
        assert.ok(pi.commands.has('session-log'), 'and a command writes on demand')
        assert.ok(pi.handlers.has('flag:session-log-dir'), 'and the root is a flag')

        const ctx = fakeCtx()
        for (const point of ['agent_settled', 'session_shutdown']) {
            await pi.handlers.get(point)({}, ctx)
        }
        const paths = pathsFor(root, '/tmp/x', 'pi-1')
        const log = await readFile(paths.log, 'utf8')
        assert.ok(log.includes('the ask'), 'and the ask is in the log')
        const rows = await readFile(paths.rows, 'utf8')
        assert.ok(rows.includes('the answer'), 'and the answer is in the rows')
    } finally {
        await cleanup(root)
    }
})

test('A FAILURE IN THE EXTENSION MUST NOT THROW INTO PI\'S LOOP', async () => {
    const root = await scratch()
    try {
        const pi = fakePi({ flag: root })
        sessionLogExtension(pi)
        // THE SESSION MANAGER THROWS. The extension swallows it: an extension that stops the agent it is measuring has
        // changed the thing it measured.
        const result = await pi.handlers.get('agent_settled')({}, fakeCtx({ throws: true }))
        assert.equal(result, undefined, 'and it says nothing, rather than failing the turn')
    } finally {
        await cleanup(root)
    }
})

test('THE DEFAULT ROOT IS PI\'S OWN DIRECTORY, and the environment can move it', async () => {
    assert.ok(DEFAULT_ROOT.endsWith('/.pi/session-logs'), 'the default is under pi\x27s own directory')
    const previous = process.env.PI_SESSION_LOG_DIR
    const root = await scratch()
    try {
        process.env.PI_SESSION_LOG_DIR = root
        const pi = fakePi()
        sessionLogExtension(pi)
        await pi.handlers.get('agent_settled')({}, fakeCtx())
        const paths = pathsFor(root, '/tmp/x', 'pi-1')
        assert.ok((await readFile(paths.log, 'utf8')).includes('the ask'), 'and the environment chooses the root')
    } finally {
        if (previous === undefined) delete process.env.PI_SESSION_LOG_DIR
        else process.env.PI_SESSION_LOG_DIR = previous
        await cleanup(root)
    }
})

test('THE HEADER IS READ FROM PI\'S OWN FILE, and a file that says nothing useful is not a header', async () => {
    const root = await scratch()
    const files = await scratch()
    try {
        const pi = fakePi({ flag: root })
        sessionLogExtension(pi)

        // A SESSION FILE THAT IS NOT THERE: the extension carries on with the working directory it is in, and
        // writes the session under THAT slug -- the file is where the cwd comes from, and without it the cwd is
        // where pi is running.
        await pi.handlers.get('agent_settled')({}, fakeCtx({ file: join(files, 'absent.jsonl') }))
        const written = pathsFor(root, process.cwd(), 'pi-1')
        assert.ok((await readFile(written.log, 'utf8')).includes('the ask'), 'and it still writes something')

        // A SESSION FILE WHOSE FIRST LINE IS NOT A HEADER: same.
        const junk = join(files, 'junk.jsonl')
        writeFileSync(junk, 'not json at all\n')
        await pi.handlers.get('agent_settled')({}, fakeCtx({ file: junk }))
        assert.ok((await readFile(written.log, 'utf8')).includes('the ask'), 'and it still writes something')

        // A SESSION FILE WHOSE FIRST LINE IS NOT A `session` RECORD: same.
        const other = join(files, 'other.jsonl')
        writeFileSync(other, JSON.stringify({ type: 'message', id: 'x' }) + '\n')
        await pi.handlers.get('agent_settled')({}, fakeCtx({ file: other }))
        assert.ok((await readFile(written.log, 'utf8')).includes('the ask'), 'and it still writes something')

        // AND A DEPLOYMENT WITH NO SESSION MANAGER AT ALL: the extension says nothing and writes nothing.
        await pi.handlers.get('agent_settled')({}, fakeCtx({ noManager: true }))
        assert.ok((await readFile(written.log, 'utf8')).includes('the ask'), 'and the LAST session written is the one it could write')
    } finally {
        await cleanup(root)
        await cleanup(files)
    }
})

test('THE COMMAND SAYS WHAT IT DID, AND SAYS WHEN IT DID NOTHING', async () => {
    const root = await scratch()
    try {
        const pi = fakePi({ flag: root })
        sessionLogExtension(pi)
        const notices = []
        const ctx = { ...fakeCtx(), ui: { notify: (message, kind) => notices.push(`${kind}: ${message}`) } }

        await pi.commands.get('session-log').handler('', ctx)
        assert.ok(notices.some((n) => n.startsWith('info: session-log:')), 'and it says what it wrote')

        const empty = { ...fakeCtx({ noManager: true }), ui: { notify: (message, kind) => notices.push(`${kind}: ${message}`) } }
        await pi.commands.get('session-log').handler('', empty)
        assert.ok(notices.some((n) => n.startsWith('error:')), 'and it says when it wrote nothing')
    } finally {
        await cleanup(root)
    }
})
