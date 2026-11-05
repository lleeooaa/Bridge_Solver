import { describe, expect, it } from "vitest";
import { createEmptyHands, type PlayedCard, type SolverInput } from "./bridge";
import { buildPlayState, getLegalCards, getTricksLostByMove } from "./play";

const input = (): SolverInput => {
    const hands = createEmptyHands();
    hands.North.spades = ["A", "Q"];
    hands.East.spades = ["K"];
    hands.East.hearts = ["A"];
    hands.South.spades = ["J"];
    hands.South.hearts = ["2"];
    hands.West.spades = ["T"];
    hands.West.hearts = ["K"];
    return {
        hands,
        contract: { level: 1, strain: "hearts", declarer: "North", doubling: "undoubled" },
    };
};

const trick: readonly PlayedCard[] = [
    { player: "East", card: { suit: "spades", rank: "K" } },
    { player: "South", card: { suit: "spades", rank: "J" } },
    { player: "West", card: { suit: "spades", rank: "T" } },
    { player: "North", card: { suit: "spades", rank: "A" } },
];

describe("interactive play state", () => {
    it("grades a move by the change in exact value for either partnership", () => {
        const contract = input().contract;
        expect(getTricksLostByMove(8, 8, "North", contract)).toBe(0);
        expect(getTricksLostByMove(8, 7, "South", contract)).toBe(1);
        expect(getTricksLostByMove(8, 9, "East", contract)).toBe(1);
        expect(() => getTricksLostByMove(8, 9, "North", contract)).toThrow(/contradict/i);
        expect(() => getTricksLostByMove(8, 7, "West", contract)).toThrow(/contradict/i);
    });

    it("starts on declarer's left and exposes every legal card without altering the deal", () => {
        const deal = input();
        const original = JSON.stringify(deal);
        const state = buildPlayState(deal);
        expect(state.playerToMove).toBe("East");
        expect(state.totalTricks).toBe(2);
        expect(getLegalCards(state)).toEqual([
            { suit: "spades", rank: "K" }, { suit: "hearts", rank: "A" },
        ]);
        expect(JSON.stringify(deal)).toBe(original);
    });

    it("requires following suit and tracks an unfinished trick", () => {
        const state = buildPlayState(input(), trick.slice(0, 1));
        expect(state.playerToMove).toBe("South");
        expect(getLegalCards(state)).toEqual([{ suit: "spades", rank: "J" }]);
        expect(state.currentTrick).toEqual(trick.slice(0, 1));
        expect(state.hands.East.spades).toEqual([]);
        expect(state.declarerTricksWon).toBe(0);
    });

    it("restores the unfinished trick, turn, hand, and score when undoing a completed trick", () => {
        const deal = input();
        const completed = buildPlayState(deal, trick);
        expect(completed.playerToMove).toBe("North");
        expect(completed.declarerTricksWon).toBe(1);
        expect(completed.currentTrick).toEqual([]);
        expect(completed.lastTrick).toEqual(trick);
        const undone = buildPlayState(deal, trick.slice(0, -1));
        expect(undone.playerToMove).toBe("North");
        expect(undone.declarerTricksWon).toBe(0);
        expect(undone.hands.North.spades).toContain("A");
        expect(undone.currentTrick).toEqual(trick.slice(0, -1));
        expect(buildPlayState(deal).hands).toEqual(deal.hands);
    });

    it("handles trump winners, voids, terminal positions, and repeated undo branching", () => {
        const deal = input();
        const history: PlayedCard[] = [
            ...trick,
            { player: "North", card: { suit: "spades", rank: "Q" } },
            { player: "East", card: { suit: "hearts", rank: "A" } },
            { player: "South", card: { suit: "hearts", rank: "2" } },
            { player: "West", card: { suit: "hearts", rank: "K" } },
        ];
        const end = buildPlayState(deal, history);
        expect(end.isComplete).toBe(true);
        expect(end.declarerTricksWon).toBe(1);
        expect(end.defenderTricksWon).toBe(1);
        expect(getLegalCards(end)).toEqual([]);
        expect(buildPlayState(deal, history.slice(0, 5)).playerToMove).toBe("East");
        expect(buildPlayState(deal, [trick[0]!, trick[1]!]).playerToMove).toBe("West");
    });

    it("rejects wrong turns, absent cards, revokes, and extra terminal plays explicitly", () => {
        expect(() => buildPlayState(input(), [trick[1]!])).toThrow(/turn/i);
        expect(() => buildPlayState(input(), [
            { player: "East", card: { suit: "clubs", rank: "A" } },
        ])).toThrow(/hold/i);
        expect(() => buildPlayState(input(), [
            trick[0]!, { player: "South", card: { suit: "hearts", rank: "2" } },
        ])).toThrow(/follow/i);
        expect(() => buildPlayState(input(), [...trick, ...trick])).toThrow(/turn|hold/i);
    });
});
