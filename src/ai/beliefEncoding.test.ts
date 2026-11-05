import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { BeliefCandidate, BeliefFeatures } from "./belief";
import { encodeBeliefCandidate, encodeBeliefFeatures } from "./beliefEncoding";
import { defaultBeliefManifestUrl, isLoopbackHostname } from "./modelPolicy";
import { validateOnnxManifest } from "./onnxBelief";

const parity: {
    features: BeliefFeatures; candidates: BeliefCandidate[];
    encoded: { state: number[]; auction: number[]; play: number[] };
    decoderRows: { cards: number[]; previous: number[]; allowed: number[][]; active: number[]; targets: number[] }[];
} = JSON.parse(readFileSync(new URL("../../e2e/fixtures/belief/parity.json", import.meta.url), "utf8"));
const manifest: unknown = JSON.parse(readFileSync(new URL("../../e2e/fixtures/belief/manifest.json", import.meta.url), "utf8"));

describe("Python/browser belief tensor contract", () => {
    it("uses the bundled public model path on both development and hosted sites", () => {
        expect(isLoopbackHostname("localhost")).toBe(true);
        expect(isLoopbackHostname("127.0.0.1")).toBe(true);
        expect(isLoopbackHostname("[::1]")).toBe(true);
        expect(isLoopbackHostname("bridge.example.com")).toBe(false);
        expect(defaultBeliefManifestUrl("localhost")).toBe("models/belief/manifest.json");
        expect(defaultBeliefManifestUrl("bridge.example.com")).toBe("models/belief/manifest.json");
    });

    it("matches the real exported Python feature and autoregressive constraint tensors", () => {
        const encoded = encodeBeliefFeatures(parity.features);
        expect(encoded.state).toHaveLength(201);
        encoded.state.forEach((value, index) => expect(value).toBeCloseTo(parity.encoded.state[index] ?? NaN, 6));
        expect(encoded.auction).toEqual(parity.encoded.auction);
        expect(encoded.play).toEqual(parity.encoded.play);
        parity.candidates.forEach((candidate, index) => {
            const row = encodeBeliefCandidate(parity.features, candidate);
            const expected = parity.decoderRows[index];
            if (expected === undefined) throw new Error("Missing Python parity row.");
            expect(encoded.cards).toEqual(expected.cards);
            expect(row.targets).toEqual(expected.targets);
            expect(row.previous).toEqual(expected.previous);
            expect(row.active).toEqual(expected.active);
            expect(row.allowed).toEqual(expected.allowed.flat());
        });
    });

    it("rejects missing evidence and candidates that violate ownership counts", () => {
        expect(() => encodeBeliefFeatures({ ...parity.features,
            context: { ...parity.features.context, vulnerability: "unknown" } })).toThrow(/vulnerability/);
        expect(() => encodeBeliefCandidate(parity.features, { firstDefenderCards: [] })).toThrow(/allocate/);
        const first = parity.candidates[0];
        if (first === undefined) throw new Error("Missing test candidate.");
        expect(() => encodeBeliefCandidate({
            ...parity.features, voids: { ...parity.features.voids, East: ["hearts", "clubs"] },
        }, first)).toThrow(/constraints/);
    });

    it("validates runtime versions, permissions and safe checksummed asset names", () => {
        const valid = validateOnnxManifest(manifest);
        expect(valid.purpose).toBe("test-fixture");
        expect(valid.localOnly).toBe(false);
        expect(() => validateOnnxManifest({ ...valid, tensorSchema: "other" })).toThrow(/tensor/);
        expect(() => validateOnnxManifest({ ...valid, purpose: "research", modelDistributionAllowed: false }))
            .toThrow(/distribution/);
        const localOnly = {
            ...valid, purpose: "research-pilot", modelDistributionAllowed: false, localOnly: true,
        } as const;
        expect(validateOnnxManifest(localOnly, { allowLocalOnly: true }).localOnly).toBe(true);
        expect(() => validateOnnxManifest(localOnly)).toThrow(/localhost/);
        expect(() => validateOnnxManifest({ ...localOnly, localOnly: "yes" }, { allowLocalOnly: true }))
            .toThrow(/permissions/);
        expect(() => validateOnnxManifest({ ...valid, assets: {
            ...valid.assets, encoder: { ...valid.assets.encoder, file: "../private.onnx" },
        } })).toThrow(/asset/);
    });
});
