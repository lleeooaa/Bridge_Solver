import * as ort from "onnxruntime-web/wasm";
import { analysisAborted } from "../dds/engine";
import {
    BELIEF_OUTPUT_SCHEMA, validateBeliefModelManifest, validateBeliefScores,
    type BeliefModel, type BeliefModelManifest,
} from "./belief";
import {
    BELIEF_AUCTION_SIZE, BELIEF_HIDDEN_SIZE, BELIEF_PLAY_SIZE, BELIEF_STATE_SIZE, BELIEF_TENSOR_SCHEMA,
    encodeBeliefCandidate, encodeBeliefFeatures,
} from "./beliefEncoding";
import { sampleBeliefCandidates, type BeliefStepDecoder } from "./beliefSampler";
import { isLoopbackHostname } from "./modelPolicy";

interface ModelAsset { readonly file: string; readonly sha256: string; readonly bytes: number }
export interface OnnxBeliefManifest extends BeliefModelManifest {
    readonly runtime: "onnx-bridge-belief/v1";
    readonly tensorSchema: typeof BELIEF_TENSOR_SCHEMA;
    readonly hiddenSize: number;
    readonly purpose: "research" | "research-pilot" | "test-fixture";
    readonly localOnly: boolean;
    readonly modelDistributionAllowed: boolean;
    readonly assets: {
        readonly encoder: ModelAsset;
        readonly decoder: ModelAsset;
        readonly stepDecoder?: ModelAsset;
    };
}
export interface OnnxBeliefModel extends BeliefModel {
    readonly manifest: OnnxBeliefManifest;
    readonly notice: string;
    dispose: () => Promise<void>;
}
const record = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);

export const validateOnnxManifest = (
    value: unknown, options: { readonly allowLocalOnly?: boolean } = {},
): OnnxBeliefManifest => {
    const base = validateBeliefModelManifest(value);
    if (!record(value) || value.runtime !== "onnx-bridge-belief/v1" || value.tensorSchema !== BELIEF_TENSOR_SCHEMA ||
        typeof value.hiddenSize !== "number" || !Number.isInteger(value.hiddenSize) ||
        value.hiddenSize < 8 || value.hiddenSize > 1024 || !record(value.assets)) {
        throw new Error("Unsupported ONNX belief runtime/tensor manifest.");
    }
    if ((value.localOnly !== undefined && typeof value.localOnly !== "boolean") ||
        typeof value.modelDistributionAllowed !== "boolean") {
        throw new Error("Invalid belief model distribution/local-only permissions.");
    }
    const localOnly = value.localOnly === true;
    const modelDistributionAllowed = value.modelDistributionAllowed;
    if (localOnly && options.allowLocalOnly !== true) {
        throw new Error("Local-only models may only be loaded by an app running on localhost.");
    }
    const purpose = value.purpose;
    if (purpose !== "research" && purpose !== "research-pilot" && purpose !== "test-fixture") {
        throw new Error("Unknown belief model purpose.");
    }
    if (purpose !== "test-fixture" && !modelDistributionAllowed && !localOnly) {
        throw new Error("This model is not approved for browser distribution.");
    }
    const asset = (input: unknown, name: string): ModelAsset => {
        if (!record(input) || input.file !== `${name}.onnx` ||
            typeof input.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(input.sha256) ||
            typeof input.bytes !== "number" || !Number.isInteger(input.bytes) ||
            input.bytes < 1 || input.bytes > 256 * 1024 * 1024) {
            throw new Error(`Invalid ${name} model asset or checksum.`);
        }
        return { file: input.file, sha256: input.sha256, bytes: input.bytes };
    };
    return {
        ...base, runtime: "onnx-bridge-belief/v1", tensorSchema: BELIEF_TENSOR_SCHEMA,
        hiddenSize: value.hiddenSize, purpose, localOnly, modelDistributionAllowed,
        assets: {
            encoder: asset(value.assets.encoder, "encoder"),
            decoder: asset(value.assets.decoder, "decoder"),
            ...(value.assets.stepDecoder === undefined ? {} : {
                stepDecoder: asset(value.assets.stepDecoder, "stepDecoder"),
            }),
        },
    };
};

const checkAbort = (signal: AbortSignal): void => { if (signal.aborted) throw analysisAborted(); };
const fetchAsset = async (asset: ModelAsset, manifestUrl: string, signal: AbortSignal): Promise<ArrayBuffer> => {
    const response = await fetch(new URL(asset.file, manifestUrl), { signal });
    if (!response.ok) throw new Error(`Belief asset download failed (${response.status}): ${asset.file}.`);
    const buffer = await response.arrayBuffer();
    checkAbort(signal);
    const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", buffer))]
        .map((value) => value.toString(16).padStart(2, "0")).join("");
    if (buffer.byteLength !== asset.bytes || digest !== asset.sha256) {
        throw new Error(`Belief asset checksum/size mismatch: ${asset.file}.`);
    }
    return buffer;
};
const integers = (values: readonly number[], dims: readonly number[]): ort.Tensor =>
    new ort.Tensor("int64", BigInt64Array.from(values, BigInt), dims);
const floats = (values: ArrayLike<number>, dims: readonly number[]): ort.Tensor =>
    new ort.Tensor("float32", Float32Array.from(values), dims);

export const loadOnnxBelief = async (
    manifestUrl: string, runtimeUrl: string, signal: AbortSignal,
): Promise<OnnxBeliefModel> => {
    checkAbort(signal);
    const manifestOrigin = new URL(manifestUrl);
    if (manifestOrigin.origin !== new URL(runtimeUrl).origin) {
        throw new Error("Use a same-origin static model manifest; observations are never uploaded.");
    }
    const response = await fetch(manifestUrl, { signal, cache: "no-cache" });
    if (!response.ok) throw new Error(`Belief model manifest download failed (${response.status}).`);
    const value: unknown = await response.json();
    const manifest = validateOnnxManifest(value, { allowLocalOnly: isLoopbackHostname(manifestOrigin.hostname) });
    const [encoderBytes, decoderBytes, stepDecoderBytes] = await Promise.all([
        fetchAsset(manifest.assets.encoder, manifestUrl, signal),
        fetchAsset(manifest.assets.decoder, manifestUrl, signal),
        manifest.assets.stepDecoder === undefined ? Promise.resolve(undefined) :
            fetchAsset(manifest.assets.stepDecoder, manifestUrl, signal),
    ]);
    checkAbort(signal);
    ort.env.wasm.numThreads = 1;
    ort.env.wasm.proxy = false;
    ort.env.wasm.wasmPaths = runtimeUrl;
    const encoder = await ort.InferenceSession.create(encoderBytes, { executionProviders: ["wasm"] });
    let decoder: ort.InferenceSession | undefined;
    let stepAllocation: ort.InferenceSession | undefined;
    try {
        checkAbort(signal);
        decoder = await ort.InferenceSession.create(decoderBytes, { executionProviders: ["wasm"] });
        if (stepDecoderBytes !== undefined) {
            checkAbort(signal);
            stepAllocation = await ort.InferenceSession.create(stepDecoderBytes, { executionProviders: ["wasm"] });
        }
        checkAbort(signal);
    } catch (error: unknown) {
        await encoder.release();
        await decoder?.release();
        await stepAllocation?.release();
        throw error;
    }
    const allocation = decoder;
    if (allocation === undefined) throw new Error("Belief decoder session failed to initialize.");
    const stepSession = stepAllocation;
    let closed = false;
    const encodeContext = async (
        encoded: ReturnType<typeof encodeBeliefFeatures>, requestSignal: AbortSignal,
    ): Promise<Float32Array> => {
        checkAbort(requestSignal);
        if (closed) throw new Error("Belief model is closed.");
        const outputs = await encoder.run({
            state: floats(encoded.state, [1, BELIEF_STATE_SIZE]),
            auction: integers(encoded.auction, [1, BELIEF_AUCTION_SIZE]),
            play: integers(encoded.play, [1, BELIEF_PLAY_SIZE]),
        });
        checkAbort(requestSignal);
        const context = outputs.context;
        if (context === undefined || context.type !== "float32" || context.size !== manifest.hiddenSize) {
            throw new Error("Belief encoder returned an invalid context tensor.");
        }
        return Float32Array.from(context.data, Number);
    };
    const stepDecoder: BeliefStepDecoder | undefined = stepSession === undefined ? undefined : {
        run: async (input, requestSignal) => {
            checkAbort(requestSignal);
            if (closed) throw new Error("Belief model is closed.");
            const count = input.cards.length;
            if (count < 1 || input.previous.length !== count || input.hidden.length !== count * manifest.hiddenSize ||
                input.allowed.length !== count * 2) {
                throw new Error("Invalid belief step-decoder input dimensions.");
            }
            const outputs = await stepSession.run({
                hidden: floats(input.hidden, [count, manifest.hiddenSize]),
                card: integers(input.cards, [count, 1]),
                previous: integers(input.previous, [count, 1]),
                allowed: new ort.Tensor("bool", input.allowed, [count, 2]),
            });
            checkAbort(requestSignal);
            const logits = outputs.logits;
            const nextHidden = outputs.next_hidden;
            const logitsData = logits?.data;
            const nextHiddenData = nextHidden?.data;
            if (logits === undefined || logits.type !== "float32" || logits.size !== count * 2 ||
                !(logitsData instanceof Float32Array) || nextHidden === undefined ||
                nextHidden.type !== "float32" || nextHidden.size !== count * manifest.hiddenSize ||
                !(nextHiddenData instanceof Float32Array)) {
                throw new Error("Belief step decoder returned invalid tensor dimensions.");
            }
            return { logits: logitsData, nextHidden: nextHiddenData };
        },
    };
    return {
        manifest,
        notice: manifest.localOnly ? "Local-only model: only for localhost testing; do not deploy." :
            manifest.purpose === "test-fixture" ? "TEST FIXTURE: not a human-trained model." :
            manifest.purpose === "research-pilot" ? "Research pilot: not a million-deal production model." :
                "Research belief model; imperfect-information playing strength is not established.",
        dispose: async () => {
            if (closed) return;
            closed = true;
            await encoder.release();
            await allocation.release();
            await stepSession?.release();
        },
        scoreDeals: async (features, candidates, requestSignal) => {
            checkAbort(requestSignal);
            if (closed) throw new Error("Belief model is closed.");
            if (candidates.length < 1 || candidates.length > 1000) throw new Error("Score between 1 and 1000 candidates.");
            const encoded = encodeBeliefFeatures(features);
            const context = await encodeContext(encoded, requestSignal);
            const rows = candidates.map((candidate) => encodeBeliefCandidate(features, candidate));
            const count = rows.length;
            const repeatedContext = new Float32Array(count * manifest.hiddenSize);
            for (let index = 0; index < count; index += 1) {
                repeatedContext.set(context, index * manifest.hiddenSize);
            }
            const decoded = await allocation.run({
                context: floats(repeatedContext, [count, manifest.hiddenSize]),
                cards: integers(Array.from({ length: count }, () => encoded.cards).flat(), [count, BELIEF_HIDDEN_SIZE]),
                previous: integers(rows.flatMap((row) => row.previous), [count, BELIEF_HIDDEN_SIZE]),
                allowed: new ort.Tensor("bool", Uint8Array.from(rows.flatMap((row) => row.allowed)),
                    [count, BELIEF_HIDDEN_SIZE, 2]),
                active: floats(rows.flatMap((row) => row.active), [count, BELIEF_HIDDEN_SIZE]),
                targets: integers(rows.flatMap((row) => row.targets), [count, BELIEF_HIDDEN_SIZE]),
            });
            checkAbort(requestSignal);
            const scores = decoded.log_weights;
            if (scores === undefined || scores.type !== "float32" || scores.size !== count) {
                throw new Error("Belief decoder returned an invalid log-weight tensor.");
            }
            const result = validateBeliefScores({
                schema: BELIEF_OUTPUT_SCHEMA, modelId: manifest.id, modelVersion: manifest.version,
                logWeights: Array.from(scores.data, Number),
            }, manifest, count);
            if (manifest.localOnly) {
                console.info("[Bridge Advisor] Local ONNX model log weights", {
                    modelId: manifest.id, modelVersion: manifest.version, candidateCount: count,
                    logWeights: result.logWeights,
                });
            }
            return result;
        },
        ...(stepDecoder === undefined ? {} : {
            sampleDeals: async (features, count, random, requestSignal) => {
                checkAbort(requestSignal);
                if (closed) throw new Error("Belief model is closed.");
                const encoded = encodeBeliefFeatures(features);
                const context = await encodeContext(encoded, requestSignal);
                return sampleBeliefCandidates(features, count, context, manifest.hiddenSize,
                    stepDecoder, random, requestSignal);
            },
        }),
    };
};
