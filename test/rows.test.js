// THE ROWS, and the rules they obey are IMPORTED rather than restated.
//
// The point of these tests is not that the rows look right -- it is that they look right for the REASONS the rules
// give, and that a break in any rule is visible here. So each test names the rule it checks.
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { toRows } from '../src/rows.js'

/** One record, of the given type, with the given data. */
const record = (type, seq, data, extra = {}) => ({ type, seq, time: seq, data, ...extra })

/** The rows, without the receipt -- the receipt names what was read, and it is not part of a rule. */
const rowsOf = (records) => toRows(records, {
    harness: 'pi', id: 'x', source: 'x', sourceBytes: 1, sourceSha256: '0'.repeat(64), highWater: 99,
}).filter((row) => row.kind !== 'receipt')

test('THE HUMAN IS `user` AND THE HARNESS IS `system`, because the RECORD TYPE does not say who spoke', () => {
    const rows = rowsOf([
        record('user/message', 1, { content: [{ type: 'text', text: 'the question' }], source: { kind: 'user' } }),
        record('user/message', 2, { content: [{ type: 'text', text: 'a goal' }], source: { kind: 'goal' } }),
    ])
    assert.equal(rows[0].role, 'user', 'the human')
    assert.equal(rows[1].role, 'system', 'and the harness speaking on the same channel')
})

test('THE ASK-GROUP IS DERIVED FROM WHERE THE HUMAN SPOKE, and an injection does not open one', () => {
    const rows = rowsOf([
        record('user/message', 1, { content: [{ type: 'text', text: 'one' }], source: { kind: 'user' } }),
        record('user/message', 2, { content: [{ type: 'text', text: 'a goal' }], source: { kind: 'goal' } }),
        record('assistant/message', 3, { message: { content: [{ type: 'text', text: 'ok' }] } }),
        record('user/message', 4, { content: [{ type: 'text', text: 'two' }], source: { kind: 'user' } }),
        record('assistant/message', 5, { message: { content: [{ type: 'text', text: 'ok' }] } }),
    ])
    assert.deepEqual(rows.map((row) => row.exchange), [0, 0, 0, 1, 1], 'the injection joins the group the human opened')
})

test('ONLY A `text` BLOCK IS TEXT, and the reasoning is never in it', () => {
    const rows = rowsOf([
        record('assistant/message', 1, { message: { content: [
            { type: 'reasoning', text: 'the thinking' },
            { type: 'text', text: 'the answer' },
        ] } }),
    ])
    assert.equal(rows[0].text, 'the answer')
    assert.equal(rows[0].reasoning, 'the thinking', 'and the reasoning is its own field, not folded into the text')
})

test('A MESSAGE WITH NO REASONING SAYS SO, with `null` and never with an empty string', () => {
    const rows = rowsOf([
        record('assistant/message', 1, { message: { content: [{ type: 'text', text: 'ok' }] } }),
    ])
    assert.equal(rows[0].reasoning, null)
    assert.ok('reasoning' in rows[0], 'and the field is present, because an absent key is not the same fact')
})

test('THE TEXT IS TRIMMED, and so is the reasoning, because the two channels must read the same text', () => {
    const rows = rowsOf([
        record('assistant/message', 1, { message: { content: [
            { type: 'text', text: '  padded  ' },
            { type: 'reasoning', text: '  thought  ' },
        ] } }),
    ])
    assert.equal(rows[0].text, 'padded')
    assert.equal(rows[0].reasoning, 'thought')
})

test('A NUL BYTE BECOMES U+FFFD, AND KEEPS THE LENGTH', () => {
    const rows = rowsOf([
        record('user/message', 1, { content: [{ type: 'text', text: 'a\u0000b' }], source: { kind: 'user' } }),
    ])
    assert.equal(rows[0].text, 'a\uFFFDb')
    assert.equal(rows[0].text.length, 3, 'the marked text is the same MEASUREMENT, not a shorter one')
})

test('`interrupted` IS A FACT OR IT IS ABSENCE, and `false` would be a claim', () => {
    const rows = rowsOf([
        record('assistant/message', 1, { message: { content: [{ type: 'text', text: 'a' }] } }),
        record('assistant/message', 2, { interrupted: true, message: { content: [{ type: 'text', text: 'b' }] } }),
    ])
    assert.equal(rows[0].interrupted, null, 'nobody said, so it is null')
    assert.equal(rows[1].interrupted, true)
})

test('A MESSAGE THE SURFACE WITHDREW IS `shadowed`, and one the model could see is not', () => {
    const rows = rowsOf([
        record('user/message', 1, { content: [{ type: 'text', text: 'old' }], source: { kind: 'user' } }),
        record('user/message', 2, { content: [{ type: 'text', text: 'summary' }], source: { kind: 'compact-checkpoint' } },
            { surfaceOp: { op: 'replace', startSeq: 1, endSeq: 1 } }),
    ])
    assert.equal(rows[0].shadowed, true, 'the model could not see it')
    assert.equal(rows[1].shadowed, false, 'and the replacement could')
})

test('A TOOL CALL IS ITS OWN ROW, with its name and its arguments, and it is not a message', () => {
    const rows = rowsOf([
        record('tool/call', 1, { callId: 'c1', name: 'bash', arguments: '{"cmd":"ls"}' }),
    ])
    assert.equal(rows.length, 1)
    assert.equal(rows[0].kind, 'tool_call')
    assert.equal(rows[0].name, 'bash')
    assert.equal(rows[0].args, '{"cmd":"ls"}')
    assert.equal(rows[0].result, null)
    assert.equal(rows[0].outcome, null)
})

test('A TOOL RESULT IS NOT A ROW, because a result is the answer to a call and the call is the evidence', () => {
    const rows = rowsOf([
        record('tool/call', 1, { callId: 'c1', name: 'bash', arguments: '{}' }),
        record('tool/result', 2, { callId: 'c1', message: { role: 'tool', toolCallId: 'c1', content: [{ type: 'text', text: 'ok' }] } }),
    ])
    assert.equal(rows.length, 1)
    assert.equal(rows[0].kind, 'tool_call')
})

test('NO ROW CARRIES A NATIVE `turn`, because the boundary is the ask-group', () => {
    const rows = rowsOf([
        record('user/message', 1, { turn: 7, content: [{ type: 'text', text: 'a' }], source: { kind: 'user' } }),
    ])
    assert.ok(!('turn' in rows[0]), 'a native turn is refused rather than ignored')
})
