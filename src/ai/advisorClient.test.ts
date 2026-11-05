import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAdvisorClient, type AdvisorRequest, type AdvisorResponse } from "./advisorClient";
import { fixture } from "./fixtures.test-support";
import { createAdvisorContext, parseAuction } from "./context";
import type { Advice } from "./types";

class FakeWorker {
    static instances: FakeWorker[] = [];
    onmessage: ((event: { data: AdvisorResponse }) => void) | null = null;
    onerror: ((event: { message: string }) => void) | null = null;
    postMessage = vi.fn((_request: AdvisorRequest): void => {});
    terminate = vi.fn();
    constructor() { FakeWorker.instances.push(this); }
}

const advice: Advice = {
    candidates: [], samples: 10, requestedSamples: 200, seed: 1,
    elapsedMilliseconds: 10, model: "uniform-hard-constraints", complete: false,
};
const worker = (): FakeWorker => {
    const value = FakeWorker.instances.at(-1);
    if (value === undefined) throw new Error("Missing worker.");
    return value;
};

beforeEach(() => {
    FakeWorker.instances = [];
    vi.stubGlobal("Worker", FakeWorker);
    vi.stubGlobal("document", { baseURI: "https://example.test/bridge/" });
});
afterEach(() => vi.unstubAllGlobals());

describe("advisor worker client", () => {
    it("sends only visible information and forwards matching progressive and final results", async () => {
        const client = createAdvisorClient();
        const progress = vi.fn();
        const input = {
            ...fixture().input, context: {
                ...createAdvisorContext(), dealer: "North" as const, auction: parseAuction("3NT P P P", "North"),
            },
        };
        const result = client.analyze(input, [], { samples: 200, seed: 1 }, new AbortController().signal, progress);
        const request = worker().postMessage.mock.calls[0]?.[0];
        expect(request).toMatchObject({ type: "analyze", runtimeUrl: "https://example.test/bridge/dds/runtime-worker.js", input });
        expect(request).not.toHaveProperty("input.hands");
        worker().onmessage?.({ data: { type: "progress", id: 999, advice } });
        expect(progress).not.toHaveBeenCalled();
        worker().onmessage?.({ data: { type: "progress", id: 1, advice } });
        expect(progress).toHaveBeenCalledWith(advice);
        const complete = { ...advice, samples: 200, complete: true };
        worker().onmessage?.({ data: { type: "result", id: 1, advice: complete } });
        await expect(result).resolves.toEqual(complete);
        client.dispose();
        expect(worker().terminate).toHaveBeenCalledOnce();
    });

    it("cancels superseded requests, ignores stale results, and supports explicit abort", async () => {
        const client = createAdvisorClient();
        const { input } = fixture();
        const first = client.analyze(input, [], { samples: 200, seed: 1 }, new AbortController().signal, vi.fn());
        const rejection = expect(first).rejects.toMatchObject({ name: "AbortError" });
        const controller = new AbortController();
        const second = client.analyze(input, [], { samples: 500, seed: 2 }, controller.signal, vi.fn());
        const aborted = expect(second).rejects.toMatchObject({ name: "AbortError" });
        await rejection;
        expect(worker().postMessage).toHaveBeenCalledWith({ type: "cancel", id: 1 });
        worker().onmessage?.({ data: { type: "result", id: 1, advice } });
        controller.abort();
        await aborted;
        expect(worker().postMessage).toHaveBeenCalledWith({ type: "cancel", id: 2 });
        client.dispose();
        await expect(client.analyze(input, [], { samples: 200, seed: 1 }, new AbortController().signal, vi.fn())).rejects.toThrow(/closed/);
    });

    it("surfaces runtime errors and post failures instead of producing advice", async () => {
        const client = createAdvisorClient();
        worker().postMessage.mockImplementation(() => { throw new Error("Send failed."); });
        await expect(client.analyze(fixture().input, [], { samples: 200, seed: 1 }, new AbortController().signal, vi.fn()))
            .rejects.toThrow("Send failed.");
        expect(worker().terminate).toHaveBeenCalledOnce();
    });
});
