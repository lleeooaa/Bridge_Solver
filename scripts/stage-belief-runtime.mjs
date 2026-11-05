import { copyFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";

const output = resolve("public", "onnx");
await mkdir(output, { recursive: true });
for (const file of ["ort-wasm-simd-threaded.mjs", "ort-wasm-simd-threaded.wasm", "ort.wasm.min.mjs"]) {
    await copyFile(resolve("node_modules", "onnxruntime-web", "dist", file), resolve(output, file));
}
