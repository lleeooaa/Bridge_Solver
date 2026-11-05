import { describe, expect, it } from "vitest";
import { createEmptyHands, type SolverInput } from "../bridge";
import { buildPlayState, getLegalCards } from "../play";
import { createNodeDdsEngine } from "./node";
import { createDdsAnalysisSession, solveDdsContract } from "./session";

const input = (): SolverInput => {
    const hands = createEmptyHands();
    hands.North.spades = ["A", "Q"];
    hands.East.spades = ["K"];
    hands.East.hearts = ["A"];
    hands.South.spades = ["J"];
    hands.South.hearts = ["2"];
    hands.West.spades = ["T"];
    hands.West.hearts = ["K"];
    return { hands, contract: { level: 1, strain: "hearts", declarer: "North", doubling: "undoubled" } };
};

describe("DDS exact sessions", () => {
    it("restores exact positions, reports actual DDS statistics, and rejects use after disposal", async () => {
        const session = createDdsAnalysisSession(input(), createNodeDdsEngine());
        try {
            const root = await session.analyze([], new AbortController().signal);
            expect(root.optimalDeclarerTricks).toBe(1);
            expect(root.statistics).toMatchObject({ engine: "dds", positionsEvaluated: 1 });
            expect(root.statistics).not.toHaveProperty("nodesVisited");
            const cached = await session.analyze([], new AbortController().signal);
            expect(cached.statistics).toMatchObject({ fromCache: true, positionsEvaluated: 0 });
        } finally {
            session.dispose();
        }
        await expect(session.analyze([], new AbortController().signal)).rejects.toThrow(/closed/);
    });

    it("builds a complete legal optimal replay without altering the input", async () => {
        const deal = input();
        const before = JSON.stringify(deal);
        const result = await solveDdsContract(deal, createNodeDdsEngine(), new AbortController().signal);
        expect(result.optimalDeclarerTricks).toBe(1);
        expect(result.declarerTricksInLine).toBe(1);
        expect(result.canMakeContract).toBe(false);
        for (let length = 0; length < result.line.length; length += 1) {
            const play = result.line[length];
            const state = buildPlayState(deal, result.line.slice(0, length));
            expect(play?.player).toBe(state.playerToMove);
            expect(getLegalCards(state)).toContainEqual(play?.card);
        }
        expect(buildPlayState(deal, result.line).isComplete).toBe(true);
        expect(JSON.stringify(deal)).toBe(before);
    });

    it("rejects duplicate cards and wrong hand counts before invoking DDS", () => {
        const duplicate = input();
        const duplicated = { ...duplicate, hands: { ...duplicate.hands, East: { ...duplicate.hands.East, spades: ["A"] as const } } };
        expect(() => createDdsAnalysisSession(duplicated, createNodeDdsEngine())).toThrow(/more than once/);
        const uneven = input();
        const unbalanced = { ...uneven, hands: { ...uneven.hands, North: { ...uneven.hands.North, spades: ["A"] as const } } };
        expect(() => createDdsAnalysisSession(unbalanced, createNodeDdsEngine())).toThrow(/same number/);
    });
});
