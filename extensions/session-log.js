// THE PI EXTENSION: a pi session, written down in the session-log format.
//
// WHY AN EXTENSION AND NOT A SCRIPT. A script reads pi's session files AFTER the fact, and that is what the
// observer's importer does. An extension reads the session FROM INSIDE pi, through pi's own session manager, and can
// write the log the moment the agent settles -- so the log is the session as pi held it, not a reconstruction of it.
// It is also the only way the extension can be shipped to pi users: pi loads an extension from
// `~/.pi/agent/extensions/`, from an npm package, or from a git source.
//
// WHAT IT WRITES, AND WHERE. Two files, in the SAME LAYOUT as the dsh corpus:
//
//     <root>/<cwd-slug>/<session-id>/session.v4.jsonl    the log -- the format, implemented
//     <root>/<cwd-slug>/<session-id>/rows.jsonl          the rows -- the contract, obeyed
//
// The layout is not a preference. The store (`dsh-session-index`) already indexes a corpus laid out this way, and
// its `corpus` column is the path segment above the session id -- so a pi session written here is indexed, listed and
// searched by the SAME store, with no change to the store. The slug is pi's own convention
// (`--home-john-.penguin--` for `/home/john/.penguin`), so the two corpora look the same to anything that walks them.
//
// WHAT IT DOES NOT DO. It does not change the session it measures, it does not send anything anywhere, and it does
// not decide anything. It writes down what happened, in a format another implementation already reads.
//
// THE RULES IT OBeys are imported, not restated: `dsh-session-rows` owns the text rules, the source rule, the
// ask-group and the surface. This file is the WIRING -- pi's events in, the format's records out.
//
// WHEN IT WRITES. On `agent_settled` (the agent is idle and the session is complete for this turn) and on
// `session_shutdown` (the session is over). The log is REWRITTEN each time rather than appended, because it is a
// function of the session's current state: a resumed session's log is the whole session, not the part since the
// resume, and a rewrite cannot get that wrong. A command writes it on demand too.
//
// A FAILURE HERE MUST NOT BREAK PI. Every write is wrapped, and a failure is reported to the operator rather than
// thrown into pi's loop: an extension that stops the agent it is measuring has changed the thing it measured.

import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { parseSession, recordsToJsonl, toSessionLog } from '../src/pi-log.js'
import { rowsToJsonl, toRows } from '../src/rows.js'

/** The default corpus root. The same shape as the dsh corpus, so the same store reads it. */
export const DEFAULT_ROOT = join(homedir(), '.pi', 'session-logs')

/**
 * THE SLUG OF A WORKING DIRECTORY, in pi's own convention: the path with its leading slash and every slash replaced
 * by a dash, wrapped in two dashes. `/home/john/.penguin` becomes `--home-john-.penguin--`, which is what pi's own
 * session directories are called, so the two corpora are walked the same way.
 *
 * @param {string} cwd
 * @returns {string}
 */
export function slugOf(cwd) {
    const path = String(cwd ?? '').replace(/^\/+/, '').replace(/\/+$/, '')
    return path === '' ? '--root--' : `--${path.replace(/\//g, '-')}--`
}

/**
 * WHERE ONE SESSION'S TWO FILES GO.
 *
 * @param {string} root
 * @param {string} cwd
 * @param {string} sessionId
 * @returns {{ dir: string, log: string, rows: string }}
 */
export function pathsFor(root, cwd, sessionId) {
    const dir = join(root, slugOf(cwd), String(sessionId))
    return { dir, log: join(dir, 'session.v4.jsonl'), rows: join(dir, 'rows.jsonl') }
}

/**
 * THE HEADER OF PI'S OWN SESSION FILE, read from the file rather than guessed.
 *
 * pi's session file's first line is a header carrying `id`, `timestamp`, `cwd` and pi's own `version`. The format's
 * header wants `createdAt` and the format's `version`, and the two versions are different things: pi's session files
 * are version 3, and the format is version 4. Writing pi's number into the format's `version` would make a reader
 * think this is a v3 log.
 *
 * @param {string} file
 * @returns {Promise<object|null>}
 */
async function readPiHeader(file) {
    if (typeof file !== 'string' || file === '') return null
    let text
    try {
        text = await readFile(file, 'utf8')
    } catch {
        return null
    }
    const first = text.split('\n').find((line) => line.trim() !== '')
    if (first === undefined) return null
    try {
        const parsed = JSON.parse(first)
        return parsed !== null && typeof parsed === 'object' && parsed.type === 'session' ? parsed : null
    } catch {
        return null
    }
}

/**
 * WRITE ONE SESSION: the log, and the rows that the log produces.
 *
 * THE RECEIPT NAMES THE BYTES. A measurement that cannot name the evidence it read cannot be reproduced or argued
 * with, so the rows carry the log's size and its sha256 -- and the rows are computed from the log TEXT that was
 * written, not from the records in memory, so the receipt describes the file a reader would actually find.
 *
 * @param {object} options
 * @param {string} options.root
 * @param {string} options.cwd
 * @param {string} options.sessionId
 * @param {object[]} options.entries  pi's session entries
 * @param {object} [options.header]  pi's own session header
 * @param {object} [options.leaf]  pi's current leaf entry
 * @returns {Promise<{ log: string, rows: string, records: number, rows: number, facts: object }>}
 */
export async function writeSession({ root, cwd, sessionId, entries, header, leaf }) {
    const { records, facts } = toSessionLog(entries, { header, cwd, id: sessionId, leaf })
    const text = recordsToJsonl(records)
    const paths = pathsFor(root, cwd, sessionId)
    await mkdir(paths.dir, { recursive: true })
    await writeFile(paths.log, text, 'utf8')

    const bytes = Buffer.byteLength(text, 'utf8')
    const sha256 = createHash('sha256').update(text).digest('hex')
    const rows = toRows(records, {
        harness: 'pi',
        id: sessionId,
        source: paths.log,
        sourceBytes: bytes,
        sourceSha256: sha256,
        highWater: records.at(-1)?.seq ?? null,
        schemaVersion: 1,
    })
    await writeFile(paths.rows, rowsToJsonl(rows), 'utf8')
    return { log: paths.log, rows: paths.rows, records: records.length, rowCount: rows.length, facts }
}

/**
 * THE EXTENSION, and the only part that talks to pi.
 *
 * @param {object} pi  pi's `ExtensionAPI`
 */
export default function sessionLogExtension(pi) {
    pi.registerFlag('session-log-dir', {
        description: 'Where the session log and its rows are written (default: ~/.pi/session-logs)',
        type: 'string',
    })

    const rootOf = () => {
        const flag = pi.getFlag('session-log-dir')
        if (typeof flag === 'string' && flag !== '') return flag
        const env = process.env.PI_SESSION_LOG_DIR
        if (typeof env === 'string' && env !== '') return env
        return DEFAULT_ROOT
    }

    /**
     * WRITE THE SESSION, and say what happened. A failure is reported and swallowed: an extension that stops the
     * agent it is measuring has changed the thing it measured.
     */
    const write = async (ctx, reason) => {
        try {
            const manager = ctx?.sessionManager
            if (manager === undefined || manager === null) return null
            const entries = typeof manager.getEntries === 'function' ? manager.getEntries() : []
            const file = typeof manager.getSessionFile === 'function' ? manager.getSessionFile() : null
            const header = await readPiHeader(file)
            const sessionId = typeof manager.getSessionId === 'function'
                ? manager.getSessionId()
                : (header?.id ?? null)
            if (sessionId === null || sessionId === undefined) return null
            const cwd = header?.cwd ?? process.cwd()
            const leaf = typeof manager.getLeafEntry === 'function' ? manager.getLeafEntry() : undefined
            const result = await writeSession({ root: rootOf(), cwd, sessionId, entries, header, leaf })
            return result
        } catch (error) {
            if (ctx?.ui?.notify !== undefined) {
                ctx.ui.notify(`session-log: ${error.message}`, 'error')
            }
            return null
        }
    }

    pi.on('agent_settled', async (_event, ctx) => {
        await write(ctx, 'settled')
    })

    pi.on('session_shutdown', async (_event, ctx) => {
        await write(ctx, 'shutdown')
    })

    pi.registerCommand('session-log', {
        description: 'Write this session down in the session-log format',
        handler: async (_args, ctx) => {
            const result = await write(ctx, 'command')
            if (result === null) {
                ctx.ui.notify('session-log: nothing was written', 'error')
                return
            }
            ctx.ui.notify(`session-log: ${result.records} records, ${result.rowCount} rows -> ${result.log}`, 'info')
        },
    })
}

/** The parser, re-exported so a caller can read a pi session file without the extension. */
export { parseSession }
