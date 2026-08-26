# dsh-subagent-error-details

DSH plugin: tell the parent agent **why** a background subagent failed.

## The problem

When a background subagent dies mid-turn (e.g. a model API 429 rate-limit), the official settlement notice reads:

```
Background subagent <id> failed before it finished.
Its closing message:
```

and then nothing. The failure reason is discarded by core `dsh-subagent` (`notifySettlement` maps `stopReason` to a fixed sentence and splices the child's last partial output, which for a mid-turn death is reasoning + tool-call blocks only). The real error is recorded in the child session's terminal `turn/end` event — but nothing delivers it to the parent.

Upstream discussion: [deepseek-harness#4334](https://github.com/deepseek-ai/deepseek-harness/discussions/4334).

## What this plugin does

1. Listens to the public `subagent/end` event as a host-plane bundle: the scope-carried event bubbles up the scope chain, so one instance observes the delegations of every parent agent, regardless of the preset each session runs on.
2. On `stopReason === "error"`, resolves the child session's terminal `turn/end` failure detail via `sessionPersistence.load()` (live session store first, durable JSONL log second) and routes back to the owning parent through the child session header's `parentSession` and the agent registry.
3. Delivers a short companion message to the parent, mirroring core's followup/steer split:

```
Subagent <id> failed with: RATE_LIMIT: 429 Rate limit exceeded for api_key ... Limit resets at ...
```

Once core itself includes the failure text in the official notice (the upstream fix), the inbox watcher detects it and suppresses the companion message automatically.

## Install

One command, works for every agent preset — no composition editing:

```bash
dsh plugin --profile web add dsh-subagent-error-details
```

(the CLI command is a pnpm wrapper; `cd ~/.dsh/profiles/web && pnpm add dsh-subagent-error-details` is equivalent). The bundle patch mounts the plugin into the profile composition, which is rebuilt at boot, so **restart dsh** to activate.

Local development installs from a checkout instead:

```bash
cd ~/.dsh/profiles/web
pnpm add file:/path/to/dsh-subagent-error-details
# restart dsh
```

## Design guarantees

- **Never breaks the parent loop**: every path is wrapped; a plugin bug degrades to "no details" instead of an error.
- **Zero inject, lazy service lookup**: services are resolved via `ctx.get` inside the handlers and every absence degrades gracefully, so activation can never fail a session mount.
- **Defensive parsing**: session-schema drift degrades gracefully; never crashes on unknown shapes.
- **Version contract**: `dsh.engines.dsh: ">=0.1.1-rc.2 <0.2"` plus peer dependencies pinned to the harness packages it consumes (`dsh-agent`, `dsh-session`, `dsh-subagent`, `dsh-llm`, `dsh-session-persistence`, `cordis`). Because dsh is pre-release with no compatibility promise, re-verify against each new dsh rc.

## Known limitations

- The official notice text itself is unchanged (core generates it); this plugin adds a companion message.
- One-shot in-process runs without a session record can only report `stopReason`, no detail.
- The durable read depends on the session checkpoint policy having flushed the `turn/end` event; a bounded retry covers the common window.

## Development

```bash
pnpm install
pnpm build      # tsc
pnpm test       # node --test test/extract.test.mjs
```

## License

MIT
