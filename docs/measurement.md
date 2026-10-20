# The measurement

**What was measured, on what, and what it came to.** Every number here was produced by a command on the operator's
machine, and the command is named beside it. The dates are 2026-10-19 and 2026-10-20.

## 1. The corpus

`@earendil-works/pi-coding-agent` **0.85.1**, over `~/.pi/<agent>/sessions/`. Measured by reading the bytes, not by
trusting a spec. The corpus GROWS while it is measured -- pi is running on this host -- so the count is the one the
last run saw:

| | measured |
|---|---|
| session files | **260** |
| entries | 42,123+ (the corpus grew during the session; the first measurement, of `~/.pi/agent/sessions` alone, was 224 files and 42,123 entries) |
| unparseable lines | **0** |
| entry types | `message` 41,123 · `custom_message` 183 · `model_change` 295 · `thinking_level_change` 226 · `session_info` 35 · `compaction` 8 · `custom` 23 · `context_edit` 6 |
| message roles | `user` 2,018 · `assistant` 19,950 · `toolResult` 19,113 · `bashExecution` 27 · `system` 15 |
| content blocks | `text` 33,739 · `toolCall` 19,136 · `thinking` 3,751 · `image` 161 · a string body 15 |
| tool pairing | 19,136 advertised calls, 19,113 results, and every result names a call that was advertised |

## 2. The two channels, composed both ways, compared

**The claim under test: removing the invented turns changes nothing.** The dsh-shaped path converts a pi session into
a dsh v4 log — with a `turn` and a `step` for every ask, and `turn/start` / `step/end` around them — and reads it with
the observer's producer. The pi-native path writes the session in the format — no turn, no step — and reads it with
this repository's producer. The ask-group is derived in both, so the boundary should survive.

The command is in the observer, and it is the sibling of the dsh channel check:

```bash
node scripts/check-pi-channels.mjs --pi-repo ../pi-session-log
```

**Measured:**

```
sessions: 260 compared, 252 agreed on the composed state, 8 diverged, 14 differed in order only, 0 unreadable

differing fields:
  composed state: 8 session(s)
  message order:  22 session(s)
```

The composed state is compared as a **multiset of message fingerprints** and a multiset of tool-call fingerprints, not
row by row: the two logs hold different records, so a positional comparison would report thousands of differences that
are one difference — the two logs number their records differently — and would hide the one that matters.

## 3. The two differences, each with its cause

### 3.1 The order — 22 sessions, and the pi-native path is the faithful one

**Cause:** the dsh-shaped path places an **injected** message at the **head** of its exchange, because that is where a
dsh log can put one — a `user/message` that is not the human has to live inside a turn, and the importer puts it at the
front. pi's own path keeps the order things happened in.

**Measured on one of the 22:** the composed state agreed — the same messages, the same groups, the same text — and the
first order difference was at index 244 of 260: channel A had an injected `system` message of 19 characters and then
one of 4,749, and channel B had the two assistant messages that pi actually showed the model before them.

**The count.** 14 sessions differ in order ONLY, and 8 differ in order and in the composed state (the compaction, below).
So the order difference is 22 in all, and it is a difference in **where the harness placed a message**, not in what was
said.

### 3.2 The composed state — 8 sessions, and the dsh-shaped path is the wrong one

**Cause:** the dsh-shaped path **does not carry a `surfaceOp`**, so a message that pi's compaction withdrew still reads
as on-surface in it — and the summary the model actually saw is **absent from its rows entirely**.

**Measured, the five largest** (of the 8):

| session | messages in A | shadowed in A | messages in B | shadowed in B |
|---|---:|---:|---:|---:|
| 2026-09-04 | 1,034 | **0** | 1,035 | **979** |
| 2026-09-09 | 802 | **0** | 803 | **680** |
| 2026-09-11 | 1,469 | **0** | 1,470 | **1,178** |
| 2026-09-12 | 1,001 | **0** | 1,002 | **751** |
| 2026-09-13 | 2,253 | **0** | 2,255 | **1,884** |

**WHAT THAT MEANS, in one sentence:** in 8 sessions of the corpus, the dsh-shaped path reports **1,178 messages the
model could no longer see** as though it had seen them, and omits the summary that replaced them — so it measures a
conversation that is not the one that happened, and it looks complete while doing it.

**WHY THE OLD PATH LOSES IT, measured:** pi's compaction entry carries `firstKeptEntryId`, and the entries before it
are withdrawn from the model's context. The dsh-shaped importer counts the compaction in its facts
(`compactionEntries: 8`) and writes it to the import sidecar — so the loss is **reported** — but it writes no record
for it, and a log that does not say what it withdrew cannot mark what it withdrew.

**AND THE FORMAT ASKS FOR IT:** rule 4 of the format's §6 — "a `surfaceOp` on anything that withdraws earlier records,
if the substrate has such a thing" — and rule 2 of the rows contract, "`shadowed` is required". The pi-native path
writes the op; the dsh-shaped path does not.

## 4. The live run — the extension, inside a real pi

The check above reads session files. The extension reads the session **from inside pi**, and this is the receipt that
it does:

```bash
PI_SESSION_LOG_DIR=/tmp/pi-probe-2 pi --print -e .../extensions/session-log.js "Reply with exactly: probe ok"
```

```
probe ok
--- /tmp/pi-probe-2/--tmp--/01a1574b-3bf4-72d2-af51-df618b8c83af/session.v4.jsonl ---
{"type":"session","version":4,"id":"01a1574b-3bf4-72d2-af51-df618b8c83af","createdAt":1792465910773,"cwd":"/tmp"}
{"type":"user/message","seq":0,"time":1792465911815,"data":{"content":[{"type":"text","text":"Reply with exactly: probe ok"}],"source":{"kind":"user"},"role":"user","id":"pi-01a1574b-...-u1"}}
{"type":"assistant/message","seq":1,"time":1792465914846,"data":{"message":{"role":"assistant","content":[{"type":"reasoning","text":"The user is asking me to reply with exactly \"probe ok\"..."},{"type":"text","text":"probe ok"}],...
--- rows.jsonl ---
{"kind":"receipt","harness":"pi:v4","id":"01a1574b-...","source":"/tmp/pi-probe-2/--tmp--/01a1574b-.../session.v4.jsonl","sourceBytes":843,"sourceSha256":"…"}
{"kind":"message","seq":0,"exchange":0,"ordinal":1,"role":"user","type":"text","text":"Reply with exactly: probe ok","reasoning":null,"shadowed":false,"interrupted":null}
{"kind":"message","seq":1,"exchange":0,"ordinal":2,"role":"assistant","type":"text","text":"probe ok","reasoning":"The user is asking me to reply…","shadowed":false,"interrupted":null}
```

**What it shows:** the extension loaded into a live pi, the model answered, the session was written down in the format
with the header at the top level and the version that is the **format's** (4) and not pi's own session-file version
(3), the reasoning as a `reasoning` block and never as text, the ask carrying the human's `source.kind`, and the rows
carrying a receipt that names the file, its size and its sha256.

**AND THE LAYOUT IS THE DSH CORPUS'S OWN** — `<root>/<cwd-slug>/<session-id>/session.v4.jsonl`, with the slug in pi's
convention (`--tmp--` for `/tmp`). The store indexes a corpus laid out that way, so **a pi session written here is
listed, searched and read by the same store, with no change to the store.**

## 5. The conformance fixture, and the three producers

The rules are said once, in `dsh-session-rows`, and a **fixture** says what they produce. The fixture is a dsh log and
the expected rows, and the digest is pinned by every repository that vendors it.

**Measured, across the three repositories:** the vendored copies are byte-identical, and the digest of all three is
`27bb1c0c893adb4f6b52648fdff32cb17b39022f8dbea53451ac5f84058cdb66`.

**AND THE FIXTURE NOW EXERCISES EVERY RULE, which the first version did not.** An independent review measured eleven
producer mutations that the first fixture did not catch, among them the **reasoning join** — changing a producer's
`'\n'` to `' '` left the whole suite green. So the fixture was extended, and it now carries: two reasoning blocks in
one message, two text blocks in one message, a human message carrying a reasoning block, a tool call whose name and
arguments hold a NUL, a second human message so the ask-group is not always 0, a string body with a trailing space, a
stated `interrupted: false`, and a record whose content is **not** where its type says it is.

**AND THE FIXTURE IS CHECKED AGAINST ITS OWN SESSION BY THE PACKAGE**, so a fixture that drifts from the log it
describes is caught in the package's own suite rather than only in the consumers'.

**AND THE PI PRODUCER IS CHECKED AGAINST THE FIXTURE**, which is the claim the format makes: **a producer that knows
nothing about dsh makes the dsh channel's rows from a dsh log, byte for byte.** That test is
`test/conformance.test.js` here, and it is the one that would fail if the pi implementation had a dsh-shaped rule in
it.

## 6. What was NOT measured, and what would be next

- **The extension has not been run against a session with a tool call.** The live run answered in one message. The
  tool-call path is covered by the unit tests and by the 258-session corpus measurement, but not by a live run.
- **The extension has not been run against a compaction.** The corpus measurement covers the compaction in the
  *mapping*; the live path has not been exercised with one.
- **`pi --print` and the RPC mode were not compared.** The live run used `--print`.
- **The observer's producer still carries its own copies of the rules**, and the store's too, because the package is
  not on npm yet. The fixture is what keeps the copies honest in the meantime.
- **The store has not been pointed at a pi corpus.** The layout is the store's own and the corpus filter is a
  `corpus` column, so it should work — but it has not been run, and "should" is not a measurement.
