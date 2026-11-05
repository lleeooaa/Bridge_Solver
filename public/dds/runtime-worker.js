/* Library DDS runs in a dedicated worker in both browsers and Node. */
"use strict";

const nodeRuntime = typeof process !== "undefined" && Boolean(process.versions?.node);
let send;
let listen;
let factory;

if (nodeRuntime) {
    const { parentPort, workerData } = require("node:worker_threads");
    factory = require("./dds_web_wasm.js");
    if (workerData !== "em-pthread") {
        send = (message) => parentPort.postMessage(message);
        listen = (handler) => parentPort.on("message", handler);
    }
} else {
    importScripts("./dds_web_wasm.js");
    if (!self.name?.startsWith("em-pthread")) {
        if (!self.crossOriginIsolated) {
            throw new Error("DDS requires cross-origin isolation. Reload after the isolation service worker activates, or use a server with COOP/COEP headers.");
        }
        factory = createDdsModule;
        send = (message) => self.postMessage(message);
        listen = (handler) => { self.onmessage = (event) => handler(event.data); };
    }
}

if (listen) {
    // Upstream's generated loader names the Bazel binary *_cc.wasm; the
    // published artifact has a different name. Supply its bytes explicitly.
    const ready = nodeRuntime
        ? factory({ wasmBinary: require("node:fs").readFileSync(require("node:path").join(__dirname, "dds_web_wasm.wasm")) })
        : fetch(new URL("./dds_web_wasm.wasm", self.location.href)).then(async (response) => {
            if (!response.ok) throw new Error(`Could not load DDS WASM (${response.status}).`);
            return factory({ wasmBinary: new Uint8Array(await response.arrayBuffer()) });
        });
    let queue = Promise.resolve();
    listen((request) => {
        queue = queue.then(async () => {
            let module;
            let output = 0;
            try {
                module = await ready;
                output = module._malloc(40 * 4);
                if (!output) throw new Error("DDS could not allocate its result buffer.");
                const trick = [...request.trick];
                while (trick.length < 6) trick.push(0, 0);
                const code = module.ccall(
                    "dds_web_solve_plays", "number",
                    ["string", "number", "number", "number", "number", "number", "number", "number", "number", "number"],
                    [request.pbn, request.trump, request.first, ...trick, output],
                );
                if (code !== 1) throw new Error(`Library DDS rejected the position (error ${code}).`);
                const count = module.getValue(output, "i32");
                if (count < 1 || count > 13) throw new Error(`DDS returned an invalid card count: ${count}.`);
                const cards = [];
                for (let index = 0; index < count; index += 1) {
                    const address = output + 4 + index * 12;
                    cards.push({
                        suit: module.getValue(address, "i32"),
                        rank: module.getValue(address + 4, "i32"),
                        score: module.getValue(address + 8, "i32"),
                    });
                }
                send({ id: request.id, cards });
            } catch (error) {
                send({ id: request.id, error: error instanceof Error ? error.message : String(error) });
            } finally {
                if (output) module._free(output);
            }
        });
    });
}
