import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

const modelRoot = resolve("public", "models");
const manifests = new Map();
const onnxFiles = [];

const collectModels = async (directory) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) {
            await collectModels(path);
        } else if (entry.isFile() && entry.name === "manifest.json") {
            const manifest = JSON.parse(await readFile(path, "utf8"));
            if (manifest === null || typeof manifest !== "object" || Array.isArray(manifest)) {
                throw new Error(`Invalid model manifest: ${path}`);
            }
            if (manifest.localOnly === true || manifest.modelDistributionAllowed !== true) {
                throw new Error(`Refusing to build with a model that is not approved for distribution: ${path}`);
            }
            manifests.set(path, manifest);
        } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".onnx")) {
            onnxFiles.push(path);
        }
    }
};

if (existsSync(modelRoot)) await collectModels(modelRoot);
for (const path of onnxFiles) {
    if (!manifests.has(join(dirname(path), "manifest.json"))) {
        throw new Error(`Refusing to build an ONNX model without a colocated manifest: ${path}`);
    }
}
console.log("Public model distribution checks passed.");
