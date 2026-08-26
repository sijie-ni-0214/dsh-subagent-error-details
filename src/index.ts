/**
 * dsh-subagent-error-details
 *
 * DSH agent-plane plugin that enriches failed-subagent settlement notices.
 *
 * Problem it fixes: when a background subagent dies mid-turn (e.g. a model
 * API 429 rate-limit), the official notice says only
 *
 *     Background subagent <id> failed before it finished.
 *     Its closing message:
 *
 * and then nothing — the failure reason is discarded by core
 * (`notifySettlement` maps `stopReason` to a fixed sentence and splices the
 * child's last partial output, which for a mid-turn death is reasoning +
 * tool-call blocks only). The real error IS recorded in the child session's
 * terminal `turn/end` event, so this plugin reads it and delivers a short
 * companion message to the parent agent.
 *
 * Mounting: host-plane bundle (dsh.bundle.patch inserts the row into the
 * profile composition). Scope-carried `subagent/end` events bubble up the
 * scope chain, so this single host instance observes the delegations of
 * every parent agent regardless of the preset each session runs on; each
 * failure is routed back to its own parent via the child session header's
 * `parentSession` and the host-level agent registry.
 *
 * Design notes:
 * - Delivery mirrors core's own followup/steer split (dsh-subagent
 *   notifySettlement): followup when the parent is idle, steer when it is
 *   running, so the detail lands in the same or the next turn without
 *   disturbing the loop.
 * - Feature-detect: once core starts including the failure text in the
 *   official notice (upstream discussion #4334), the inbox watcher marks the
 *   child as core-handled and no companion message is sent.
 * - Every path is defensive: parsing tolerates schema drift, all work is
 *   wrapped so a plugin bug can degrade to "no details" but never break the
 *   parent agent loop.
 */
import type { Agent } from "@deepseek-ai/dsh-agent";
import type { MessageId, UserMessage } from "@deepseek-ai/dsh-llm";
import type { SessionEvent, SessionId } from "@deepseek-ai/dsh-session";
import type { SubagentRunEndInfo } from "@deepseek-ai/dsh-subagent";
import type { Context } from "@deepseek-ai/cordis";
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync } from "node:fs";
import { failureFromEvents } from "./extract.js";

export const name = "dsh-subagent-error-details";

/**
 * Intentionally empty: every service is resolved lazily via `ctx.get` inside
 * the handlers. Agent-plane rows activate in a standing scope above the
 * per-agent scopes, and a service declared in `inject` that is only
 * registered deeper in the tree would fail activation and take the whole
 * session-creation mount down with it.
 */
export const inject = [];

/** How the settlement registry remembers one failed child run. */
interface FailedRun {
    childId: SessionId;
    parentSessionId?: SessionId;
    /** Set when the official notice already explains the failure (core fixed). */
    coreHandled?: boolean;
    at: number;
}

/** Minimal structural views used for defensive cross-version access. */
interface PersistenceServiceLike {
    load(id: SessionId): Promise<
        | { meta?: { parentSession?: SessionId }; events: readonly SessionEvent[] }
        | undefined
    >;
}

/** Failure text the official notice carries once core includes it. */
const CORE_FIXED_MARKERS = ["It failed with", "Failed with"] as const;

const DURABLE_RETRY_DELAY_MS = 300;
const DURABLE_RETRY_MAX = 5;
const REGISTRY_TTL_MS = 10 * 60_000;

/**
 * Sidecar debug log for smoke testing, gated by a marker file so no env var
 * is needed: the trace is written while /tmp/dsh-subagent-error-details.debug
 * exists. REMOVE (or keep file-gated) before the first public release.
 */
function debug(...args: unknown[]): void {
    try {
        if (!existsSync("/tmp/dsh-subagent-error-details.debug")) return;
        appendFileSync(
            "/tmp/dsh-subagent-error-details.log",
            `[${new Date().toISOString()}] ${args.map(String).join(" ")}\n`
        );
    } catch {
        // Debug output must never break the host.
    }
}

/**
 * Resolve the child session's terminal failure detail through the
 * `sessionPersistence` service. Its `load(id)` checks the live session store
 * first and falls back to the durable JSONL artifact itself, so one call
 * covers both residency states. The `turn/end` event is appended at turn
 * end, before settlement, but the durable flush can trail the settlement
 * notice, hence the retries.
 */
async function resolveFailure(
    ctx: Context,
    childId: SessionId
): Promise<{ detail: string; parentSessionId?: SessionId } | undefined> {
    const persistence = ctx.get("sessionPersistence") as
        | PersistenceServiceLike
        | undefined;
    debug(
        `resolveFailure[${childId}] persistence service=${persistence === undefined ? "MISSING" : "present"}`
    );
    if (persistence === undefined) return undefined;
    for (let attempt = 0; attempt <= DURABLE_RETRY_MAX; attempt++) {
        try {
            const loaded = await persistence.load(childId);
            const detail =
                loaded === undefined
                    ? undefined
                    : failureFromEvents(loaded.events);
            debug(
                `resolveFailure[${childId}] load attempt ${attempt}: loaded=${loaded === undefined ? "none" : `events=${loaded.events.length}`}, detail=${detail === undefined ? "none" : "FOUND"}`
            );
            if (detail !== undefined) {
                return { detail, parentSessionId: loaded?.meta?.parentSession };
            }
            if (loaded === undefined) {
                // The session has no durable artifact; retrying cannot create one.
                break;
            }
            if (attempt < DURABLE_RETRY_MAX) {
                await new Promise((resolve) =>
                    setTimeout(resolve, DURABLE_RETRY_DELAY_MS)
                );
            }
        } catch (error) {
            debug(`resolveFailure[${childId}] load attempt ${attempt} ERROR: ${errorChainText(error)}`);
            ctx.logger.warn(
                `[subagent-error-details] durable read for child ${childId} failed: ${errorChainText(error)}`
            );
            return undefined;
        }
    }
    return undefined;
}

/**
 * Deliver one short companion message to the parent, mirroring the core
 * settlement notice's followup/steer split.
 */
function deliverCompanion(
    parent: Agent,
    childId: SessionId,
    detail: string
): void {
    const text = `Subagent ${childId} failed with: ${detail}`;
    // Built inline instead of via dsh-llm's createUserMessage: profiles do
    // not install harness packages, so a runtime import of dsh-llm would not
    // resolve from the profile workspace. The message shape is stable and
    // simple (stable id + role + content + source); the `plugin` source kind
    // is the documented one for plugin-produced notices.
    const message: UserMessage = {
        id: randomUUID() as MessageId,
        role: "user",
        content: [{ type: "text", text }],
        source: {
            kind: "plugin",
            plugin: name,
            form: "notice",
            summary: `subagent ${childId} failure detail`,
        },
    };
    if ((parent as { status?: string }).status === "idle") {
        parent.followup(message);
    } else {
        parent.steer(message);
    }
}

/**
 * Walk an error's cause chain into one display string (dsh-llm's errorChain,
 * inlined so the plugin keeps zero runtime dependencies).
 */
function errorChainText(error: unknown): string {
    const parts: string[] = [];
    let current: unknown = error;
    let depth = 0;
    while (current !== undefined && current !== null && depth < 8) {
        const message = (current as { message?: unknown } | undefined)
            ?.message;
        parts.push(String(message ?? current));
        current = (current as { cause?: unknown } | undefined)?.cause;
        depth += 1;
    }
    return parts.join(" <- ") || "unknown error";
}

export function apply(ctx: Context): void {
    debug("apply() mounted");
    const failed = new Map<string, FailedRun>();

    const prune = () => {
        const cutoff = Date.now() - REGISTRY_TTL_MS;
        for (const [runId, entry] of failed) {
            if (entry.at < cutoff) failed.delete(runId);
        }
    };

    // Feature-detect: when the official settlement notice already explains
    // the failure (core fixed), suppress our companion message.
    ctx.on("agent/inbox/inserted", ({ message }) => {
        try {
            const source = message.source as
                | { kind?: string; senderSessionId?: SessionId }
                | undefined;
            if (source?.kind !== "subagent-settled") return;
            const childId = source.senderSessionId;
            if (childId === undefined) return;
            const text = message.content
                .filter((block) => block.type === "text")
                .map((block) => (block as { text?: string }).text ?? "")
                .join("\n");
            debug(
                `inbox: subagent-settled notice for child ${childId}, core-fixed=${CORE_FIXED_MARKERS.some((marker) => text.includes(marker))}`
            );
            if (!CORE_FIXED_MARKERS.some((marker) => text.includes(marker))) {
                return;
            }
            for (const entry of failed.values()) {
                if (entry.childId === childId) entry.coreHandled = true;
            }
        } catch (error) {
            ctx.logger.warn(
                `[subagent-error-details] inbox inspection failed: ${errorChainText(error)}`
            );
        }
    });

    ctx.on("subagent/end", (info: SubagentRunEndInfo) => {
        debug(
            `subagent/end: stopReason=${info.stopReason} child=${info.id} runId=${String(info.runId)}`
        );
        if (info.stopReason !== "error") return;
        const runId = String(info.runId);
        const childId = info.id;
        failed.set(runId, { childId, at: Date.now() });
        prune();
        void (async () => {
            try {
                const resolved = await resolveFailure(ctx, childId);
                const entry = failed.get(runId);
                if (entry === undefined) return;
                if (entry.coreHandled || resolved === undefined) {
                    debug(
                        `enrich[${childId}] SKIP: coreHandled=${entry.coreHandled === true}, resolved=${resolved === undefined ? "undefined" : "ok"}`
                    );
                    failed.delete(runId);
                    return;
                }
                const parentSessionId =
                    resolved.parentSessionId ?? entry.parentSessionId;
                const agents = ctx.get("agents") as
                    | { get(id: SessionId): Agent | undefined }
                    | undefined;
                const parent =
                    parentSessionId === undefined || agents === undefined
                        ? undefined
                        : agents.get(parentSessionId);
                debug(
                    `enrich[${childId}] parentSessionId=${String(parentSessionId)}, parent agent=${parent === undefined ? "NOT FOUND" : "found"}`
                );
                if (parent !== undefined) {
                    deliverCompanion(parent, childId, resolved.detail);
                    debug(`enrich[${childId}] companion delivered`);
                } else {
                    ctx.logger.warn(
                        `[subagent-error-details] child ${childId} failed but parent agent ${String(parentSessionId)} is not resolvable; dropping the companion message`
                    );
                }
                failed.delete(runId);
            } catch (error) {
                debug(`enrich[${childId}] ERROR: ${errorChainText(error)}`);
                ctx.logger.warn(
                    `[subagent-error-details] enrichment for child ${childId} failed: ${errorChainText(error)}`
                );
                failed.delete(runId);
            }
        })();
    });
}
