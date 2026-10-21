// THE ROWS, from a session log in the format.
//
// WHY THIS FILE IS NOT A COPY OF THE OBSERVER'S PRODUCER. The observer has one (`dsh-system1-observer`,
// `dsh/normalize.js`) and it reads a dsh log. This one reads ANY log in the format -- a dsh log, a pi log, whatever
// comes next -- because that is the point of the format being a floor rather than a dsh shape. What it does NOT do
// is say the rules again: every rule it obeys is imported from `system1-measure/rules`, which is the shared half.
//
// THE RULES, AND WHERE EACH ONE COMES FROM, so a reader can check that none of them was restated here:
//   * the text rule, the reasoning rule and the NUL rule -- `visibleText`, `reasoningText`, `withoutNuls`;
//   * the source rule, which is what says who spoke -- `isHumanMessage`, `sourceKindOf`;
//   * RULE 1, the ask-group -- `exchangeIndexOf`;
//   * RULE 2, the surface -- `surfaceEvents`.
//
// WHAT IS LEFT HERE, and is not a rule but a MAPPING: which record is which row, and what a row's role is.
//
// THE ROLE MAPPING, and the one judgement in this file. A `user/message` is the HUMAN only when its `source.kind`
// says so; the harness -- or pi, or an extension -- speaks on the same channel. So an injection becomes `system` here:
// it is context the agent was given, it is not an ask, and it stays in the group rather than being dropped. The
// contract has no `harness` role and does not need one: the harness speaking IS the system, and naming it that way
// keeps the evidence.
//
// ABSENCE IS `null`, NEVER `''` AND NEVER `0`. A message with no reasoning says so, and one cannot be confused with
// an answer that was genuinely empty. An `interrupted` that nobody stated is `null` too -- not `false`, which would be
// a claim ("this message was not interrupted") from a reader that never looked.

import {
    exchangeIndexOf,
    isHumanMessage,
    reasoningOf,
    surfaceEvents,
    visibleText,
    withoutNuls,
} from 'system1-measure/rules'

/** The record names of the format. */
const RECORD = Object.freeze({
    SESSION: 'session',
    USER_MESSAGE: 'user/message',
    ASSISTANT_MESSAGE: 'assistant/message',
    TOOL_CALL: 'tool/call',
    TOOL_RESULT: 'tool/result',
})

/**
 * THE ROLE OF ONE RECORD.
 *
 * @param {object} record
 * @returns {string}
 */
function roleOf(record) {
    if (record?.type === RECORD.USER_MESSAGE) return isHumanMessage(record) ? 'user' : 'system'
    if (record?.type === RECORD.ASSISTANT_MESSAGE) return 'assistant'
    if (record?.type === RECORD.TOOL_CALL) return 'tool'
    return 'assistant'
}

/**
 * THE CONTENT OF ONE MESSAGE RECORD, and WHERE IT IS: **BY THE RECORD TYPE, AND NEVER A SEARCH.** A `user/message`
 * carries `data.content`; every other message carries `data.message.content`, one level deeper. A reader that looks
 * for the content elsewhere finds text a record does not have, and a reader that resolves by type finds nothing --
 * two producers, two rows, for one record, and neither can say which is the reading. This is the same resolution
 * the observer's producer and the store's builder use, and the conformance fixture pins it.
 *
 * @param {object} record
 * @returns {unknown}
 */
function contentOf(record) {
    const content = record?.type === RECORD.USER_MESSAGE ? record?.data?.content : record?.data?.message?.content
    return Array.isArray(content) ? content : (typeof content === 'string' ? content : [])
}

/**
 * Turn a log in the format into the rows the contract describes.
 *
 * @param {object[]} records  the records, in order, header first
 * @param {object} [receipt] `{ harness, id, source, sourceBytes, sourceSha256, highWater, schemaVersion }`
 * @returns {object[]} a receipt, then one row per message and one per tool call
 */
export function toRows(records, receipt = {}) {
    const list = Array.isArray(records) ? records : []
    const onSurface = new Set(surfaceEvents(list))
    const exchangeOf = exchangeIndexOf(list)

    // THE HARNESS NAMES ITS FORMAT TOO, and the two channels must agree on that: the receipt is the anchor a
    // measurement is argued from, so the same session measured two ways must carry the same receipt.
    const header = list.find((record) => record?.type === RECORD.SESSION && Number.isInteger(record?.version))
    const named = String(receipt.harness ?? 'pi')
    const harness = header !== undefined && !named.includes(':') ? `${named}:v${header.version}` : named

    const rows = [{
        kind: 'receipt',
        harness,
        id: receipt.id ?? null,
        source: receipt.source ?? null,
        sourceBytes: Number.isFinite(receipt.sourceBytes) ? receipt.sourceBytes : null,
        sourceSha256: receipt.sourceSha256 ?? null,
        highWater: Number.isFinite(receipt.highWater) ? receipt.highWater : (list.at(-1)?.seq ?? null),
        schemaVersion: Number.isFinite(receipt.schemaVersion) ? receipt.schemaVersion : 1,
    }]

    let ordinal = 0
    for (let index = 0; index < list.length; index += 1) {
        const record = list[index]
        // THE ASK-GROUP OF THIS RECORD, by its POSITION in the stream. The index is positional on purpose: a record
        // may carry no `seq` of its own, and a window handed back by a host may be missing one, so a grouping keyed
        // on a field that is sometimes absent silently drops half the conversation.
        const exchange = exchangeOf[index] ?? 0
        if (record?.type === RECORD.TOOL_CALL) {
            // A TOOL CALL IS NOT A MESSAGE and is never counted as one. It is kept as its own row because it is
            // evidence: a question about what the agent DID needs it, and folding it into a message would make the
            // tool traffic indistinguishable from something the model said.
            rows.push({
                kind: 'tool_call',
                seq: record.seq ?? null,
                exchange,
                callId: record.data?.callId ?? record.data?.id ?? null,
                // AND THE NAME AND THE ARGUMENTS CARRY NO NUL BYTE, because the index channel would store the bytes
                // before the first one and drop the rest -- a name became an EMPTY STRING in the index where the log
                // held one, and an empty name is not a name. Measured: 2 of 201 tool calls in one session.
                name: withoutNuls(record.data?.name ?? null),
                args: withoutNuls(record.data?.arguments ?? record.data?.args ?? null),
                result: null,
                outcome: null,
            })
            continue
        }
        if (record?.type !== RECORD.USER_MESSAGE && record?.type !== RECORD.ASSISTANT_MESSAGE) continue
        const role = roleOf(record)
        // REASONING IS ITS OWN ROW-TYPE, not a field of the text. The rule is that absence is `null` -- and
        // `reasoningOf` is the rule's own form, so the absence is `null` here and not a patch afterwards.
        const reasoning = role === 'assistant' ? reasoningOf(contentOf(record)) : null
        rows.push({
            kind: 'message',
            seq: record.seq ?? null,
            exchange,
            ordinal: (ordinal += 1),
            role,
            type: 'text',
            text: visibleText(contentOf(record)),
            reasoning,
            // SHADOWED IS WHAT THE SURFACE WITHHELD. The log holds everything the session ever wrote; the model saw
            // only what survived a compaction or a context edit. A producer that defaulted this to `false` would
            // produce a session that looks complete and measures text nobody could read.
            shadowed: !onSurface.has(record),
            // AND `interrupted` IS A FACT, OR IT IS ABSENCE. `null` means nobody said.
            interrupted: typeof record.data?.interrupted === 'boolean' ? record.data.interrupted : null,
        })
    }
    return rows
}

/** The rows as JSONL text, which is the shape the instrument reads. */
export function rowsToJsonl(rows) {
    return (Array.isArray(rows) ? rows : []).map((row) => JSON.stringify(row)).join('\n') + '\n'
}
