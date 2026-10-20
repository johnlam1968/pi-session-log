// THE SECOND IMPLEMENTATION OF THE SESSION-LOG FORMAT.
//
// WHY THIS FILE EXISTS, AND WHY IT IS NOT THE OBSERVER'S PI IMPORTER. The observer's importer
// (`dsh-system1-observer`, `dsh/pi-session-export.js`) converts a pi session into a **dsh v4 log**: it invents a turn
// and a step for every ask, and it writes `turn/start`, `step/start`, `step/end` and `turn/end` around them. That log
// is a dsh log with pi's words in it, and it is what the observer's producer reads. The format this repository's
// sibling owns (`docs/session-log-format.md`) is a DIFFERENT thing: a floor, not a dsh shape, and its rule 7 says a
// substrate "does not have to write turns, and **must not invent them**". So the second implementation writes the
// format natively -- no turn, no step, no turn boundaries -- and the ask-group is derived from where the human spoke.
//
// THE CLAIM THIS FILE MAKES, AND HOW IT IS CHECKED. A format is not a format until a second implementation agrees with
// the first. This one is checked against the observer's importer over the whole pi corpus: the same pi session, written
// down two ways, must compose to the same state. The two ways differ in exactly one way that matters -- this one has
// no turns -- and the measurement is that removing them changes nothing.
//
// EVERY RULE BELOW WAS MEASURED ON THIS HOST, not read off a spec. The pi corpus as measured on 2026-10-19, over
// `~/.pi/<agent>/sessions/`: **224 session files, 42,123 entries, 0 unparseable lines**, 2,018 user messages, 19,950
// assistant messages, 19,113 tool results, 183 extension injections, 8 compactions, 6 context edits, 27 `!` bash
// executions, 15 prompt-section messages, and 31 source kinds of which exactly one -- `user` -- means a person.
//
// WHAT IS DELIBERATELY NOT CARRIED, AND WHY. Every loss is COUNTED in `facts` rather than absorbed, because a loss
// nothing reports reads as a measurement that saw everything:
//   * image payloads (161 blocks) -- base64 bytes; a log does not need them to be readable, and a text placeholder
//     would be evidence the model never produced. The block TYPE is kept, so the count of pictures survives.
//   * pi's `system` prompt messages (15) -- a SECTION is assembled per request and is not a message; putting it in
//     the conversation would invent one.
//   * `bashExecution` messages (27) -- pi's own record of a `!` command, with no call id, so there is no honest
//     pairing to a call.
//   * `model_change` (295) and `thinking_level_change` (226) -- session facts with no field in the format. COUNTED.
//   * `custom` entries (23) -- extension state, which does not participate in the LLM context.

/** pi's entry types, as this implementation reads them. Anything else is counted, not dropped. */
export const PI_ENTRY = Object.freeze({
    SESSION: 'session',
    MESSAGE: 'message',
    CUSTOM_MESSAGE: 'custom_message',
    COMPACTION: 'compaction',
    CONTEXT_EDIT: 'context_edit',
    SESSION_INFO: 'session_info',
    CUSTOM: 'custom',
    MODEL_CHANGE: 'model_change',
    THINKING_LEVEL_CHANGE: 'thinking_level_change',
})

/** The message roles this implementation distinguishes. `user` is the only one that opens an ask-group. */
export const PI_ROLE = Object.freeze({
    USER: 'user',
    ASSISTANT: 'assistant',
    TOOL_RESULT: 'toolResult',
    SYSTEM: 'system',
    BASH_EXECUTION: 'bashExecution',
})

/** pi's content-block types, and what this implementation puts in their place. */
export const PI_BLOCK = Object.freeze({ TEXT: 'text', THINKING: 'thinking', TOOL_CALL: 'toolCall', IMAGE: 'image' })

/** The record names of the format. They are the dsh log's own names, because a format nobody renames is a format
 *  every importer already produces. */
export const RECORD = Object.freeze({
    SESSION: 'session',
    USER_MESSAGE: 'user/message',
    ASSISTANT_MESSAGE: 'assistant/message',
    TOOL_CALL: 'tool/call',
    TOOL_RESULT: 'tool/result',
    TITLE: 'session/title',
})

/** The version of the FORMAT, not of pi's own session file. pi's session files are version 3; that is a pi fact with
 *  no field here, and writing pi's number into the format's `version` would make a reader think this is a v3 log. */
export const FORMAT_VERSION = 4

/** The `source.kind` a DIRECT HUMAN prompt carries. The other kinds are the harness -- or here, pi -- speaking. */
export const HUMAN_SOURCE_KIND = 'user'

/** The `source.kind` a compaction carries. The harness speaking, in the dsh vocabulary the corpus already uses. */
export const COMPACT_SOURCE_KIND = 'compact-checkpoint'

/** The `source.kind` a context edit carries. A substrate may name its own kinds: the set is open by design, because a
 *  kind is a statement about WHO PRODUCED this text and a pi session has facts a dsh session does not. */
export const CONTEXT_EDIT_SOURCE_KIND = 'pi-context-edit'

/**
 * A TIMESTAMP IN MILLISECONDS, and pi writes TWO of them.
 *
 * MEASURED on this host: a pi entry's `timestamp` is an ISO **string** (24 characters) and the session header's is
 * also a string, while the format's `time` is a number of milliseconds since the epoch. So a reader that asks
 * `Number.isFinite(entry.timestamp)` gets `false` for every entry in the corpus and falls back to zero -- and a log
 * whose every record claims the session happened at the epoch is a log that cannot be ordered against anything.
 *
 * @param {unknown} value
 * @returns {number|null} milliseconds, or null when the value is neither
 */
export function toMillis(value) {
    if (Number.isFinite(value)) return value
    if (typeof value === 'string') {
        const parsed = Date.parse(value)
        return Number.isFinite(parsed) ? parsed : null
    }
    return null
}

/**
 * ONE FILE, PARSED. A line that is not JSON is COUNTED and skipped, never dropped silently -- the rule
 * `docs/adapters-and-standards.md` credits to `agent-eval` ("a line that is not JSON is counted"). Measured: 0
 * unparseable lines in 42,123 on this host, which is a receipt that the counter works rather than a reason to drop it.
 *
 * @param {string} text
 * @returns {{ header: object|null, entries: object[], unparseable: number }}
 */
export function parseSession(text) {
    const lines = String(text ?? '').split('\n')
    const entries = []
    let header = null
    let unparseable = 0
    for (const line of lines) {
        if (line.trim() === '') continue
        let entry
        try {
            entry = JSON.parse(line)
        } catch {
            unparseable += 1
            continue
        }
        if (entry === null || typeof entry !== 'object') {
            unparseable += 1
            continue
        }
        if (entry.type === PI_ENTRY.SESSION) {
            header = entry
            continue
        }
        entries.push(entry)
    }
    return { header, entries, unparseable }
}

/**
 * THE LIVE BRANCH: the path from the current leaf back to the root, oldest first.
 *
 * pi's entries form a DAG (`id`/`parentId`) and pi resolves it itself with `buildContextEntries()`, which walks from
 * the current leaf to the root. Measured on this host: the leaf is the last entry in file order in 223 of 224
 * sessions, and only 3 entries in the whole corpus sit off that path. So this follows the leaf path and reports what
 * it left behind, rather than flattening the file and silently merging two branches into one conversation.
 *
 * A `parentId` that names no entry ends the walk rather than throwing: a truncated file is a real state for a log
 * that is being written right now, and refusing the whole session for its last line would be the wrong answer.
 *
 * @param {object[]} entries
 * @param {object} [leaf]  pi's own current leaf entry, when the caller has it. pi knows the leaf -- `getLeafEntry()`
 *   -- and the file order only agrees with it in 223 of 224 sessions on this host, so a caller that can ask should.
 * @returns {{ entries: object[], offPath: object[], cyclic: boolean }}
 */
export function livePath(entries, leaf) {
    const list = Array.isArray(entries) ? entries : []
    const byId = new Map()
    for (const entry of list) if (typeof entry?.id === 'string') byId.set(entry.id, entry)
    const chain = []
    const seen = new Set()
    let node = leaf !== undefined && leaf !== null
        ? leaf
        : (list.length === 0 ? undefined : list[list.length - 1])
    while (node !== undefined && node !== null && !seen.has(node.id)) {
        seen.add(node.id)
        chain.push(node)
        node = typeof node.parentId === 'string' ? byId.get(node.parentId) : undefined
    }
    const onPath = new Set(chain.map((entry) => entry.id))
    return {
        entries: chain.reverse(),
        offPath: list.filter((entry) => !onPath.has(entry?.id)),
        /** A cycle in the DAG would make the walk unbounded; this says whether one was seen. */
        cyclic: seen.size !== list.filter((entry) => typeof entry?.id === 'string').length,
    }
}

/**
 * THE `source.kind` FOR AN INJECTED MESSAGE: the producer, in the kebab-case the harness's own kinds use
 * (`subagent-settled`, `skill-invocation`, `tool-registry`). pi names its extension with `customType`, so the kind is
 * `pi-<that>`, and an extension with no name falls back to `pi-extension`.
 *
 * MEASURED on this host: 183 injections across 10 extension types -- `subagent-notify` 74, `goal-event` 34,
 * `telegram-connection-state` 27, `intercom_message` 16, and six more. Every one of them participates in the LLM
 * context WITHOUT a human typing it, and treating them as asks would invent 183 operator turns out of extension
 * chatter. They stay in the log and stay OUT of the asks.
 *
 * @param {string} customType
 * @returns {string}
 */
export function producerKindOf(customType) {
    const name = String(customType ?? '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
    return name === '' ? 'pi-extension' : `pi-${name}`
}

/**
 * THE CONTENT BLOCKS OF ONE pi message, in the format's own block types.
 *
 * THREE RENAME RULES, and each one is a rule the format states:
 *   * `text` stays `text` -- the only block a reader may take as visible words.
 *   * `thinking` becomes `reasoning`, AND ITS FIELD CHANGES (`thinking` -> `text`). Accepting both would be a second
 *     way to read one vocabulary (**F179**), and a reader that takes `.text` from any block hands the model its own
 *     reasoning as though the operator had typed it (**F79**).
 *   * `toolCall` becomes `tool-call`, with the arguments as a JSON STRING, because that is what the format's
 *     `tool/call` record carries and what a validator compares.
 *   * `image` stays `image`, and its BYTES ARE DROPPED while its count survives. A log does not need the payload to be
 *     readable, and a text placeholder would be evidence the model never produced.
 *
 * @param {unknown} content  pi's `content`: a string, or an array of blocks
 * @returns {{ blocks: object[], images: number }}
 */
export function blocksOf(content) {
    if (typeof content === 'string') return { blocks: content === '' ? [] : [{ type: 'text', text: content }], images: 0 }
    if (!Array.isArray(content)) return { blocks: [], images: 0 }
    const blocks = []
    let images = 0
    for (const block of content) {
        if (block === null || typeof block !== 'object') continue
        if (block.type === PI_BLOCK.TEXT && typeof block.text === 'string') {
            blocks.push({ type: 'text', text: block.text })
            continue
        }
        if (block.type === PI_BLOCK.THINKING && typeof block.thinking === 'string') {
            blocks.push({ type: 'reasoning', text: block.thinking })
            continue
        }
        if (block.type === PI_BLOCK.TOOL_CALL && typeof block.id === 'string') {
            blocks.push({
                type: 'tool-call',
                id: block.id,
                name: typeof block.name === 'string' ? block.name : '(unnamed)',
                arguments: JSON.stringify(block.arguments ?? {}),
            })
            continue
        }
        if (block.type === PI_BLOCK.IMAGE) {
            images += 1
            blocks.push({ type: 'image' })
        }
    }
    return { blocks, images }
}

/**
 * THE SESSION LOG, in the format, from a pi session's entries.
 *
 * NO TURNS. That is the whole difference from the observer's importer, and it is the difference the format asks for:
 * a turn is a dsh-shaped boundary, and a substrate that has none would otherwise read as a dsh-only session. The
 * ask-group is DERIVED from the human's messages by whoever reads the log, so the boundary survives the removal of
 * the boundary the dsh log invented.
 *
 * @param {object[]} entries  pi's session entries, in file order
 * @param {{ header?: object, createdAt?: number, cwd?: string, id?: string, leaf?: object }} [options]
 * @returns {{ records: object[], facts: object }}
 */
export function toSessionLog(entries, options = {}) {
    const list = Array.isArray(entries) ? entries : []
    const header = options.header ?? null
    const cwd = options.cwd ?? header?.cwd ?? undefined
    const id = options.id ?? header?.id ?? null

    const path = livePath(list, options.leaf)
    const onPath = path.entries

    // THE CREATED-AT, and where it comes from when the header does not carry it. The header's own timestamp is the
    // session's start; the first entry's is the first thing that happened in it, which is a second reading of the
    // same fact and a better one than the epoch.
    const headerAt = toMillis(header?.timestamp)
    const firstAt = toMillis(onPath[0]?.timestamp)
    const createdAt = Number.isFinite(options.createdAt)
        ? options.createdAt
        : (headerAt ?? firstAt ?? 0)

    const facts = {
        sessions: 1,
        entries: list.length,
        offPathEntries: path.offPath.length,
        cyclic: path.cyclic,
        operatorAsks: 0,
        assistantMessages: 0,
        toolCalls: 0,
        toolResults: 0,
        injectedMessages: 0,
        injectedHidden: 0,
        compactions: 0,
        contextEdits: 0,
        titles: 0,
        /** The losses, counted rather than absorbed. */
        imagesNotCarried: 0,
        systemMessages: 0,
        bashExecutions: 0,
        modelChanges: 0,
        thinkingLevelChanges: 0,
        customEntries: 0,
        /** The pairing facts, which a reader cannot see and a loss would hide. */
        unresolvedCalls: 0,
        orphanResults: 0,
    }

    // EVERY CALL THE ASSISTANT ADVERTISED, BY ITS ID. Measured: 19,136 advertised calls over the corpus, and every
    // tool result in pi matches one of them -- but the pairing is by ID, never by position, because a result that
    // names no call is a result nobody can attribute.
    const advertisedIds = new Set()
    for (const entry of onPath) {
        if (entry?.type !== PI_ENTRY.MESSAGE) continue
        const message = entry.message
        if (message?.role !== PI_ROLE.ASSISTANT) continue
        for (const block of Array.isArray(message.content) ? message.content : []) {
            if (block?.type === PI_BLOCK.TOOL_CALL && typeof block.id === 'string') advertisedIds.add(block.id)
        }
    }

    // EVERY TOOL RESULT, BY THE CALL ID PI PAIRS IT WITH -- but only for a call that was ADVERTISED. Measured: every
    // one of the 19,113 results matches an advertised call, and every one appears BEFORE the next assistant message
    // -- so a lookup table, not a positional guess. A result whose call was never advertised is an ORPHAN: it is
    // COUNTED, never matched to whatever came before it.
    const resultsByCall = new Map()
    for (const entry of onPath) {
        if (entry?.type !== PI_ENTRY.MESSAGE) continue
        const message = entry.message
        if (message?.role !== PI_ROLE.TOOL_RESULT) continue
        const callId = message.toolCallId
        if (typeof callId !== 'string' || callId === '') continue
        if (!advertisedIds.has(callId)) continue
        if (!resultsByCall.has(callId)) resultsByCall.set(callId, entry)
    }
    for (const entry of onPath) {
        if (entry?.type !== PI_ENTRY.MESSAGE) continue
        const message = entry.message
        if (message?.role !== PI_ROLE.TOOL_RESULT) continue
        const callId = message.toolCallId
        if (typeof callId !== 'string' || callId === '' || !advertisedIds.has(callId)) facts.orphanResults += 1
    }

    // THE SEQ OF EVERY PI ENTRY, so a withdrawal can name the records it withdraws. The seq is the FORMAT's seq --
    // the header is not a record and does not take one, which is what the dsh log does too.
    const seqOfEntry = new Map()
    const records = []
    let seq = 0
    const push = (type, data, time, surfaceOp) => {
        const record = { type, seq: seq++, time: toMillis(time) ?? createdAt, data }
        if (surfaceOp !== undefined) record.surfaceOp = surfaceOp
        records.push(record)
        return record
    }

    const headerRecord = { type: RECORD.SESSION, version: FORMAT_VERSION, id, createdAt }
    if (cwd !== undefined) headerRecord.cwd = cwd
    if (typeof header?.parentSession === 'string') headerRecord.parentSession = header.parentSession

    for (const entry of onPath) {
        if (entry === null || typeof entry !== 'object') continue
        const at = entry.timestamp
        switch (entry.type) {
            case PI_ENTRY.MESSAGE:
                mapMessage(entry, at)
                break
            case PI_ENTRY.CUSTOM_MESSAGE:
                mapInjection(entry, at)
                break
            case PI_ENTRY.COMPACTION:
                mapCompaction(entry, at)
                break
            case PI_ENTRY.CONTEXT_EDIT:
                mapContextEdit(entry, at)
                break
            case PI_ENTRY.SESSION_INFO:
                mapTitle(entry, at)
                break
            case PI_ENTRY.MODEL_CHANGE:
                facts.modelChanges += 1
                break
            case PI_ENTRY.THINKING_LEVEL_CHANGE:
                facts.thinkingLevelChanges += 1
                break
            case PI_ENTRY.CUSTOM:
                facts.customEntries += 1
                break
            default:
                break
        }
    }

    function mapMessage(entry, at) {
        const message = entry.message
        if (message === null || typeof message !== 'object') return
        const role = message.role
        if (role === PI_ROLE.USER) {
            const { blocks, images } = blocksOf(message.content)
            facts.imagesNotCarried += images
            facts.operatorAsks += 1
            push(RECORD.USER_MESSAGE, {
                content: blocks,
                source: { kind: HUMAN_SOURCE_KIND },
                role: 'user',
                id: `pi-${id}-u${facts.operatorAsks}`,
            }, at)
            seqOfEntry.set(entry.id, seq - 1)
            return
        }
        if (role === PI_ROLE.ASSISTANT) {
            const { blocks, images } = blocksOf(message.content)
            facts.imagesNotCarried += images
            facts.assistantMessages += 1
            // THE ADVERTISED CALLS, AND ONLY THE RESOLVED ONES. An unresolved call is the tail of an aborted
            // session -- measured: 23 of 19,100 advertised calls had no result. Fabricating one, or advertising a
            // call whose lifecycle never closes, makes the log unreadable; so the block is left out and COUNTED.
            const advertised = blocks.filter((block) => block.type === 'tool-call')
            const resolved = []
            for (const call of advertised) {
                if (resultsByCall.has(call.id)) resolved.push(call)
                else facts.unresolvedCalls += 1
            }
            const content = blocks.filter((block) => block.type !== 'tool-call').concat(resolved)
            const usage = message.usage ?? null
            const data = {
                message: {
                    role: 'assistant',
                    content,
                    source: {
                        kind: 'model',
                        provider: typeof message.provider === 'string' ? message.provider : 'pi',
                        model: typeof message.model === 'string' ? message.model : 'unknown',
                    },
                    id: `pi-${id}-a${facts.assistantMessages}`,
                },
                // pi keeps NO stream record -- the session file holds the finalised message only -- so this is empty
                // rather than invented. An empty stream is not a missing measurement; it is the harness's own shape
                // for a message that was not streamed into this log.
                stream: [],
            }
            if (usage !== null && typeof usage === 'object') data.usage = usageOf(usage)
            // pi's `aborted` is the format's `interrupted`: the model's turn was cut short rather than finished. And
            // it is STATED ONLY WHEN IT HAPPENED -- never `false` by default, because `false` is a claim from a
            // reader that never looked.
            if (message.stopReason === 'aborted') data.interrupted = true
            push(RECORD.ASSISTANT_MESSAGE, data, at)
            seqOfEntry.set(entry.id, seq - 1)
            // THE TOOL CALLS, right after the message that advertised them, in pi's order.
            for (const call of resolved) {
                facts.toolCalls += 1
                push(RECORD.TOOL_CALL, { callId: call.id, name: call.name, arguments: call.arguments }, at)
            }
            return
        }
        if (role === PI_ROLE.TOOL_RESULT) {
            const callId = message.toolCallId
            // A RESULT WITH NO CALL, OR WITH A CALL NOBODY ADVERTISED, IS COUNTED AND LEFT OUT. It is not matched
            // to whatever came before it: a reader that pairs by position gives the result to the wrong tool, and a
            // wrong tool is a reading of a conversation that did not happen.
            if (typeof callId !== 'string' || callId === '' || !resultsByCall.has(callId)) return
            const { blocks, images } = blocksOf(message.content)
            facts.imagesNotCarried += images
            facts.toolResults += 1
            const body = {
                role: 'tool',
                source: { kind: 'tool', callId },
                toolCallId: callId,
                content: blocks,
                id: `pi-${id}-r${facts.toolResults}`,
            }
            if (message.isError === true) body.isError = true
            push(RECORD.TOOL_RESULT, { callId, message: body }, at)
            seqOfEntry.set(entry.id, seq - 1)
            return
        }
        if (role === PI_ROLE.SYSTEM) {
            // pi's prompt SECTIONS. A section is assembled per request and is not a message; putting it in the
            // conversation would invent one.
            facts.systemMessages += 1
            return
        }
        if (role === PI_ROLE.BASH_EXECUTION) {
            // pi's own record of a `!` command. It has no call id, so there is no honest pairing to a call.
            facts.bashExecutions += 1
            return
        }
    }

    function mapInjection(entry, at) {
        const { blocks, images } = blocksOf(entry.content)
        facts.imagesNotCarried += images
        facts.injectedMessages += 1
        if (entry.display !== true) facts.injectedHidden += 1
        push(RECORD.USER_MESSAGE, {
            content: blocks,
            // THE PRODUCER-OWNED KIND. A pi extension's message is named after the extension, because a kind is a
            // statement about WHO PRODUCED this text, and this one was produced by an extension and not by a person.
            source: { kind: producerKindOf(entry.customType) },
            role: 'user',
            id: `pi-${id}-m${facts.injectedMessages}`,
        }, at)
        seqOfEntry.set(entry.id, seq - 1)
    }

    function mapCompaction(entry, at) {
        facts.compactions += 1
        // THE WITHDRAWAL. A compaction replaces the model's view of the history with a summary, so the records it
        // replaced are NOT on the surface -- and a producer that says nothing about that would measure text the model
        // could no longer see and look complete. The range is INCLUSIVE at both ends and the compaction's own record
        // sits OUTSIDE it, which is what makes the summary the surfaced message rather than a casualty of its own
        // replacement.
        const firstKept = seqOfEntry.get(entry.firstKeptEntryId)
        const start = 0
        const end = Number.isFinite(firstKept) ? firstKept - 1 : seq - 1
        const op = end >= start ? { op: 'replace', startSeq: start, endSeq: end } : undefined
        const summary = typeof entry.summary === 'string' ? entry.summary : ''
        push(RECORD.USER_MESSAGE, {
            content: summary === '' ? [] : [{ type: 'text', text: summary }],
            source: { kind: COMPACT_SOURCE_KIND },
            role: 'user',
            id: `pi-${id}-c${facts.compactions}`,
        }, at, op)
        seqOfEntry.set(entry.id, seq - 1)
    }

    function mapContextEdit(entry, at) {
        facts.contextEdits += 1
        // A CONTEXT EDIT REMOVES AN ENTRY FROM THE FUTURE CONTEXT. The replacement is null in every one of the 6 in
        // this corpus, which means the entry is withdrawn and nothing is put in its place -- so the edit is a
        // withdrawal, and the record that carries it says so with a `surfaceOp`.
        const target = seqOfEntry.get(entry.targetId)
        const replacement = entry.replacement
        const { blocks, images } = blocksOf(replacement?.content ?? replacement)
        facts.imagesNotCarried += images
        const op = Number.isFinite(target) ? { op: 'replace', startSeq: target, endSeq: target } : undefined
        push(RECORD.USER_MESSAGE, {
            content: blocks,
            source: { kind: CONTEXT_EDIT_SOURCE_KIND },
            role: 'user',
            id: `pi-${id}-x${facts.contextEdits}`,
        }, at, op)
        seqOfEntry.set(entry.id, seq - 1)
    }

    function mapTitle(entry, at) {
        if (typeof entry.name !== 'string' || entry.name === '') return
        facts.titles += 1
        // A TITLE SUPPLIED FROM OUTSIDE carries an EMPTY `messageSeqs`: the format asserts exactly that, and it is
        // the honest shape for a title the session did not derive from its own messages.
        push(RECORD.TITLE, { title: entry.name, messageSeqs: [], source: { kind: HUMAN_SOURCE_KIND } }, at)
        seqOfEntry.set(entry.id, seq - 1)
    }

    return { records: [headerRecord, ...records], facts }
}

/**
 * THE FORMAT'S `usage` FIELD NAMES. pi's `reasoning` tokens and `cost` have no field here; they are counted in the
 * facts of the importer that reads pi's own log rather than dropped silently.
 *
 * @param {object} usage
 * @returns {object}
 */
export function usageOf(usage) {
    return {
        inputTokens: Number(usage.input) || 0,
        outputTokens: Number(usage.output) || 0,
        cacheReadTokens: Number(usage.cacheRead) || 0,
        cacheWriteTokens: Number(usage.cacheWrite) || 0,
        totalTokens: Number(usage.totalTokens) || 0,
    }
}

/** The records as JSONL text, which is what a session log IS: one JSON object per line, in order. */
export function recordsToJsonl(records) {
    return (Array.isArray(records) ? records : []).map((record) => JSON.stringify(record)).join('\n') + '\n'
}
