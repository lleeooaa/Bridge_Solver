import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RANKS, SUITS, createSampleHands } from "../bridge";
import { buildPlayState, getLegalCards } from "../play";
import { createBrowserDdsEngine } from "./browser";
import type { DdsRequest, DdsResponse } from "./engine";

class FakeWorker extends EventTarget {
    static instances: FakeWorker[] = [];
    readonly errors: Event[] = [];
    postMessage = vi.fn((_request: DdsRequest): void => {});
    terminate = vi.fn(() => { this.fail("Canceled importScripts"); });
    constructor(_url: string) {
        super();
        FakeWorker.instances.push(this);
    }
    fail(message: string): void {
        const event = Object.assign(new Event("error", { cancelable: true }), { message });
        this.errors.push(event);
        this.dispatchEvent(event);
    }
    respond(response: DdsResponse): void {
        this.dispatchEvent(new MessageEvent("message", { data: response }));
    }
}

const latestWorker = (): FakeWorker => {
    const worker = FakeWorker.instances.at(-1);
    if (worker === undefined) throw new Error("Missing DDS worker.");
    return worker;
};

beforeEach(() => {
    FakeWorker.instances = [];
    vi.stubGlobal("Worker", FakeWorker);
});
afterEach(() => vi.unstubAllGlobals());

describe("browser DDS worker errors", () => {
    const contract = { level: 1, strain: "no-trump", declarer: "North", doubling: "undoubled" } as const;
    const state = (): ReturnType<typeof buildPlayState> => buildPlayState({ hands: createSampleHands(), contract });

    it("contains late termination errors and can start a fresh runtime after abort", async () => {
        const engine = createBrowserDdsEngine("https://example.test/bridge/dds/runtime-worker.js");
        const controller = new AbortController();
        try {
            const first = engine.evaluate(state(), contract, controller.signal);
            const rejected = expect(first).rejects.toMatchObject({ name: "AbortError" });
            const terminated = latestWorker();
            controller.abort();
            await rejected;
            expect(terminated.terminate).toHaveBeenCalledOnce();
            expect(terminated.errors[0]?.defaultPrevented).toBe(true);

            const position = state();
            const second = engine.evaluate(position, contract, new AbortController().signal);
            const replacement = latestWorker();
            expect(replacement).not.toBe(terminated);
            const request = replacement.postMessage.mock.calls[0]?.[0];
            if (request === undefined) throw new Error("Missing DDS request.");
            const cards = getLegalCards(position);
            replacement.respond({
                id: request.id,
                cards: cards.map((card) => ({
                    suit: SUITS.indexOf(card.suit), rank: RANKS.indexOf(card.rank) + 2, score: 5,
                })),
            });
            await expect(second).resolves.toHaveLength(cards.length);
        } finally {
            engine.dispose();
        }
    });

    it("still rejects active requests on genuine runtime errors", async () => {
        const engine = createBrowserDdsEngine("https://example.test/bridge/dds/runtime-worker.js");
        try {
            const result = engine.evaluate(state(), contract, new AbortController().signal);
            const rejected = expect(result).rejects.toThrow("WASM failed to load");
            const worker = latestWorker();
            worker.fail("WASM failed to load");
            await rejected;
            expect(worker.errors.every((event) => event.defaultPrevented)).toBe(true);
            expect(worker.terminate).toHaveBeenCalledOnce();
        } finally {
            engine.dispose();
        }
    });
});
