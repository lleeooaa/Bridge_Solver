import { describe, expect, it } from "vitest";
import { DIRECTIONS, SUITS } from "../bridge";
import { buildPlayState, getLegalCards } from "../play";
import { buildObservation, getObservedPlayableCards } from "./observation";
import { createRandom, samplePosition } from "./sampling";
import { endgameHistory, fixture } from "./fixtures.test-support";

describe("declarer's observation and compatible samples", () => {
    it("starts with only visible cards and replays public tricks exactly", () => {
        const { deal, input } = fixture();
        const history = endgameHistory(deal);
        const observed = buildObservation(input, history);
        const actual = buildPlayState(deal, history);
        expect(observed.unseenCards).toHaveLength(observed.remainingCounts.East + observed.remainingCounts.West);
        expect(observed.declarerHand).toEqual(actual.hands.North);
        expect(observed.dummyHand).toEqual(actual.hands.South);
        expect(observed.currentTrick).toEqual(actual.currentTrick);
        expect(observed.playerToMove).toBe(actual.playerToMove);
        expect(observed.declarerTricksWon).toBe(actual.declarerTricksWon);
        expect(getObservedPlayableCards(observed, input.contract)).toEqual(getLegalCards(actual));
    });

    it("samples only complete compatible remaining deals, reproducibly and without mutating observations", () => {
        const { input, deal } = fixture();
        const observation = buildObservation(input, endgameHistory(deal));
        const before = JSON.stringify(observation);
        const first = createRandom(0);
        const second = createRandom(0);
        for (let iteration = 0; iteration < 30; iteration += 1) {
            const state = samplePosition(observation, input.contract, first);
            expect(state).toEqual(samplePosition(observation, input.contract, second));
            const cards = DIRECTIONS.flatMap((seat) => SUITS.flatMap((suit) =>
                state.hands[seat][suit].map((rank) => `${suit}:${rank}`)));
            expect(new Set(cards).size).toBe(cards.length);
            for (const seat of DIRECTIONS) {
                expect(SUITS.reduce((count, suit) => count + state.hands[seat][suit].length, 0))
                    .toBe(observation.remainingCounts[seat]);
                for (const suit of observation.voids[seat]) expect(state.hands[seat][suit]).toEqual([]);
            }
        }
        expect(JSON.stringify(observation)).toBe(before);
    });

    it("rejects duplicate visible cards, wrong turns, known cards in a defender's hand, and impossible voids", () => {
        const { input } = fixture();
        expect(() => buildObservation({ ...input, dummyHand: input.declarerHand })).toThrow(/more than once/);
        expect(() => buildObservation(input, [
            { player: "North", card: { suit: "spades", rank: "A" } },
        ])).toThrow(/turn/);
        const known = SUITS.flatMap((suit) => input.declarerHand[suit].map((rank) => ({ suit, rank })))[0];
        if (known === undefined) throw new Error("Missing visible card.");
        expect(() => buildObservation(input, [{ player: "East", card: known }])).toThrow(/visible hand/);
        const observation = buildObservation(input);
        expect(() => samplePosition({
            ...observation,
            voids: { ...observation.voids, East: [...SUITS], West: [...SUITS] },
        }, input.contract, createRandom(1))).toThrow(/compatible/);
    });

    it("only accepts thirteen-card visible hands and valid seed values", () => {
        const { input } = fixture();
        expect(() => buildObservation({ ...input, declarerHand: { ...input.declarerHand, spades: [] } }))
            .toThrow(/thirteen/);
        expect(() => createRandom(Number.NaN)).toThrow(/seed/i);
    });
});
