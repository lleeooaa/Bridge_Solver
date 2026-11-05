import type { PlayedCard } from "../bridge";
import { getDdsRuntimeUrl } from "../dds/browser";
import { analysisAborted } from "../dds/engine";
import type { Advice, AdvisorInput, AdvisorOptions } from "./types";

export type AdvisorRequest =
    | { type: "analyze"; id: number; input: AdvisorInput; history: readonly PlayedCard[]; options: AdvisorOptions; runtimeUrl: string; beliefRuntimeUrl: string }
    | { type: "cancel"; id: number };

export type AdvisorResponse =
    | { type: "progress"; id: number; advice: Advice }
    | { type: "result"; id: number; advice: Advice }
    | { type: "error"; id: number; message: string; cancelled: boolean };

export interface AdvisorClient {
    analyze: (
        input: AdvisorInput, history: readonly PlayedCard[], options: AdvisorOptions,
        signal: AbortSignal, progress: (advice: Advice) => void,
    ) => Promise<Advice>;
    dispose: () => void;
}

export const createAdvisorClient = (): AdvisorClient => {
    const worker = new Worker(new URL("./advisor.worker.ts", import.meta.url), { type: "module" });
    let nextId = 0;
    let closed = false;
    let pending: {
        id: number; resolve: (advice: Advice) => void; reject: (error: Error) => void;
        progress: (advice: Advice) => void; cleanup: () => void;
    } | undefined;
    const rejectPending = (error: Error): void => {
        const request = pending;
        pending = undefined;
        request?.cleanup();
        request?.reject(error);
    };
    const close = (error: Error): void => {
        closed = true;
        rejectPending(error);
        worker.onmessage = null;
        worker.onerror = null;
        worker.terminate();
    };
    worker.onmessage = (event: MessageEvent<AdvisorResponse>): void => {
        const response = event.data;
        if (pending?.id !== response.id) return;
        if (response.type === "progress") {
            pending.progress(response.advice);
        } else if (response.type === "result") {
            const request = pending;
            pending = undefined;
            request.cleanup();
            request.resolve(response.advice);
        } else {
            rejectPending(response.cancelled ? analysisAborted() : new Error(response.message));
        }
    };
    worker.onerror = (event: ErrorEvent): void => close(new Error(event.message || "The advisor worker failed."));
    return {
        analyze: (input, history, options, signal, progress) => {
            if (closed) return Promise.reject(new Error("Advisor session is closed."));
            if (signal.aborted) return Promise.reject(analysisAborted());
            if (pending !== undefined) {
                try {
                    worker.postMessage({ type: "cancel", id: pending.id } satisfies AdvisorRequest);
                } catch (error: unknown) {
                    const failure = error instanceof Error ? error : new Error("Could not cancel the superseded request.");
                    close(failure);
                    return Promise.reject(failure);
                }
                rejectPending(analysisAborted());
            }
            return new Promise((resolve, reject) => {
                const id = ++nextId;
                const abort = (): void => {
                    if (pending?.id !== id) return;
                    rejectPending(analysisAborted());
                    try {
                        worker.postMessage({ type: "cancel", id } satisfies AdvisorRequest);
                    } catch (error: unknown) {
                        close(error instanceof Error ? error : new Error("Could not cancel advisor analysis."));
                    }
                };
                pending = { id, resolve, reject, progress, cleanup: () => signal.removeEventListener("abort", abort) };
                signal.addEventListener("abort", abort, { once: true });
                try {
                    worker.postMessage({
                        type: "analyze", id, input, history,
                        options: options.belief?.type === "learned" ? {
                            ...options, belief: { type: "learned", manifestUrl: new URL(options.belief.manifestUrl, document.baseURI).href },
                        } : options,
                        runtimeUrl: getDdsRuntimeUrl(), beliefRuntimeUrl: new URL("onnx/", document.baseURI).href,
                    } satisfies AdvisorRequest);
                } catch (error: unknown) {
                    close(error instanceof Error ? error : new Error("Could not send advisor analysis."));
                }
            });
        },
        dispose: () => close(new Error("Advisor session is closed.")),
    };
};
