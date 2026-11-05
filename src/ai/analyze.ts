import { RANKS, SUITS, type PlayedCard } from "../bridge";
import { analysisAborted, cardKey, type DdsEngine } from "../dds/engine";
import { isDeclarerSide } from "../play";
import { buildBeliefFeatures, validateBeliefScores, type BeliefModel } from "./belief";
import { buildObservation, getObservedPlayableCards } from "./observation";
import { createRandom, samplePosition } from "./sampling";
import type { Advice, AdvisorInput, AdvisorOptions } from "./types";

const samplingInterval = (makes: number, samples: number): readonly [number, number] => {
    const p = makes / samples;
    const z2 = 1.96 ** 2;
    const denominator = 1 + z2 / samples;
    const centre = (p + z2 / (2 * samples)) / denominator;
    const radius = 1.96 * Math.sqrt(p * (1 - p) / samples + z2 / (4 * samples * samples)) / denominator;
    return [Math.max(0, centre - radius), Math.min(1, centre + radius)];
};

export const analyzeAdvisor = async (
    input: AdvisorInput, history: readonly PlayedCard[], options: AdvisorOptions,
    engine: DdsEngine, signal: AbortSignal, progress?: (advice: Advice) => void,
    belief?: BeliefModel & { readonly notice?: string },
): Promise<Advice> => {
    if (signal.aborted) throw analysisAborted();
    if (!Number.isInteger(options.samples) || options.samples < 1 || options.samples > 500) {
        throw new Error("Sample count must be an integer between 1 and 500.");
    }
    const learned = options.belief?.type === "learned";
    if (learned && belief === undefined) throw new Error("Learned mode requested but no belief model is loaded.");
    const random = createRandom(options.seed);
    const observation = buildObservation(input, history);
    if (observation.isComplete || !isDeclarerSide(observation.playerToMove, input.contract)) {
        throw new Error("Advice is available only on declarer or dummy turns, after the opening lead.");
    }
    const started = performance.now();
    const cards = getObservedPlayableCards(observation, input.contract);
    const results: number[][] = cards.map(() => []);
    const positions = Array.from({ length: options.samples }, () => samplePosition(observation, input.contract, random));
    let logWeights: readonly (number | null)[] = positions.map(() => 0);
    if (learned && belief !== undefined) {
        const features = buildBeliefFeatures(input, history);
        const first = features.hiddenSeats[0];
        const candidates = positions.map((position) => ({
            firstDefenderCards: SUITS.flatMap((suit) => position.hands[first][suit]
                .map((rank) => SUITS.indexOf(suit) * 13 + RANKS.indexOf(rank))).sort((a, b) => a - b),
        }));
        const scores = await belief.scoreDeals(features, candidates, signal);
        logWeights = validateBeliefScores(scores, belief.manifest, positions.length).logWeights;
    }
    const snapshot = (samples: number): Advice | undefined => {
        const logs = logWeights.slice(0, samples);
        const finite = logs.filter((value): value is number => value !== null);
        if (finite.length === 0) return undefined;
        const maximum = Math.max(...finite);
        const weights = logs.map((value) => value === null ? 0 : Math.exp(value - maximum));
        const sum = weights.reduce((total, weight) => total + weight, 0);
        const squareSum = weights.reduce((total, weight) => total + weight ** 2, 0);
        const ess = sum ** 2 / squareSum;
        const threshold = input.contract.level + 6;
        const lowEss = learned && ess < Math.max(20, samples / 10);
        return {
            candidates: cards.map((card, index) => {
                const values = results[index];
                if (values === undefined || values.length !== samples) throw new Error("Incomplete advisor totals.");
                let tricks = 0, makes = 0;
                values.forEach((value, n) => {
                    const weight = weights[n];
                    if (weight === undefined) throw new Error("Missing importance weight.");
                    tricks += weight * value;
                    makes += weight * Number(value >= threshold);
                });
                const probability = makes / sum;
                let interval = samplingInterval(makes, samples);
                if (learned) {
                    let variance = 0;
                    values.forEach((value, n) => {
                        const weight = weights[n];
                        if (weight === undefined) throw new Error("Missing importance weight.");
                        variance += (weight / sum) ** 2 * (Number(value >= threshold) - probability) ** 2;
                    });
                    const radius = 1.96 * Math.sqrt(variance * samples / Math.max(1, samples - 1));
                    interval = lowEss || variance === 0 ? [0, 1] :
                        [Math.max(0, probability - radius), Math.min(1, probability + radius)];
                }
                return { card, makeProbability: probability, expectedTricks: tricks / sum, samplingInterval: interval };
            }).sort((left, right) => right.makeProbability - left.makeProbability ||
                right.expectedTricks - left.expectedTricks || cardKey(left.card).localeCompare(cardKey(right.card))),
            samples, requestedSamples: options.samples, seed: options.seed,
            elapsedMilliseconds: performance.now() - started,
            model: learned ? "learned-joint" : "uniform-hard-constraints",
            ...(learned && belief !== undefined ? {
                modelId: belief.manifest.id, modelVersion: belief.manifest.version, modelNotice: belief.notice,
                effectiveSampleSize: ess, intervalKind: "importance-asymptotic" as const,
                ...(lowEss ? { warning: "Low effective sample size: learned estimates are unstable. Increase samples or explicitly select uniform mode." } : {}),
            } : {}),
            complete: samples === options.samples,
        };
    };
    for (const [index, position] of positions.entries()) {
        if (signal.aborted) throw analysisAborted();
        const values = await engine.evaluate(position, input.contract, signal);
        if (signal.aborted) throw analysisAborted();
        const byCard = new Map(values.map((value) => [cardKey(value.card), value.declarerTricks]));
        if (byCard.size !== cards.length) throw new Error("DDS returned an incomplete candidate evaluation.");
        cards.forEach((card, candidate) => {
            const tricks = byCard.get(cardKey(card));
            const totals = results[candidate];
            if (tricks === undefined || totals === undefined) throw new Error("DDS omitted an advisor candidate.");
            if (!Number.isInteger(tricks) || tricks < 0 || tricks > 13) throw new Error("DDS returned invalid tricks.");
            totals.push(tricks);
        });
        const completed = index + 1;
        if (completed === 1 || completed % 10 === 0 || completed === options.samples) {
            const advice = snapshot(completed);
            if (advice !== undefined) progress?.(advice);
        }
    }
    const advice = snapshot(options.samples);
    if (advice === undefined) throw new Error("Belief model assigned zero mass to every candidate.");
    return advice;
};
