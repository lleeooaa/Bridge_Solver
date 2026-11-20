import { describe, expect, it } from "vitest";
import { RANKS, SUITS, cloneHand, createEmptyHands, type PlayedCard, type SolverInput } from "../bridge";
import { buildPlayState, getLegalCards, isDeclarerSide } from "../play";
import { createNodeDdsEngine } from "../dds/node";
import { cardKey, type DdsEngine } from "../dds/engine";
import { analyzeAdvisor } from "./analyze";
import { buildObservation, getObservedPlayableCards } from "./observation";
import { createAdvisorContext, parseAuction } from "./context";
import { endgameHistory, fixture } from "./fixtures.test-support";
import {
    BELIEF_FEATURE_SCHEMA, BELIEF_MODEL_SCHEMA, BELIEF_OUTPUT_SCHEMA, buildBeliefFeatures,
    type BeliefCandidate, type BeliefModel,
} from "./belief";
import { buildBeliefAllocationConstraints, encodeBeliefCandidate, getBeliefAllowedOwners } from "./beliefEncoding";

const exhaustive = (input: SolverInput, history: readonly PlayedCard[]): number => {
    const state = buildPlayState(input, history);
    if (state.isComplete) return state.declarerTricksWon;
    const values = getLegalCards(state).map((card) =>
        exhaustive(input, [...history, { player: state.playerToMove, card }]));
    return isDeclarerSide(state.playerToMove, input.contract) ? Math.max(...values) : Math.min(...values);
};

describe("single-dummy Monte Carlo aggregation", () => {
    it("uses joint posterior weights rather than counting weighted worlds as uniform samples", async () => {
        const { input, deal } = fixture();
        const history = endgameHistory(deal);
        const observation = buildObservation(input, history);
        const keyCard = observation.unseenCards[0];
        if (keyCard === undefined) throw new Error("Missing test card.");
        const keyIndex = ["spades", "hearts", "diamonds", "clubs"].indexOf(keyCard.suit) * 13 +
            "23456789TJQKA".indexOf(keyCard.rank);
        const manifest = { schema: BELIEF_MODEL_SCHEMA, id: "joint-test", version: "1",
            featureSchema: BELIEF_FEATURE_SCHEMA, outputSchema: BELIEF_OUTPUT_SCHEMA } satisfies BeliefModel["manifest"];
        const belief: BeliefModel = {
            manifest, scoreDeals: async (_features, candidates) => ({
                schema: BELIEF_OUTPUT_SCHEMA, modelId: manifest.id, modelVersion: manifest.version,
                logWeights: candidates.map((candidate) => candidate.firstDefenderCards.includes(keyIndex) ? Math.log(9) : 0),
            }),
        };
        const engine: DdsEngine = {
            dispose: () => {},
            evaluate: async (state) => getLegalCards(state).map((card) => ({
                card, declarerTricks: state.hands.East[keyCard.suit].includes(keyCard.rank) ? 9 : 8,
            })),
        };
        const advice = await analyzeAdvisor(input, history,
            { samples: 6, seed: 33, belief: { type: "learned", manifestUrl: "unused" } },
            engine, new AbortController().signal, undefined, belief);
        expect(advice.model).toBe("learned-joint");
        expect(advice.effectiveSampleSize).toBeCloseTo(900 / 246);
        expect(advice.candidates[0]?.makeProbability).toBeCloseTo(0.9);
        expect(advice.candidates[0]?.expectedTricks).toBeCloseTo(8.9);
        expect(advice.candidates[0]?.samplingInterval).toEqual([0, 1]);
        expect(advice.warning).toMatch(/effective sample size/i);
        await expect(analyzeAdvisor(input, history,
            { samples: 6, seed: 33, belief: { type: "learned", manifestUrl: "unused" } },
            engine, new AbortController().signal)).rejects.toThrow(/no belief model/);
    });
    it("aggregates direct model draws with unit weights and reuses duplicate DDS evaluations", async () => {
        const { input, deal } = fixture();
        const history = endgameHistory(deal);
        const contextualInput = {
            ...input,
            context: {
                ...createAdvisorContext(), dealer: "North" as const, vulnerability: "none" as const,
                auction: parseAuction("3NT P P P", "North"),
            },
        };
        const features = buildBeliefFeatures(contextualInput, history);
        const observation = buildObservation(contextualInput, history);
        const constraints = buildBeliefAllocationConstraints(features);
        const validWorlds: BeliefCandidate[] = [];
        const assigned: number[] = [];
        const enumerate = (index: number, needs: number): void => {
            if (index === features.unseenCards.length) {
                if (needs === 0) {
                    const candidate = { firstDefenderCards: [...assigned] };
                    encodeBeliefCandidate(features, candidate);
                    validWorlds.push(candidate);
                }
                return;
            }
            const card = features.unseenCards[index];
            if (card === undefined) throw new Error("Missing endgame card.");
            const [canFirst, canSecond] = getBeliefAllowedOwners(constraints, index, needs);
            if (canFirst) {
                assigned.push(card);
                enumerate(index + 1, needs - 1);
                assigned.pop();
            }
            if (canSecond) enumerate(index + 1, needs);
        };
        enumerate(0, features.remainingCounts[features.hiddenSeats[0]]);
        expect(validWorlds).toHaveLength(6);
        const firstSeat = features.hiddenSeats[0];
        const keyCardIndex = features.unseenCards[0];
        if (keyCardIndex === undefined) throw new Error("Missing endgame card.");
        const keyCard = observation.unseenCards.find((card) =>
            SUITS.indexOf(card.suit) * 13 + RANKS.indexOf(card.rank) === keyCardIndex);
        if (keyCard === undefined) throw new Error("Missing endgame card.");
        const manifest = {
            schema: BELIEF_MODEL_SCHEMA, id: "direct-test", version: "1",
            featureSchema: BELIEF_FEATURE_SCHEMA, outputSchema: BELIEF_OUTPUT_SCHEMA,
        } satisfies BeliefModel["manifest"];
        let evaluations = 0;
        const belief: BeliefModel = {
            manifest,
            scoreDeals: async () => { throw new Error("Direct samples must not be reweighted."); },
            sampleDeals: async () => validWorlds.flatMap((candidate) => [candidate, candidate]),
        };
        const engine: DdsEngine = {
            dispose: () => {},
            evaluate: async (state) => {
                evaluations += 1;
                const tricks = state.hands[firstSeat][keyCard.suit].includes(keyCard.rank) ? 9 : 8;
                return getLegalCards(state).map((card) => ({ card, declarerTricks: tricks }));
            },
        };
        const advice = await analyzeAdvisor(contextualInput, history,
            { samples: 12, seed: 33, belief: { type: "learned", manifestUrl: "unused" } },
            engine, new AbortController().signal, undefined, belief);
        const worldsWithKeyCard = validWorlds.filter((candidate) =>
            candidate.firstDefenderCards.includes(keyCardIndex)).length;
        expect(evaluations).toBe(validWorlds.length);
        expect(advice.samplingMethod).toBe("learned-direct");
        expect(advice.intervalKind).toBe("wilson");
        expect(advice.effectiveSampleSize).toBe(12);
        expect(advice.warning).toBeUndefined();
        expect(advice.candidates[0]?.makeProbability).toBe(worldsWithKeyCard / validWorlds.length);
        expect(advice.candidates[0]?.expectedTricks).toBe(8 + worldsWithKeyCard / validWorlds.length);
    });
    it("uses the same worlds for all cards and reports progress only after complete evaluations", async () => {
        const { input, deal } = fixture();
        const history = endgameHistory(deal);
        const progress: number[] = [];
        let calls = 0;
        const engine: DdsEngine = {
            evaluate: async (state) => {
                calls += 1;
                return getLegalCards(state).map((card, index) => ({ card, declarerTricks: index === 0 ? 9 : 8 }));
            },
            dispose: () => {},
        };
        const advice = await analyzeAdvisor(input, history, { samples: 20, seed: 1 }, engine,
            new AbortController().signal, (result) => progress.push(result.samples));
        expect(calls).toBe(20);
        expect(advice.samples).toBe(20);
        expect(advice.complete).toBe(true);
        expect(advice.candidates[0]?.makeProbability).toBe(1);
        expect(advice.candidates[0]?.samplingInterval[0]).toBeLessThan(1);
        expect(progress.at(-1)).toBe(20);
    });

    it("keeps the uniform baseline deterministic and does not pretend to interpret auction/system metadata", async () => {
        const { input, deal } = fixture();
        const history = endgameHistory(deal);
        const engine = createNodeDdsEngine();
        try {
            const first = await analyzeAdvisor(input, history, { samples: 8, seed: 71 }, engine, new AbortController().signal);
            const second = await analyzeAdvisor({
                ...input, context: {
                    ...createAdvisorContext(), dealer: "North", vulnerability: "both",
                    auction: parseAuction("3NT P P P", "North"),
                    eastWest: { biddingSystem: "Precision", carding: "Upside-down count and attitude" },
                },
            }, history, { samples: 8, seed: 71 }, engine, new AbortController().signal);
            expect(first.candidates).toEqual(second.candidates);
            expect(second.model).toBe("uniform-hard-constraints");
            expect(first.candidates).toHaveLength(getObservedPlayableCards(buildObservation(input, history), input.contract).length);
        } finally {
            engine.dispose();
        }
    });

    it("matches exhaustive play averaged over every compatible world in a small endgame", async () => {
        const { input, deal } = fixture();
        const history = endgameHistory(deal);
        const observation = buildObservation(input, history);
        expect(history).toHaveLength(44);
        expect(observation.unseenCards).toHaveLength(4);
        const expected = new Map<string, { makes: number; tricks: number }>();
        const worlds = new Set<string>();
        for (let first = 0; first < 4; first += 1) {
            for (let second = first + 1; second < 4; second += 1) {
                const hands = createEmptyHands();
                hands.North = cloneHand(input.declarerHand);
                hands.South = cloneHand(input.dummyHand);
                for (const play of history) {
                    if (play.player === "East" || play.player === "West") {
                        hands[play.player][play.card.suit].push(play.card.rank);
                    }
                }
                observation.unseenCards.forEach((card, index) => {
                    hands[index === first || index === second ? "East" : "West"][card.suit].push(card.rank);
                });
                const world = { hands, contract: input.contract };
                const state = buildPlayState(world, history);
                worlds.add([...state.hands.East.clubs].sort().join(","));
                for (const card of getLegalCards(state)) {
                    const tricks = exhaustive(world, [...history, { player: state.playerToMove, card }]);
                    const key = cardKey(card);
                    const total = expected.get(key) ?? { makes: 0, tricks: 0 };
                    total.makes += Number(tricks >= input.contract.level + 6);
                    total.tricks += tricks;
                    expected.set(key, total);
                }
            }
        }
        expect(worlds.size).toBe(6);
        const engine = createNodeDdsEngine();
        const sampled = new Set<string>();
        const tracked: DdsEngine = {
            evaluate: (state, contract, signal) => {
                sampled.add([...state.hands.East.clubs].sort().join(","));
                return engine.evaluate(state, contract, signal);
            },
            dispose: () => engine.dispose(),
        };
        try {
            const advice = await analyzeAdvisor(input, history, { samples: 6, seed: 33 }, tracked,
                new AbortController().signal);
            expect(sampled).toEqual(worlds);
            expect(advice.candidates).toHaveLength(expected.size);
            for (const candidate of advice.candidates) {
                const total = expected.get(cardKey(candidate.card));
                if (total === undefined) throw new Error("Unexpected advisor candidate.");
                expect(candidate.makeProbability).toBe(total.makes / 6);
                expect(candidate.expectedTricks).toBe(total.tricks / 6);
            }
        } finally {
            tracked.dispose();
        }
    }, 20_000);

    it("surfaces DDS failures and incomplete evaluations instead of producing advice", async () => {
        const { input, deal } = fixture();
        const history = endgameHistory(deal);
        const failing: DdsEngine = {
            evaluate: async () => { throw new Error("DDS failed"); },
            dispose: () => {},
        };
        await expect(analyzeAdvisor(input, history, { samples: 2, seed: 1 }, failing,
            new AbortController().signal)).rejects.toThrow("DDS failed");
        await expect(analyzeAdvisor(input, history, { samples: 2, seed: 1 },
            { ...failing, evaluate: async () => [] }, new AbortController().signal))
            .rejects.toThrow(/incomplete/);
    });

    it("rejects unsupported turns, invalid options, and cancellation explicitly", async () => {
        const { input, deal } = fixture();
        const engine = createNodeDdsEngine();
        const history = endgameHistory(deal);
        try {
            await expect(analyzeAdvisor(input, [], { samples: 2, seed: 1 }, engine, new AbortController().signal))
                .rejects.toThrow(/declarer or dummy/);
            await expect(analyzeAdvisor(input, history, { samples: 0, seed: 1 }, engine, new AbortController().signal))
                .rejects.toThrow(/sample/i);
            const controller = new AbortController();
            controller.abort();
            await expect(analyzeAdvisor(input, history, { samples: 2, seed: 1 }, engine, controller.signal))
                .rejects.toMatchObject({ name: "AbortError" });
        } finally {
            engine.dispose();
        }
    });
});
