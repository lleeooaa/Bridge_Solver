import { Worker } from "node:worker_threads";
import { createDdsEngine, type DdsEngine, type DdsResponse } from "./engine";
import type { AnalysisSessionFactory } from "../bridge";
import { createDdsAnalysisSession } from "./session";

export const createNodeAnalysisSession: AnalysisSessionFactory = (input) =>
    createDdsAnalysisSession(input, createNodeDdsEngine());

export const createNodeDdsEngine = (): DdsEngine => createDdsEngine(() => {
    const worker = new Worker(new URL("../../public/dds/runtime-worker.js", import.meta.url));
    return {
        post: (request) => worker.postMessage(request),
        subscribe: (result, error) => {
            const message = (response: DdsResponse): void => result(response);
            const exit = (code: number): void => error(new Error(`DDS worker exited unexpectedly (${code}).`));
            worker.on("message", message);
            worker.on("error", error);
            worker.on("exit", exit);
            return () => {
                worker.off("message", message);
                worker.off("error", error);
                worker.off("exit", exit);
            };
        },
        terminate: () => { void worker.terminate(); },
    };
});
