/**
 * Pure parsing helpers, split out so they can be unit-tested without a
 * live harness.
 */
import type { SessionEvent } from "@deepseek-ai/dsh-session";

/** Minimal structural view of a `turn/end` event payload. */
export interface TurnEndLike {
    type?: string;
    data?: {
        reason?: {
            kind?: string;
            error?: { code?: string; message?: string };
        };
    };
}

/**
 * Extract the failure detail from a session event log: the terminal
 * `turn/end` event whose reason kind is "error" carries `error.code` and
 * `error.message` (e.g. `RATE_LIMIT` + the 429 API text).
 */
export function failureFromEvents(
    events: readonly SessionEvent[]
): string | undefined {
    for (let i = events.length - 1; i >= 0; i--) {
        const event = events[i] as unknown as TurnEndLike;
        if (event.type !== "turn/end") continue;
        const reason = event.data?.reason;
        if (reason?.kind !== "error") continue;
        const { code, message } = reason.error ?? {};
        const detail = [code, message].filter(Boolean).join(": ");
        return detail || "unknown error (turn/end carried no message)";
    }
    return undefined;
}
