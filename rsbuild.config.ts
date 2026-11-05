import { defineConfig } from "@rsbuild/core";
import { pluginReact } from "@rsbuild/plugin-react";

export default defineConfig({
    plugins: [pluginReact()],
    tools: {
        rspack: {
            resolve: { conditionNames: ["onnxruntime-web-use-extern-wasm", "..."] },
        },
    },
    html: {
        template: "./index.html",
    },
    server: {
        headers: {
            "Cross-Origin-Opener-Policy": "same-origin",
            "Cross-Origin-Embedder-Policy": "require-corp",
        },
    },
    output: {
        assetPrefix: "./",
    },
});
