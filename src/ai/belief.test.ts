import { describe, expect, it } from "vitest";
import { DIRECTIONS, RANKS, SUITS } from "../bridge";
import {
    BELIEF_FEATURE_SCHEMA, BELIEF_MODEL_SCHEMA, BELIEF_OUTPUT_SCHEMA,
    buildBeliefFeatures, validateBeliefModelManifest, validateBeliefScores, type BeliefModelManifest,
} from "./belief";
import { createAdvisorContext, parseAuction } from "./context";
import { endgameHistory, fixture } from "./fixtures.test-support";
import { buildObservation } from "./observation";
import { buildPlayState, getLegalCards, nextPlayer } from "../play";

const manifest: BeliefModelManifest = {
    schema: BELIEF_MODEL_SCHEMA, id: "test-belief", version: "0.1.0",
    featureSchema: BELIEF_FEATURE_SCHEMA, outputSchema: BELIEF_OUTPUT_SCHEMA,
};

describe("versioned public belief features", () => {
    it("encodes deterministic card indices, all public history, and context without hidden-hand targets", () => {
        const { input, deal } = fixture();
        const history = endgameHistory(deal);
        const context = {
            ...createAdvisorContext(), dealer: "North" as const, vulnerability: "both" as const,
            auction: parseAuction("3NT P P P", "North"),
            eastWest: { biddingSystem: "Precision", carding: "Standard count; upside-down attitude" },
        };
        const richInput = { ...input, context, hands: deal.hands, trainingTarget: "must-not-leak" };
        const before = JSON.stringify(richInput);
        const features = buildBeliefFeatures(richInput, history);
        const observed = buildObservation(input, history);
        expect(features.schema).toBe(BELIEF_FEATURE_SCHEMA);
        expect(features.observer).toBe("North");
        expect(features.actor).toBe(observed.playerToMove);
        expect(features.hiddenSeats).toEqual(["East", "West"]);
        expect(features.context).toEqual(context);
        expect(features.played).toEqual(history.map((play) => ({
            player: play.player, card: SUITS.indexOf(play.card.suit) * 13 + RANKS.indexOf(play.card.rank),
        })));
        const partition = [...features.declarerCards, ...features.dummyCards, ...features.unseenCards,
            ...features.played.map((play) => play.card)];
        expect([...partition].sort((a, b) => a - b)).toEqual(Array.from({ length: 52 }, (_, index) => index));
        expect(features.remainingCounts).toEqual(observed.remainingCounts);
        expect(features.voids).toEqual(observed.voids);
        expect(JSON.stringify(features)).not.toMatch(/trainingTarget|must-not-leak|"hands"/);
        expect(JSON.parse(JSON.stringify(features))).toEqual(features);
        expect(buildBeliefFeatures(richInput, history)).toEqual(features);
        expect(JSON.stringify(richInput)).toBe(before);
        expect(() => buildBeliefFeatures(input, [])).toThrow(/declarer or dummy/i);
        features.played.forEach((play) => expect(DIRECTIONS).toContain(play.player));
    });

    it("canonicalizes hand order and returns independent snapshots", () => {
        const { input, deal } = fixture();
        const history = endgameHistory(deal);
        const reversed = {
            ...input, declarerHand: {
                spades: [...input.declarerHand.spades].reverse(), hearts: [...input.declarerHand.hearts].reverse(),
                diamonds: [...input.declarerHand.diamonds].reverse(), clubs: [...input.declarerHand.clubs].reverse(),
            },
        };
        expect(buildBeliefFeatures(reversed, history)).toEqual(buildBeliefFeatures(input, history));
        const features = buildBeliefFeatures(input, history);
        expect(features.played[0]).not.toBe(history[0]);
        expect(features.contract).not.toBe(input.contract);
    });

    it("keeps the observer as declarer when dummy acts, for every declarer seat", () => {
        const { deal } = fixture();
        for (const declarer of DIRECTIONS) {
            const dummy = nextPlayer(nextPlayer(declarer));
            const contract = { ...deal.contract, declarer };
            const state = buildPlayState({ ...deal, contract });
            const lead = getLegalCards(state)[0];
            if (lead === undefined) throw new Error("Missing opening lead.");
            const features = buildBeliefFeatures({
                contract, declarerHand: deal.hands[declarer], dummyHand: deal.hands[dummy],
            }, [{ player: state.playerToMove, card: lead }]);
            expect(features.observer).toBe(declarer);
            expect(features.actor).toBe(dummy);
            expect(features.hiddenSeats).toEqual([nextPlayer(declarer), nextPlayer(dummy)]);
            expect(features.declarerCards).toHaveLength(13);
            expect(features.dummyCards).toHaveLength(13);
            expect(features.unseenCards).toHaveLength(25);
        }
    });
});

describe("future belief-model boundary", () => {
    it("accepts only compatible manifests and finite per-deal log weights or explicit zero mass", () => {
        expect(validateBeliefModelManifest(manifest)).toEqual(manifest);
        const scores = {
            schema: BELIEF_OUTPUT_SCHEMA, modelId: manifest.id, modelVersion: manifest.version, logWeights: [-2, null, 0],
        };
        expect(validateBeliefScores(scores, manifest, 3)).toEqual(scores);
        expect(() => validateBeliefModelManifest({ ...manifest, featureSchema: "future/v99" })).toThrow(/feature/i);
        expect(() => validateBeliefModelManifest({ ...manifest, id: "" })).toThrow(/id/i);
        expect(() => validateBeliefModelManifest(null)).toThrow(/manifest/i);
        expect(() => validateBeliefScores({ ...scores, modelVersion: "other" }, manifest, 3)).toThrow(/model/i);
        expect(() => validateBeliefScores({ ...scores, schema: "future/v99" }, manifest, 3)).toThrow(/schema/i);
        expect(() => validateBeliefScores(scores, manifest, 2)).toThrow(/count/i);
        expect(() => validateBeliefScores({ ...scores, logWeights: [NaN, 0, 0] }, manifest, 3)).toThrow(/finite/i);
        expect(() => validateBeliefScores({ ...scores, logWeights: [Infinity, 0, 0] }, manifest, 3)).toThrow(/finite/i);
        expect(() => validateBeliefScores({ ...scores, logWeights: [null, null, null] }, manifest, 3)).toThrow(/zero mass/i);
    });
});
