import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEmptyHands, type PositionAnalysis, type SolverInput } from "./bridge";
import { solveContract } from "./solver";
import {
    createWorkerAnalysisSession, solveInWorker,
    type AnalysisWorkerRequest, type AnalysisWorkerResponse, type SolverWorkerResponse,
} from "./solverClient";

class TestWorker {
    static instances: TestWorker[] = [];
    static postError: Error | undefined;
    onmessage: ((event: { data: SolverWorkerResponse | AnalysisWorkerResponse }) => void) | null = null;
    onerror: ((event: { message: string }) => void) | null = null;
    terminate = vi.fn();
    postMessage = vi.fn((_input: SolverInput | AnalysisWorkerRequest): void => {
        if (TestWorker.postError !== undefined) {
            throw TestWorker.postError;
        }
    });

    constructor(readonly url: URL, readonly options: WorkerOptions) {
        TestWorker.instances.push(this);
    }
}

const input: SolverInput = {
    hands: createEmptyHands(),
    contract: { level: 1, strain: "no-trump", declarer: "North", doubling: "undoubled" },
};

const latestWorker = (): TestWorker => {
    const worker = TestWorker.instances.at(-1);
    if (worker === undefined) {
        throw new Error("No worker was created.");
    }
    return worker;
};

beforeEach(() => {
    TestWorker.instances = [];
    TestWorker.postError = undefined;
    vi.stubGlobal("Worker", TestWorker);
    vi.stubGlobal("document", { baseURI: "https://example.test/bridge/" });
});

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe("solver worker client", () => {
    it("passes through the proof and optimal replay result and cleans up worker resources", async () => {
        const controller = new AbortController();
        const removeListener = vi.spyOn(controller.signal, "removeEventListener");
        const pending = solveInWorker(input, controller.signal);
        const worker = latestWorker();
        const result = solveContract(input);
        expect(result.optimalDeclarerTricks).toBe(0);
        expect(result.declarerTricksInLine).toBe(result.optimalDeclarerTricks);
        expect(result.statistics.refinementMilliseconds).toBeGreaterThanOrEqual(0);
        expect(worker.url.pathname).toContain("solver.worker.ts");
        expect(worker.options).toEqual({ type: "module" });
        expect(worker.postMessage).toHaveBeenCalledWith({
            type: "solve", input, runtimeUrl: "https://example.test/bridge/dds/runtime-worker.js",
        });
        worker.onmessage?.({ data: { type: "result", result } });
        await expect(pending).resolves.toBe(result);
        expect(worker.terminate).toHaveBeenCalledOnce();
        expect(worker.onmessage).toBeNull();
        expect(worker.onerror).toBeNull();
        expect(removeListener).toHaveBeenCalledWith("abort", expect.any(Function));
    });

    const latestAnalysisRequest = (): Extract<AnalysisWorkerRequest, { type: "analyze" }> => {
        const request = latestWorker().postMessage.mock.calls.at(-1)?.[0];
        if (request === undefined || !("type" in request) || request.type !== "analyze") {
            throw new Error("Missing position request.");
        }
        return request;
    };

    const positionResult: PositionAnalysis = {
        optimalDeclarerTricks: 0, canMakeContract: false, recommendedCards: [],
        statistics: {
            elapsedMilliseconds: 1, nodesVisited: 1, cacheHits: 0, cacheEntries: 0,
            fromCache: false, inheritedValue: false,
            phaseStatistics: {
                proof: { elapsedMilliseconds: 0, nodesVisited: 0, cacheHits: 0, probeCount: 0 },
                refinement: { elapsedMilliseconds: 0, nodesVisited: 0, cacheHits: 0, probeCount: 0 },
                recommendation: { elapsedMilliseconds: 0, nodesVisited: 0, cacheHits: 0, probeCount: 0 },
            },
        },
    };

    describe("persistent analysis worker client", () => {
        it("initializes once, reuses its worker, and cleans up listeners after each result", async () => {
            const session = createWorkerAnalysisSession(input);
            const worker = latestWorker();
            const signal = new AbortController().signal;
            const cleanup = vi.spyOn(signal, "removeEventListener");
            expect(worker.postMessage.mock.calls[0]?.[0]).toMatchObject({ type: "initialize", input });
            for (let count = 0; count < 3; count += 1) {
                const pending = session.analyze([], signal);
                const request = latestAnalysisRequest();
                worker.onmessage?.({ data: { ...request, type: "analysis", result: positionResult } });
                await expect(pending).resolves.toBe(positionResult);
            }
            expect(TestWorker.instances).toHaveLength(1);
            expect(worker.terminate).not.toHaveBeenCalled();
            expect(cleanup).toHaveBeenCalledTimes(3);
            session.dispose();
            session.dispose();
            expect(worker.terminate).toHaveBeenCalledOnce();
            await expect(session.analyze([], signal)).rejects.toThrow(/closed/i);
        });

        it("rejects superseded requests and ignores stale request and session responses", async () => {
            const session = createWorkerAnalysisSession(input);
            const signal = new AbortController().signal;
            const first = session.analyze([], signal);
            const firstRequest = latestAnalysisRequest();
            const rejected = expect(first).rejects.toMatchObject({ name: "AbortError" });
            const second = session.analyze([], signal);
            const request = latestAnalysisRequest();
            const worker = latestWorker();
            await rejected;
            let resolved = false;
            void second.then(() => { resolved = true; });
            worker.onmessage?.({ data: { ...firstRequest, type: "analysis", result: positionResult } });
            worker.onmessage?.({ data: { ...request, sessionId: -1, type: "analysis", result: positionResult } });
            await Promise.resolve();
            expect(resolved).toBe(false);
            worker.onmessage?.({ data: { ...request, type: "analysis", result: positionResult } });
            await expect(second).resolves.toBe(positionResult);
            session.dispose();
        });

        it("sends cooperative cancellation without destroying a reusable worker", async () => {
            const session = createWorkerAnalysisSession(input);
            const controller = new AbortController();
            const pending = session.analyze([], controller.signal);
            const request = latestAnalysisRequest();
            const removeListener = vi.spyOn(controller.signal, "removeEventListener");
            controller.abort();
            await expect(pending).rejects.toMatchObject({ name: "AbortError" });
            const worker = latestWorker();
            expect(worker.postMessage).toHaveBeenLastCalledWith({
                type: "cancel", sessionId: request.sessionId, requestId: request.requestId,
            });
            expect(removeListener).toHaveBeenCalledWith("abort", expect.any(Function));
            expect(worker.terminate).not.toHaveBeenCalled();
            await expect(session.analyze([], controller.signal)).rejects.toMatchObject({ name: "AbortError" });
            session.dispose();
        });

        it("reports per-position errors, allows retry, and closes on worker failure", async () => {
            const session = createWorkerAnalysisSession(input);
            const signal = new AbortController().signal;
            const failed = session.analyze([], signal);
            const request = latestAnalysisRequest();
            const worker = latestWorker();
            worker.onmessage?.({
                data: {
                    ...request,
                    type: "analysis-error",
                    message: "Illegal history.",
                    cancelled: false,
                },
            });
            await expect(failed).rejects.toThrow("Illegal history.");
            const retry = session.analyze([], signal);
            worker.onerror?.({ message: "Worker crashed." });
            await expect(retry).rejects.toThrow("Worker crashed.");
            expect(worker.terminate).toHaveBeenCalledOnce();
            await expect(session.analyze([], signal)).rejects.toThrow("Worker crashed.");
        });

        it("rejects pending work on disposal and initialization errors", async () => {
            const session = createWorkerAnalysisSession(input);
            const signal = new AbortController().signal;
            const pending = session.analyze([], signal);
            session.dispose();
            await expect(pending).rejects.toThrow(/closed/i);
            const next = createWorkerAnalysisSession(input);
            const work = next.analyze([], signal);
            const request = latestAnalysisRequest();
            latestWorker().onmessage?.({
                data: {
                    type: "session-error", sessionId: request.sessionId, message: "Duplicate card.",
                }
            });
            await expect(work).rejects.toThrow("Duplicate card.");
            expect(latestWorker().terminate).toHaveBeenCalledOnce();
        });

        it("closes explicitly if transferring initialization or a later request fails", async () => {
            TestWorker.postError = new Error("Cannot initialize.");
            expect(() => createWorkerAnalysisSession(input)).toThrow("Cannot initialize.");
            expect(latestWorker().terminate).toHaveBeenCalledOnce();
            TestWorker.postError = undefined;
            const session = createWorkerAnalysisSession(input);
            TestWorker.postError = new Error("Cannot transfer.");
            await expect(session.analyze([], new AbortController().signal)).rejects.toThrow("Cannot transfer.");
            expect(latestWorker().terminate).toHaveBeenCalledOnce();
        });
    });

    it("does not start a worker for an already cancelled request", async () => {
        const controller = new AbortController();
        controller.abort();
        await expect(solveInWorker(input, controller.signal)).rejects.toThrow(/cancelled/i);
        expect(TestWorker.instances).toHaveLength(0);
    });

    it("terminates an active search on cancellation instead of returning a defeated contract", async () => {
        const controller = new AbortController();
        const pending = solveInWorker(input, controller.signal);
        const worker = latestWorker();
        controller.abort();
        await expect(pending).rejects.toThrow(/cancelled/i);
        expect(worker.terminate).toHaveBeenCalledOnce();
        expect(worker.onmessage).toBeNull();
    });

    it("rejects solver errors rather than representing them as a false proof", async () => {
        const pending = solveInWorker(input, new AbortController().signal);
        const worker = latestWorker();
        worker.onmessage?.({ data: { type: "error", message: "Invalid deal." } });
        await expect(pending).rejects.toThrow("Invalid deal.");
        expect(worker.terminate).toHaveBeenCalledOnce();
    });

    it("rejects worker failures and releases the worker", async () => {
        const pending = solveInWorker(input, new AbortController().signal);
        const worker = latestWorker();
        worker.onerror?.({ message: "Worker crashed." });
        await expect(pending).rejects.toThrow("Worker crashed.");
        expect(worker.terminate).toHaveBeenCalledOnce();
    });

    it("rejects message transfer errors and releases the worker", async () => {
        TestWorker.postError = new Error("Could not transfer input.");
        const pending = solveInWorker(input, new AbortController().signal);
        await expect(pending).rejects.toThrow("Could not transfer input.");
        expect(latestWorker().terminate).toHaveBeenCalledOnce();
    });
});
