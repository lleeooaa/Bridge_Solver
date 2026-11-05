import { expect, test } from "@playwright/test";
import { fillKnownExampleHands, openApp } from "./fixtures";

test("real browser ONNX runtime matches exported PyTorch log scores at multiple batch sizes", async ({ page }) => {
    await openApp(page);
    const differences = await page.evaluate(async () => {
        const url = new URL("onnx/ort.wasm.min.mjs", document.baseURI).href;
        const ort: typeof import("onnxruntime-web/wasm") = await import(url);
        ort.env.wasm.numThreads = 1;
        ort.env.wasm.wasmPaths = new URL("onnx/", document.baseURI).href;
        const base = new URL("models/test-only/", document.baseURI);
        const parity = await (await fetch(new URL("parity.json", base))).json();
        const encoder = await ort.InferenceSession.create(new URL("encoder.onnx", base).href);
        const decoder = await ort.InferenceSession.create(new URL("decoder.onnx", base).href);
        const integer = (values: number[], dims: number[]) =>
            new ort.Tensor("int64", BigInt64Array.from(values, BigInt), dims);
        const errors = [];
        try {
            const context = (await encoder.run({
                state: new ort.Tensor("float32", Float32Array.from(parity.encoded.state), [1, 201]),
                auction: integer(parity.encoded.auction, [1, 319]), play: integer(parity.encoded.play, [1, 52]),
            })).context;
            if (context === undefined) throw new Error("Missing encoder context.");
            for (const size of [1, 2]) {
                const rows = parity.decoderRows.slice(0, size);
                const result = await decoder.run({
                    context: new ort.Tensor("float32", Float32Array.from(Array.from({ length: size },
                        () => Array.from(context.data, Number)).flat()), [size, 8]),
                    cards: integer(rows.flatMap((row: { cards: number[] }) => row.cards), [size, 26]),
                    previous: integer(rows.flatMap((row: { previous: number[] }) => row.previous), [size, 26]),
                    allowed: new ort.Tensor("bool", Uint8Array.from(rows.flatMap((row: { allowed: number[][] }) =>
                        row.allowed.flat())), [size, 26, 2]),
                    active: new ort.Tensor("float32", Float32Array.from(rows.flatMap((row: { active: number[] }) =>
                        row.active)), [size, 26]),
                    targets: integer(rows.flatMap((row: { targets: number[] }) => row.targets), [size, 26]),
                });
                if (result.log_weights === undefined) throw new Error("Missing decoder scores.");
                errors.push(...Array.from(result.log_weights.data, Number).map((value, index) =>
                    Math.abs(value - parity.logWeights[index])));
            }
        } finally {
            await encoder.release();
            await decoder.release();
        }
        return errors;
    });
    expect(differences).toHaveLength(3);
    expect(Math.max(...differences)).toBeLessThan(1e-4);
});

test("learned advisor loads the bundled mixed-system model and explicitly switches back to uniform", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await openApp(page);
    await expect(page.locator(".advisor-disclaimer")).toContainText("bundled mixed-system auction-and-play model");
    await page.getByRole("tab", { name: "Single-dummy advisor", exact: true }).click();
    await fillKnownExampleHands(page);
    await page.getByRole("button", { name: "Start advisor", exact: true }).click();
    await page.getByRole("button", { name: "Record KD played by North", exact: true }).click();
    await page.locator("#advisor-belief-model").selectOption("learned");
    await expect(page.locator("#advisor-model-url")).toHaveCount(0);
    await expect(page.locator(".advisor-analysis [role=status]")).toContainText("Analysis complete.");
    await expect(page.locator(".advisor-analysis")).toContainText("Effective sample size:");
    await expect(page.locator(".advisor-analysis")).toContainText("Model: human-pilot-colab v1.0.0.");
    await expect(page.locator(".advisor-analysis")).toContainText("Research pilot:");
    await expect(page.locator(".advisor-results tbody tr")).toHaveCount(2);
    await page.locator("#advisor-samples").selectOption("500");
    await expect(page.locator(".advisor-analysis [role=status]")).toContainText("500/500");
    await expect(page.locator(".advisor-analysis [role=status]")).toContainText("Analysis complete.");
    await page.locator("#advisor-belief-model").selectOption("uniform");
    await expect(page.locator(".advisor-analysis [role=status]")).toContainText("Analysis complete.");
    await expect(page.locator(".advisor-analysis")).toContainText("uniform hard constraints");
    expect(errors).toEqual([]);
});
