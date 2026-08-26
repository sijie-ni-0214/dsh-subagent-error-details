import { test } from "node:test";
import assert from "node:assert/strict";
import { failureFromEvents } from "../lib/extract.js";

// Real payload shape captured from a failed child session
// (~/.dsh/sessions/.../session.jsonl.zstd): a mid-turn death by 429.
const RATE_LIMIT_TURN_END = {
    type: "turn/end",
    seq: 11090,
    time: 1787552373443,
    data: {
        turn: 1,
        reason: {
            kind: "error",
            error: {
                message:
                    '429: {"message":"Rate limit exceeded for api_key: 60c8…. Limit type: requests. Current limit: 30, Remaining: 0. Limit resets at: 2026-08-24 06:20:33 UTC","type":"throttling_error","param":null,"code":"429"}',
                code: "RATE_LIMIT",
            },
        },
    },
};

test("extracts RATE_LIMIT detail from terminal turn/end", () => {
    const events = [
        { type: "turn/start", data: {} },
        { type: "step/start", data: {} },
        { type: "step/end", data: {} },
        RATE_LIMIT_TURN_END,
    ];
    const detail = failureFromEvents(events);
    assert.ok(detail.startsWith("RATE_LIMIT: 429: "));
    assert.ok(detail.includes("Rate limit exceeded for api_key"));
    assert.ok(detail.includes("Limit resets at"));
});

test("ignores completed turns and finds the error one", () => {
    const events = [
        { type: "turn/start", data: {} },
        {
            type: "turn/end",
            data: { turn: 1, reason: { kind: "completed" } },
        },
        { type: "turn/start", data: {} },
        RATE_LIMIT_TURN_END,
    ];
    const detail = failureFromEvents(events);
    assert.ok(detail.startsWith("RATE_LIMIT: 429: "));
});

test("tolerates missing error fields", () => {
    const events = [
        {
            type: "turn/end",
            data: { turn: 1, reason: { kind: "error", error: {} } },
        },
    ];
    assert.equal(
        failureFromEvents(events),
        "unknown error (turn/end carried no message)"
    );
});

test("returns undefined when no error turn/end exists", () => {
    const events = [
        { type: "turn/start", data: {} },
        { type: "turn/end", data: { reason: { kind: "completed" } } },
    ];
    assert.equal(failureFromEvents(events), undefined);
    assert.equal(failureFromEvents([]), undefined);
});
