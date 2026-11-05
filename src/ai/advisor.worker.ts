import { createBrowserDdsEngine } from "../dds/browser";
import type { DdsEngine } from "../dds/engine";
import { analyzeAdvisor } from "./analyze";
import { buildBeliefFeatures } from "./belief";
import { encodeBeliefFeatures } from "./beliefEncoding";
import type { AdvisorRequest, AdvisorResponse } from "./advisorClient";
import type { OnnxBeliefModel } from "./onnxBelief";

declare let __webpack_public_path__: string;

let engine: DdsEngine | undefined;
let active: { id: number; controller: AbortController } | undefined;
let loaded: { url: string; model: OnnxBeliefModel } | undefined;
let queue: Promise<void> = Promise.resolve();
const post = (response: AdvisorResponse): void => self.postMessage(response);

self.onmessage = (event: MessageEvent<AdvisorRequest>): void => {
    const request = event.data;
    if (request.type === "cancel") {
        if (active?.id === request.id) active.controller.abort();
        return;
    }
    active?.controller.abort();
    const controller = new AbortController();
    active = { id: request.id, controller };
    // Lazy worker chunks must resolve from the Pages base, not the nested worker directory.
    __webpack_public_path__ = new URL("../", request.beliefRuntimeUrl).href;
    queue = queue.then(async () => {
        if (controller.signal.aborted) return;
        const selected = request.options.belief;
        let model: OnnxBeliefModel | undefined;
        if (selected?.type === "learned") {
            encodeBeliefFeatures(buildBeliefFeatures(request.input, request.history));
            if (loaded?.url !== selected.manifestUrl) {
                await loaded?.model.dispose();
                loaded = undefined;
                const { loadOnnxBelief } = await import("./onnxBelief");
                const next = await loadOnnxBelief(selected.manifestUrl, request.beliefRuntimeUrl, controller.signal);
                loaded = { url: selected.manifestUrl, model: next };
            }
            model = loaded.model;
        }
        if (controller.signal.aborted) return;
        engine ??= createBrowserDdsEngine(request.runtimeUrl);
        const advice = await analyzeAdvisor(request.input, request.history, request.options, engine, controller.signal, (value) => {
            if (!controller.signal.aborted) post({ type: "progress", id: request.id, advice: value });
        }, model);
        if (!controller.signal.aborted) post({ type: "result", id: request.id, advice });
    }).catch((error: unknown) => {
        post({
            type: "error", id: request.id,
            message: error instanceof Error ? error.message : "Advisor analysis failed.",
            cancelled: controller.signal.aborted,
        });
    }).finally(() => {
        if (active?.controller === controller) active = undefined;
    });
};
