# pi-session-log

**A pi extension that records a pi session in the session-log format — the second implementation of a format two
harnesses now share.**

A format that is only ever implemented once has never been a format; it has been a private convention that happened to
be readable. The dsh v4 log was that convention: three importers converted *into* it, none of them was specified, and
the store — which imports no dsh code — had to restate its rules in its own words. That is how the two channels came
to disagree about **who spoke** (**F173**), about **the text of a message** (**F177**), and about **a NUL byte**
(**F180**), and every one of those was silent.

So the format is now specified ([`docs/session-log-format.md`](https://github.com/johnlam1968/dsh-system1-observer/blob/composing-tools/docs/session-log-format.md)),
its rules live in one published package ([`dsh-session-rows`](https://github.com/johnlam1968/dsh-session-rows)), and
**this repository is the second implementation of it**: pi's own sessions, written down in that format, by pi itself.

## What it does

```bash
# as an extension, inside a running pi
pi -e ./extensions/session-log.js
# or installed as a package
pi install npm:pi-session-log
```

The extension reads the session **from inside pi**, through pi's own session manager, and writes two files:

```
<root>/<cwd-slug>/<session-id>/session.v4.jsonl    the log — the format, implemented
<root>/<cwd-slug>/<session-id>/rows.jsonl          the rows — the contract, obeyed
```

The layout is the **dsh corpus's own layout** — `<root>/<slug>/<session-id>/session.v4.jsonl`, with the slug in pi's
convention (`--home-john-.penguin--` for `/home/john/.penguin`). That is not a preference: the store
(`dsh-session-index`) already indexes a corpus laid out this way, and its `corpus` column is the path segment above the
session id. **A pi session written here is listed, searched and read by the same store, with no change to the store.**

Where it goes: `~/.pi/session-logs` by default, or `--session-log-dir <path>`, or `PI_SESSION_LOG_DIR`. It is written
when the agent settles, when the session shuts down, and on demand with `/session-log`.

## What it does NOT do

- **It does not change the session it measures.** An extension that altered the conversation would be measuring
  something else.
- **It does not send anything anywhere.** It writes down what happened.
- **It does not decide anything.** It is an instrument's substrate, not an instrument.
- **It does not import dsh code, and it must not be able to.** The rules it obeys come from `dsh-session-rows`; the
  mapping from pi's entries to the format's records is here; nothing else is.

## The difference from the observer's pi importer, and why it matters

The observer already reads pi sessions — `dsh-system1-observer`, `dsh/pi-session-export.js`. It converts them into a
**dsh v4 log**: an invented `turn` and `step` for every ask, with `turn/start` and `step/end` around them. That log is
a dsh log with pi's words in it.

**The format is not a dsh shape.** Its rule 7 says a substrate "does not have to write turns, and **must not invent
them**", because a turn is a dsh-shaped boundary and a substrate without one would otherwise read as a dsh-only session.
This implementation writes the format natively: no turn, no step, no turn boundaries. The ask-group is **derived** from
where the human spoke, so the boundary survives the removal of the boundary the dsh log invented.

And the two do not agree everywhere, and the disagreement is the point:

| | the dsh-shaped path | this one |
|---|---|---|
| a compaction | **not written** — the messages it withdrew still read as on-surface, and the summary the model saw is absent | written, with the `surfaceOp` that withdrew them |
| an injected message | placed at the **head** of its exchange, because that is where a dsh log can put one | left where pi put it |
| a turn | invented | **not invented** |

Measured over the whole pi corpus — **258 sessions, 0 unreadable**: the two agree on the composed state in **250**,
and the **8** that differ are the compacted ones, where the dsh-shaped path reports text the model could no longer see.
The numbers are in [`docs/measurement.md`](docs/measurement.md), and the check is a command in the observer:

```bash
node scripts/check-pi-channels.mjs --pi-repo ../pi-session-log
```

## The rules are imported, not restated

`dsh-session-rows` owns them, and this repository obeys them:

| | |
|---|---|
| `visibleText(content)` | only a `text` block is text; the text is trimmed; no NUL byte |
| `reasoningOf(content)` | only a `reasoning` block is reasoning, joined by a newline — and `null` for the absence |
| `withoutNuls(value)` | the NUL rule, and why it is U+FFFD and not a deletion |
| `isHumanMessage(event)` | the source rule: the record type does not say who spoke |
| `exchangeIndexOf(records)` | **rule 1** of the contract: the ask-group, derived, never a native `turn` |
| `surfaceEvents(records)` | **rule 2**: what the surface withdrew, and what it did not |

And this repository's own **conformance test** checks that a producer which knows nothing about dsh makes the dsh
channel's rows from a dsh log, byte for byte — the fixture is the package's, and its digest is pinned.

## The corpus it was measured on

`@earendil-works/pi-coding-agent` **0.85.1**, over `~/.pi/<agent>/sessions/`: **258 session files**, 42,123 entries,
**0 unparseable lines**, 2,018 user messages, 19,950 assistant messages, 19,113 tool results, 183 extension
injections, 8 compactions, 6 context edits, 27 `!` bash executions and 15 prompt-section messages.

Every loss is **counted** in the implementation's `facts` rather than absorbed, because a loss nothing reports reads as a
measurement that saw everything: image payloads, pi's prompt sections, `!` commands, model and thinking-level changes,
extension state, and the tool calls that never got a result.

## Licence

MIT.
