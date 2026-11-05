import type { AnalysisSessionFactory, PlayedCard, EnginePositionAnalysis, SolverInput, EngineSolverResult } from "./bridge";
import { getDdsRuntimeUrl } from "./dds/browser";

/** Messages returned from the solver worker. */
export type SolverWorkerResponse =
    | { type: "result"; result: EngineSolverResult }
    | { type: "error"; message: string };

export type AnalysisWorkerRequest =
    | { type: "initialize"; sessionId: number; input: SolverInput; runtimeUrl: string }
    | { type: "analyze"; sessionId: number; requestId: number; history: readonly PlayedCard[] }
    | { type: "cancel"; sessionId: number; requestId: number };

export type AnalysisWorkerResponse =
    | { type: "analysis"; sessionId: number; requestId: number; result: EnginePositionAnalysis }
    | { type: "analysis-error"; sessionId: number; requestId: number; message: string; cancelled: boolean }
    | { type: "session-error"; sessionId: number; message: string };

let nextSessionId = 0;

// One bundler entry avoids duplicate worker wrappers with broken relative chunk imports.
const createSolverWorker = (): Worker =>
    new Worker(new URL("./solver.worker.ts", import.meta.url), { type: "module" });

/** A worker and its bounded transposition cache live until this deal's session is disposed. */
export const createWorkerAnalysisSession: AnalysisSessionFactory = (input) => {
    const worker = createSolverWorker();
    const sessionId = ++nextSessionId;
    let nextRequestId = 0;
    let closedError: Error | undefined;
    let pending: {
        id: number;
        resolve: (result: EnginePositionAnalysis) => void;
        reject: (error: unknown) => void;
        cleanup: () => void;
    } | undefined;
    const cancelError = (): Error => new DOMException("Position analysis cancelled.", "AbortError");

    const rejectPending = (error: unknown): void => {
        const request = pending;
        pending = undefined;
        request?.cleanup();
        request?.reject(error);
    };

    const close = (error: Error): void => {
        if (closedError !== undefined) {
            return;
        }
        closedError = error;
        rejectPending(error);
        worker.onmessage = null;
        worker.onerror = null;
        worker.terminate();
    };

    const transfer = (request: AnalysisWorkerRequest): void => {
        try {
            worker.postMessage(request);
        } catch (error: unknown) {
            close(error instanceof Error ? error : new Error("Could not send analysis request."));
        }
    };

    worker.onmessage = (event: MessageEvent<AnalysisWorkerResponse>): void => {
        const response = event.data;
        if (response.sessionId !== sessionId) {
            return;
        }
        if (response.type === "session-error") {
            close(new Error(response.message));
            return;
        }
        if (pending === undefined || response.requestId !== pending.id) {
            return;
        }
        if (response.type === "analysis-error") {
            rejectPending(response.cancelled ? cancelError() : new Error(response.message));
            return;
        }
        const request = pending;
        pending = undefined;
        request.cleanup();
        request.resolve(response.result);
    };

    worker.onerror = (event: ErrorEvent): void => {
        close(new Error(event.message || "The analysis worker failed."));
    };
    transfer({ type: "initialize", sessionId, input, runtimeUrl: getDdsRuntimeUrl() });

    if (closedError !== undefined) {
        throw closedError;
    }
    return {
        analyze: (history, signal) => {
            if (closedError !== undefined) {
                return Promise.reject(closedError);
            }
            if (signal.aborted) {
                return Promise.reject(cancelError());
            }
            rejectPending(cancelError());
            return new Promise((resolve, reject) => {
                const requestId = ++nextRequestId;

                const handleAbort = (): void => {
                    if (pending?.id !== requestId) {
                        return;
                    }
                    rejectPending(cancelError());
                    transfer({ type: "cancel", sessionId, requestId });
                };

                pending = {
                    id: requestId,
                    resolve,
                    reject,
                    cleanup: () => signal.removeEventListener("abort", handleAbort),
                };
                signal.addEventListener("abort", handleAbort, { once: true });

                transfer({ type: "analyze", sessionId, requestId, history });
            });
        },
        dispose: () => close(new Error("Analysis session is closed.")),
    };
};

/** Runs a solver request off the UI thread and supports cancelling the search. */
export const solveInWorker = (
    input: SolverInput,
    signal: AbortSignal,
): Promise<EngineSolverResult> => {
    if (signal.aborted) {
        return Promise.reject(new Error("Solver search cancelled."));
    }

    return new Promise((resolve, reject) => {
        const worker = createSolverWorker();

        /** Detaches worker listeners and releases its resources. */
        const cleanup = (): void => {
            signal.removeEventListener("abort", handleAbort);
            worker.onmessage = null;
            worker.onerror = null;
            worker.terminate();
        };

        /** Stops a running worker when the caller cancels the search. */
        const handleAbort = (): void => {
            cleanup();
            reject(new Error("Solver search cancelled."));
        };

        worker.onmessage = (event: MessageEvent<SolverWorkerResponse>): void => {
            cleanup();
            if (event.data.type === "result") {
                resolve(event.data.result);
            } else {
                reject(new Error(event.data.message));
            }
        };

        worker.onerror = (event: ErrorEvent): void => {
            cleanup();
            reject(new Error(event.message || "The solver worker failed."));
        };

        signal.addEventListener("abort", handleAbort, { once: true });
        if (signal.aborted) {
            handleAbort();
            return;
        }

        try {
            worker.postMessage({ type: "solve", input, runtimeUrl: getDdsRuntimeUrl() });
        } catch (error: unknown) {
            cleanup();
            reject(error);
        }
    });
};
