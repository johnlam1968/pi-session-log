// THE MAPPER, against a session that holds every case the corpus holds.
//
// WHY A SYNTHETIC SESSION AND NOT THE CORPUS. A corpus is not a GATE: it lives on one machine, it changes under you,
// and a test that needs 224 sessions and a provider key is a test nobody runs. So the CASES are written down here, and
// the corpus is the MEASUREMENT -- `docs/measurement.md` holds what 224 real sessions produced.
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { livePath, parseSession, producerKindOf, toMillis, toSessionLog } from '../src/pi-log.js'

/** A pi session, as pi writes it: a header and then entries. */
const session = (entries, header = {}) => [
    JSON.stringify({ type: 'session', version: 3, id: 'pi-1', timestamp: 1000, cwd: '/tmp/x', ...header }),
    ...entries.map((entry) => JSON.stringify(entry)),
].join('\n')

const message = (id, parentId, role, content, extra = {}) => ({
    type: 'message', id, parentId, timestamp: 1000, message: { role, content, ...extra },
})

test('A FILE THAT IS NOT JSON IS COUNTED, never dropped silently', () => {
    const { header, entries, unparseable } = parseSession([
        '{"type":"session","version":3,"id":"pi-1","timestamp":1000,"cwd":"/tmp/x"}',
        'not json at all',
        '{"type":"message","id":"a","parentId":null,"timestamp":1,"message":{"role":"user","content":"hi"}}',
        '{"type":"message","id":"b",',
    ].join('\n'))
    assert.equal(header.id, 'pi-1')
    assert.equal(entries.length, 1)
    assert.equal(unparseable, 2, 'two lines were not JSON')
})

test('THE LIVE BRANCH IS THE LEAF PATH, and what is off it is counted', () => {
    // Two branches off one root: `a` continues to `b`, and `c` is a sibling that never happened.
    const entries = [
        { type: 'message', id: 'root', parentId: null },
        { type: 'message', id: 'a', parentId: 'root' },
        { type: 'message', id: 'b', parentId: 'a' },
        { type: 'message', id: 'c', parentId: 'root' },
    ]
    const path = livePath(entries, entries[2])
    assert.deepEqual(path.entries.map((e) => e.id), ['root', 'a', 'b'], 'the leaf path, oldest first')
    assert.deepEqual(path.offPath.map((e) => e.id), ['c'], 'and the branch that was not taken is counted, not merged')
    // A `parentId` that names no entry ENDS THE WALK rather than throwing: a truncated file is a real state for a log
    // that is being written right now.
    const truncated = livePath([{ type: 'message', id: 'x', parentId: 'gone' }])
    assert.deepEqual(truncated.entries.map((e) => e.id), ['x'])
})

test('THE HEADER IS THE FORMAT\'S, and pi\'s own version is not written into it', () => {
    const { header, entries } = parseSession(session([
        message('a', null, 'user', 'hello'),
    ]))
    const { records } = toSessionLog(entries, { header })
    assert.deepEqual(records[0], {
        type: 'session',
        version: 4,
        id: 'pi-1',
        createdAt: 1000,
        cwd: '/tmp/x',
    })
    // pi's session files are version 3. The format is version 4, and the two are different things: writing pi's
    // number into the format's `version` would make a reader think this is a v3 log.
    assert.notEqual(records[0].version, header.version)
})

test('A HUMAN ASK IS A `user/message` WITH THE HUMAN\'S KIND, and it opens a group', () => {
    const { header, entries } = parseSession(session([
        message('a', null, 'user', 'do the thing'),
    ]))
    const { records, facts } = toSessionLog(entries, { header })
    const ask = records.find((r) => r.type === 'user/message')
    assert.equal(ask.data.source.kind, 'user')
    assert.equal(ask.data.role, 'user')
    assert.deepEqual(ask.data.content, [{ type: 'text', text: 'do the thing' }])
    assert.equal(facts.operatorAsks, 1)
})

test('AN INJECTION IS IN THE LOG AND OUT OF THE ASKS, and its kind names the extension', () => {
    const { header, entries } = parseSession(session([
        message('a', null, 'user', 'the human asks'),
        { type: 'custom_message', id: 'b', parentId: 'a', timestamp: 1001, customType: 'subagent-notify', content: 'a subagent finished', display: true },
    ]))
    const { records, facts } = toSessionLog(entries, { header })
    const injection = records.find((r) => r.type === 'user/message' && r.data.source.kind !== 'user')
    assert.equal(injection.data.source.kind, 'pi-subagent-notify', 'the kind is named after the producer')
    assert.equal(facts.injectedMessages, 1)
    assert.equal(facts.operatorAsks, 1, 'and it is not an ask')
    // AND THE KIND IS KEBAB-CASE, the way the harness\'s own kinds are.
    assert.equal(producerKindOf('Subagent Notify'), 'pi-subagent-notify')
    assert.equal(producerKindOf(''), 'pi-extension', 'and an extension with no name falls back rather than vanishing')
})

test('PI\'S `thinking` BECOMES A `reasoning` BLOCK, under a different field name', () => {
    const { header, entries } = parseSession(session([
        message('a', null, 'user', 'go'),
        message('b', 'a', 'assistant', [
            { type: 'thinking', thinking: 'hmm' },
            { type: 'text', text: 'done' },
        ]),
    ]))
    const { records, facts } = toSessionLog(entries, { header })
    const answer = records.find((r) => r.type === 'assistant/message')
    assert.deepEqual(answer.data.message.content, [
        { type: 'reasoning', text: 'hmm' },
        { type: 'text', text: 'done' },
    ])
    // THE REASONING IS NOT TEXT, and a reader that took `.text` from any block would hand the model its own thinking
    // as though the operator had typed it.
    assert.equal(answer.data.message.content[0].type, 'reasoning')
    assert.equal(answer.data.message.content[0].text, 'hmm')
    assert.equal(facts.assistantMessages, 1)
})

test('THERE ARE NO TURNS. A SUBSTRATE THAT HAS NONE MUST NOT INVENT THEM', () => {
    const { header, entries } = parseSession(session([
        message('a', null, 'user', 'one'),
        message('b', 'a', 'assistant', 'ok'),
        message('c', 'b', 'user', 'two'),
        message('d', 'c', 'assistant', 'ok'),
    ]))
    const { records } = toSessionLog(entries, { header })
    const text = JSON.stringify(records)
    assert.ok(!text.includes('"turn"'), 'no record carries a turn')
    assert.ok(!text.includes('turn/start'), 'and no turn boundaries')
    // THE ASK-GROUP IS DERIVED, and it is what a producer reads the log for.
    assert.equal(records.filter((r) => r.type === 'user/message').length, 2, 'two asks')
})

test('A TOOL CALL IS EVIDENCE, and it is NOT a message', () => {
    const { header, entries } = parseSession(session([
        message('a', null, 'user', 'go'),
        message('b', 'a', 'assistant', [{ type: 'toolCall', id: 'c1', name: 'read', arguments: { path: '/x' } }]),
        message('c', 'b', 'toolResult', [{ type: 'text', text: 'the file' }], { toolCallId: 'c1', isError: false }),
    ]))
    const { records, facts } = toSessionLog(entries, { header })
    const call = records.find((r) => r.type === 'tool/call')
    assert.equal(call.data.callId, 'c1')
    assert.equal(call.data.name, 'read')
    assert.equal(call.data.arguments, '{"path":"/x"}', 'the arguments are a JSON STRING, because that is what the format carries')
    // AND THE ADVERTISED BLOCK MATCHES THE CALL, by name and by arguments: a validator compares them.
    const answer = records.find((r) => r.type === 'assistant/message')
    const advertised = answer.data.message.content.find((b) => b.type === 'tool-call')
    assert.equal(advertised.name, call.data.name)
    assert.equal(advertised.arguments, call.data.arguments)
    // AND THE RESULT IS ITS OWN RECORD, with the call id in the two places the format says it lives.
    const result = records.find((r) => r.type === 'tool/result')
    assert.equal(result.data.callId, 'c1')
    assert.equal(result.data.message.toolCallId, 'c1')
    assert.equal(facts.toolCalls, 1)
    assert.equal(facts.toolResults, 1)
})

test('AN UNRESOLVED CALL IS LEFT OUT OF THE BLOCK AND COUNTED, never faked', () => {
    const { header, entries } = parseSession(session([
        message('a', null, 'user', 'go'),
        message('b', 'a', 'assistant', [{ type: 'toolCall', id: 'c1', name: 'read', arguments: {} }]),
    ]))
    const { records, facts } = toSessionLog(entries, { header })
    const answer = records.find((r) => r.type === 'assistant/message')
    assert.equal(answer.data.message.content.filter((b) => b.type === 'tool-call').length, 0, 'the block is left out')
    assert.equal(records.filter((r) => r.type === 'tool/call').length, 0, 'and so is the call')
    assert.equal(facts.unresolvedCalls, 1, 'and the count is the receipt')
})

test('A RESULT WITH NO CALL IS COUNTED, never matched to whatever came before it', () => {
    const { header, entries } = parseSession(session([
        message('a', null, 'user', 'go'),
        message('b', 'a', 'toolResult', [{ type: 'text', text: 'orphan' }], { toolCallId: 'nobody', isError: false }),
    ]))
    const { records, facts } = toSessionLog(entries, { header })
    assert.equal(records.filter((r) => r.type === 'tool/result').length, 0)
    assert.equal(facts.orphanResults, 1)
})

test('A COMPACTION WITHDRAWS WHAT IT REPLACED, and says so with a `surfaceOp`', () => {
    const { header, entries } = parseSession(session([
        message('a', null, 'user', 'the early question'),
        message('b', 'a', 'assistant', 'the early answer'),
        { type: 'compaction', id: 'c', parentId: 'b', timestamp: 1002, summary: 'a summary of the above', firstKeptEntryId: 'b' },
    ]))
    const { records, facts } = toSessionLog(entries, { header })
    const compaction = records.find((r) => r.data?.source?.kind === 'compact-checkpoint')
    assert.ok(compaction !== undefined, 'the compaction is in the log')
    assert.deepEqual(compaction.data.content, [{ type: 'text', text: 'a summary of the above' }])
    // THE RANGE IS INCLUSIVE AND THE COMPACTION\'S OWN RECORD SITS OUTSIDE IT, which is what makes the summary the
    // surfaced message rather than a casualty of its own replacement.
    assert.deepEqual(compaction.surfaceOp, { op: 'replace', startSeq: 0, endSeq: 0 })
    assert.ok(compaction.seq > compaction.surfaceOp.endSeq)
    assert.equal(facts.compactions, 1)
})

test('A CONTEXT EDIT WITHDRAWS ITS TARGET, and the replacement is null in every one in the corpus', () => {
    const { header, entries } = parseSession(session([
        message('a', null, 'user', 'the early question'),
        { type: 'context_edit', id: 'c', parentId: 'a', timestamp: 1002, targetId: 'a', replacement: null },
    ]))
    const { records, facts } = toSessionLog(entries, { header })
    const edit = records.find((r) => r.data?.source?.kind === 'pi-context-edit')
    assert.ok(edit !== undefined)
    assert.deepEqual(edit.surfaceOp, { op: 'replace', startSeq: 0, endSeq: 0 })
    assert.equal(facts.contextEdits, 1)
})

test('AN INTERRUPTION IS STATED WHEN IT HAPPENED, AND ABSENT OTHERWISE', () => {
    const { header, entries } = parseSession(session([
        message('a', null, 'user', 'go'),
        message('b', 'a', 'assistant', 'cut off', { stopReason: 'aborted' }),
        message('c', 'b', 'assistant', 'finished', { stopReason: 'stop' }),
    ]))
    const { records } = toSessionLog(entries, { header })
    const answers = records.filter((r) => r.type === 'assistant/message')
    assert.equal(answers[0].data.interrupted, true, 'pi\'s `aborted` is the format\'s `interrupted`')
    assert.ok(!('interrupted' in answers[1].data), 'and a message that was not interrupted says NOTHING, because `false` would be a claim')
})

test('THE LOSSES ARE COUNTED, not absorbed', () => {
    const { header, entries } = parseSession(session([
        message('a', null, 'user', [{ type: 'text', text: 'look' }, { type: 'image', data: 'AAAA', mimeType: 'image/png' }]),
        message('b', 'a', 'bashExecution', null, { command: 'ls', output: 'x', exitCode: 0 }),
        message('c', 'b', 'system', 'a prompt section', { sections: [] }),
        { type: 'model_change', id: 'd', parentId: 'c', timestamp: 1003, provider: 'x', modelId: 'y' },
        { type: 'thinking_level_change', id: 'e', parentId: 'd', timestamp: 1003, thinkingLevel: 'high' },
        { type: 'custom', id: 'f', parentId: 'e', timestamp: 1003, customType: 'x', data: {} },
    ]))
    const { records, facts } = toSessionLog(entries, { header })
    assert.equal(facts.imagesNotCarried, 1, 'the picture is counted even though its bytes are not carried')
    assert.equal(facts.bashExecutions, 1, 'a `!` command has no call id, so there is no honest pairing')
    assert.equal(facts.systemMessages, 1, 'a prompt section is not a message')
    assert.equal(facts.modelChanges, 1)
    assert.equal(facts.thinkingLevelChanges, 1)
    assert.equal(facts.customEntries, 1)
    // AND THE IMAGE BLOCK ITSELF SURVIVES, so the count of pictures is in the log and not only in the facts.
    const ask = records.find((r) => r.type === 'user/message')
    assert.ok(ask.data.content.some((b) => b.type === 'image'), 'the block type is kept, and the bytes are not')
})

test('A TITLE IS A `session/title`, with an empty `messageSeqs`', () => {
    const { header, entries } = parseSession(session([
        message('a', null, 'user', 'go'),
        { type: 'session_info', id: 'b', parentId: 'a', timestamp: 1002, name: 'The session name' },
    ]))
    const { records, facts } = toSessionLog(entries, { header })
    const title = records.find((r) => r.type === 'session/title')
    assert.equal(title.data.title, 'The session name')
    assert.deepEqual(title.data.messageSeqs, [])
    assert.equal(facts.titles, 1)
})

test('PI WRITES ITS TIMESTAMPS AS ISO STRINGS, and the format wants MILLISECONDS', () => {
    // MEASURED: a pi entry's `timestamp` is an ISO string, 24 characters, and so is the session header's. A reader
    // that asks `Number.isFinite(entry.timestamp)` gets false for EVERY entry in the corpus and falls back to the
    // epoch -- and a log whose every record claims the session happened at the epoch cannot be ordered against
    // anything, or against another session.
    const { header, entries } = parseSession([
        JSON.stringify({ type: 'session', version: 3, id: 'pi-1', timestamp: '2026-08-20T17:41:00.907Z', cwd: '/tmp/x' }),
        JSON.stringify({ type: 'message', id: 'a', parentId: null, timestamp: '2026-08-20T17:41:05.100Z', message: { role: 'user', content: 'hi' } }),
    ].join('\n'))
    const { records } = toSessionLog(entries, { header })
    assert.equal(records[0].createdAt, Date.parse('2026-08-20T17:41:00.907Z'), 'the header\'s own timestamp is the session\'s start')
    assert.equal(records[1].time, Date.parse('2026-08-20T17:41:05.100Z'), 'and a record carries the moment it happened')
    assert.notEqual(records[0].createdAt, 0, 'and nothing claims the epoch')
})

test('THE EDGES ARE COUNTED, not crashed on', () => {
    // A LINE THAT IS JSON BUT NOT AN OBJECT is not a record, and it is counted with the malformed ones.
    const counted = parseSession(['123', 'null', '"a string"', '{"type":"message","id":"a","parentId":null,"timestamp":1,"message":{"role":"user","content":"hi"}}'].join('\n'))
    assert.equal(counted.unparseable, 3, 'three lines were not records')
    assert.equal(counted.entries.length, 1)
})

test('A TIMESTAMP THAT IS NOT A TIMESTAMP IS NULL, and not the epoch', () => {
    assert.equal(toMillis('not a date'), null)
    assert.equal(toMillis(undefined), null)
    assert.equal(toMillis(null), null)
    assert.equal(toMillis(1700000000000), 1700000000000, 'a number is already milliseconds')
})

test('AN ENTRY TYPE THIS IMPLEMENTATION DOES NOT KNOW IS COUNTED, and never a crash', () => {
    const { header, entries } = parseSession(session([
        { type: 'a_type_from_the_future', id: 'a', parentId: null, timestamp: 1000 },
    ]))
    const { records } = toSessionLog(entries, { header })
    assert.equal(records.length, 1, 'only the header')
})

test('THE USAGE IS CARRIED, in the format\'s own field names', () => {
    const { header, entries } = parseSession(session([
        message('a', null, 'user', 'go'),
        message('b', 'a', 'assistant', 'done', {
            usage: { input: 10, output: 20, cacheRead: 30, cacheWrite: 40, totalTokens: 100, cost: { total: 0.5 } },
        }),
    ]))
    const { records } = toSessionLog(entries, { header })
    const answer = records.find((r) => r.type === 'assistant/message')
    assert.deepEqual(answer.data.usage, {
        inputTokens: 10,
        outputTokens: 20,
        cacheReadTokens: 30,
        cacheWriteTokens: 40,
        totalTokens: 100,
    })
})
