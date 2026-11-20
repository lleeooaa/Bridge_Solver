import { analysisAborted } from "../dds/engine";
import {
    buildBeliefAllocationConstraints, encodeBeliefCandidate, getBeliefAllowedOwners,
} from "./beliefEncoding";
import type { BeliefCandidate, BeliefFeatures } from "./belief";

export interface BeliefStepInput {
    readonly hidden: Float32Array;
    readonly cards: readonly number[];
    readonly previous: readonly number[];
    readonly allowed: Uint8Array;
}

export interface BeliefStepOutput {
    readonly logits: Float32Array;
    readonly nextHidden: Float32Array;
}

export interface BeliefStepDecoder {
    run(input: BeliefStepInput, signal: AbortSignal): Promise<BeliefStepOutput>;
}

const checkAbort = (signal: AbortSignal): void => { if (signal.aborted) throw analysisAborted(); };

export const sampleBeliefCandidates = async (
    features: BeliefFeatures, count: number, context: Float32Array, hiddenSize: number,
    decoder: BeliefStepDecoder, random: () => number, signal: AbortSignal,
): Promise<BeliefCandidate[]> => {
    if (!Number.isInteger(count) || count < 1 || count > 1000) {
        throw new Error("Sample between 1 and 1000 model-guided deals.");
    }
    if (!Number.isInteger(hiddenSize) || hiddenSize < 1 || context.length !== hiddenSize) {
        throw new Error("Belief encoder returned an invalid sampler context.");
    }
    for (const value of context) {
        if (!Number.isFinite(value)) throw new Error("Belief encoder returned a non-finite sampler context.");
    }
    checkAbort(signal);
    const constraints = buildBeliefAllocationConstraints(features);
    const first = features.hiddenSeats[0];
    const needs = Array<number>(count).fill(features.remainingCounts[first]);
    const previous = Array<number>(count).fill(2);
    const assignments = Array.from({ length: count }, () => [] as number[]);
    let hidden: Float32Array<ArrayBufferLike> = new Float32Array(count * hiddenSize);
    for (let sample = 0; sample < count; sample += 1) hidden.set(context, sample * hiddenSize);

    for (const [index, card] of features.unseenCards.entries()) {
        checkAbort(signal);
        const cards = Array<number>(count).fill(card);
        const allowed = new Uint8Array(count * 2);
        for (let sample = 0; sample < count; sample += 1) {
            const remaining = needs[sample];
            if (remaining === undefined) throw new Error("Missing model-guided allocation count.");
            const owners = getBeliefAllowedOwners(constraints, index, remaining);
            allowed[sample * 2] = Number(owners[0]);
            allowed[sample * 2 + 1] = Number(owners[1]);
        }
        const result = await decoder.run({ hidden, cards, previous, allowed }, signal);
        checkAbort(signal);
        if (result.logits.length !== count * 2 || result.nextHidden.length !== count * hiddenSize) {
            throw new Error("Belief step decoder returned invalid tensor dimensions.");
        }
        for (const value of result.nextHidden) {
            if (!Number.isFinite(value)) throw new Error("Belief step decoder returned a non-finite recurrent state.");
        }
        for (let sample = 0; sample < count; sample += 1) {
            const offset = sample * 2;
            const canFirst = allowed[offset] === 1;
            const canSecond = allowed[offset + 1] === 1;
            const firstLogit = result.logits[offset];
            const secondLogit = result.logits[offset + 1];
            if (firstLogit === undefined || secondLogit === undefined) {
                throw new Error("Belief step decoder omitted an ownership logit.");
            }
            let owner: 0 | 1;
            if (canFirst && canSecond) {
                if (!Number.isFinite(firstLogit) || !Number.isFinite(secondLogit)) {
                    throw new Error("Belief step decoder returned non-finite legal logits.");
                }
                const maximum = Math.max(firstLogit, secondLogit);
                const firstMass = Math.exp(firstLogit - maximum);
                const secondMass = Math.exp(secondLogit - maximum);
                const probabilityFirst = firstMass / (firstMass + secondMass);
                const draw = random();
                if (!(draw >= 0 && draw < 1)) throw new Error("Random source must return a number in [0, 1).");
                owner = draw < probabilityFirst ? 0 : 1;
            } else if (canFirst) {
                if (!Number.isFinite(firstLogit)) throw new Error("Belief step decoder returned a non-finite legal logit.");
                owner = 0;
            } else if (canSecond) {
                if (!Number.isFinite(secondLogit)) throw new Error("Belief step decoder returned a non-finite legal logit.");
                owner = 1;
            } else {
                throw new Error("Belief step decoder received an empty legal ownership mask.");
            }
            previous[sample] = owner;
            if (owner === 0) {
                const assignment = assignments[sample];
                if (assignment === undefined) throw new Error("Missing model-guided deal assignment.");
                assignment.push(card);
                needs[sample] = (needs[sample] ?? 0) - 1;
            }
        }
        hidden = result.nextHidden;
    }

    const candidates = assignments.map((firstDefenderCards, sample): BeliefCandidate => {
        if (needs[sample] !== 0) throw new Error("Model-guided deal ended with unassigned defender cards.");
        const candidate = { firstDefenderCards };
        encodeBeliefCandidate(features, candidate);
        return candidate;
    });
    return candidates;
};
