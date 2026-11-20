import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SUITS } from "../bridge";
import type { BeliefFeatures } from "./belief";
import type { BeliefStepDecoder } from "./beliefSampler";
import { sampleBeliefCandidates } from "./beliefSampler";
import { createRandom } from "./sampling";

const parity: { features: BeliefFeatures } = JSON.parse(
    readFileSync(new URL("../../e2e/fixtures/belief/parity.json", import.meta.url), "utf8"),
);
const smallFeatures = (): BeliefFeatures => {
    const [first, second] = parity.features.hiddenSeats;
    const firstCard = parity.features.unseenCards[0];
    if (firstCard === undefined) throw new Error("Missing test card.");
    const secondCard = parity.features.unseenCards.find((card) => Math.floor(card / 13) !== Math.floor(firstCard / 13));
    if (secondCard === undefined) throw new Error("Missing test card in another suit.");
    return {
        ...parity.features,
        unseenCards: [firstCard, secondCard],
        remainingCounts: { ...parity.features.remainingCounts, [first]: 1, [second]: 1 },
        voids: { ...parity.features.voids, [first]: [], [second]: [] },
    };
};
const uniformStep: BeliefStepDecoder = {
    run: async ({ hidden, allowed }) => {
        const logits = new Float32Array(allowed.length);
        for (let index = 0; index < allowed.length; index += 1) {
            logits[index] = allowed[index] === 1 ? 0 : -1.0e9;
        }
        return { logits, nextHidden: new Float32Array(hidden) };
    },
};

describe("autoregressive model-guided deal sampling", () => {
    it("is deterministic, respects allocations, and matches exact two-world frequencies", async () => {
        const features = smallFeatures();
        const card = features.unseenCards[0];
        if (card === undefined) throw new Error("Missing test card.");
        const draw = (seed: number) => sampleBeliefCandidates(
            features, 1000, new Float32Array([0]), 1, uniformStep, createRandom(seed), new AbortController().signal,
        );
        const candidates = await draw(1701);
        expect(await draw(1701)).toEqual(candidates);
        expect(candidates).toHaveLength(1000);
        candidates.forEach((candidate) => {
            expect(candidate.firstDefenderCards).toHaveLength(1);
            expect(candidate.firstDefenderCards[0] === card || candidate.firstDefenderCards[0] === features.unseenCards[1])
                .toBe(true);
        });
        const firstOwnerCount = candidates.filter((candidate) => candidate.firstDefenderCards.includes(card)).length;
        expect(firstOwnerCount / candidates.length).toBeGreaterThan(0.43);
        expect(firstOwnerCount / candidates.length).toBeLessThan(0.57);
    });

    it("uses future feasibility to force void-constrained owners", async () => {
        const features = smallFeatures();
        const first = features.hiddenSeats[0];
        const secondCard = features.unseenCards[1];
        if (secondCard === undefined) throw new Error("Missing test card.");
        const firstCard = features.unseenCards[0];
        if (firstCard === undefined) throw new Error("Missing test card.");
        const suit = SUITS[Math.floor(firstCard / 13)];
        if (suit === undefined) throw new Error("Invalid test card.");
        const constrained: BeliefFeatures = {
            ...features, voids: { ...features.voids, [first]: [suit] },
        };
        const candidates = await sampleBeliefCandidates(
            constrained, 20, new Float32Array([0]), 1, uniformStep, createRandom(4), new AbortController().signal,
        );
        expect(candidates.every((candidate) =>
            candidate.firstDefenderCards.includes(secondCard) && !candidate.firstDefenderCards.includes(firstCard))).toBe(true);
    });
});
