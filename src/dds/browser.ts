import { createDdsEngine, type DdsEngine, type DdsResponse } from "./engine";

export const getDdsRuntimeUrl = (): string =>
    new URL("dds/runtime-worker.js", document.baseURI).href;

export const createBrowserDdsEngine = (runtimeUrl: string): DdsEngine =>
    createDdsEngine(() => {
        const worker = new Worker(runtimeUrl);
        // A terminated importScripts can still emit an error after subscribers detach.
        worker.addEventListener("error", (event) => event.preventDefault());
        return {
            post: (request) => worker.postMessage(request),
            subscribe: (result, error) => {
                const message = (event: MessageEvent<DdsResponse>): void => result(event.data);
                const failure = (event: ErrorEvent): void =>
                    error(new Error(event.message || "DDS runtime failed. Check cross-origin isolation and WASM support."));
                worker.addEventListener("message", message);
                worker.addEventListener("error", failure);
                return () => {
                    worker.removeEventListener("message", message);
                    worker.removeEventListener("error", failure);
                };
            },
            terminate: () => worker.terminate(),
        };
    });
