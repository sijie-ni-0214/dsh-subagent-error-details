/**
 * Durable attribution for this plugin's companion notices.
 *
 * dsh 0.2.0 removed the shared catch-all `plugin` source kind. The message
 * source map is now a merge-extensible sum type: every producer declares its
 * own `kind` by augmenting `MessageSourceMap` from its own module, exactly as
 * `@deepseek-ai/dsh-subagent` does for `subagent-settled` and
 * `agent-message`. The declaration is a type-level contract only — the
 * session layer accepts any non-empty string kind on a user message and
 * consumers fall through kinds they do not know.
 *
 * @module dsh-subagent-error-details/message-source
 */
import type { SessionId } from "@deepseek-ai/dsh-session";

/** Durable attribution for one failure-detail companion notice. */
export interface SubagentErrorDetailsMessageSource {
    readonly kind: "subagent-error-details";
    /** A runtime account shown without expanding the row (`notice` form). */
    readonly form: "notice";
    /** One-line account of what this message reports. */
    readonly summary: string;
    /** Session id of the child whose failure is reported. */
    readonly senderSessionId: SessionId;
}

declare module "@deepseek-ai/dsh-llm" {
    interface MessageSourceMap {
        "subagent-error-details": SubagentErrorDetailsMessageSource;
    }
}
