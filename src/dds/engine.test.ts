import { describe, expect, it } from "vitest";
import { createEmptyHands, type Contract, type PlayedCard, type SolverInput } from "../bridge";
import { buildPlayState, getLegalCards, isDeclarerSide } from "../play";
import { solveTrickTarget } from "../solver";
import { cardKey } from "./engine";
import { createNodeDdsEngine } from "./node";

const contract: Contract = { level: 1, strain: "hearts", declarer: "North", doubling: "undoubled" };
const deal = (): SolverInput => {
    const hands = createEmptyHands();
    hands.North.spades = ["A", "Q"];
    hands.East.spades = ["K"];
    hands.East.hearts = ["A"];
    hands.South.spades = ["J"];
    hands.South.hearts = ["2"];
    hands.West.spades = ["T"];
    hands.West.hearts = ["K"];
    return { hands, contract };
};

const exhaustive = (input: SolverInput, history: readonly PlayedCard[]): number => {
    const state = buildPlayState(input, history);
    if (state.isComplete) return state.declarerTricksWon;
    const values = getLegalCards(state).map((card) =>
        exhaustive(input, [...history, { player: state.playerToMove, card }]));
    return isDeclarerSide(state.playerToMove, input.contract) ? Math.max(...values) : Math.min(...values);
};

describe("real library DDS / WASM", () => {
    it("scores every legal card through partial tricks and preserves exact declarer totals", async () => {
        const engine = createNodeDdsEngine();
        const input = deal();
        const history: PlayedCard[] = [];
        try {
            while (!buildPlayState(input, history).isComplete) {
                const state = buildPlayState(input, history);
                const values = await engine.evaluate(state, contract, new AbortController().signal);
                expect(values.length).toBeGreaterThan(0);
                for (const value of values) {
                    expect(value.declarerTricks).toBe(exhaustive(input, [
                        ...history, { player: state.playerToMove, card: value.card },
                    ]));
                }
                const selected = values.find((value) => cardKey(value.card) === "spades:K") ?? values[0];
                if (selected === undefined) throw new Error("Missing evaluated card.");
                history.push({ player: state.playerToMove, card: selected.card });
            }
            expect(await engine.evaluate(buildPlayState(input, history), contract, new AbortController().signal)).toEqual([]);
        } finally {
            engine.dispose();
        }
    }, 20_000);

    it("agrees with the reference solver across strains and declarer partnerships", async () => {
        const engine = createNodeDdsEngine();
        try {
            for (const strain of ["hearts", "spades", "no-trump"] as const) {
                for (const declarer of ["North", "East", "South", "West"] as const) {
                    const input = deal();
                    const next = { ...input, contract: { ...contract, strain, declarer } };
                    const state = buildPlayState(next);
                    const values = await engine.evaluate(state, next.contract, new AbortController().signal);
                    const optimum = Math.min(...values.map((value) => value.declarerTricks));
                    expect(optimum).toBe(solveTrickTarget(next, 1).optimalDeclarerTricks);
                }
            }
        } finally {
            engine.dispose();
        }
    }, 20_000);

    it("supports cancelling initialization and restarting the runtime", async () => {
        const engine = createNodeDdsEngine();
        const controller = new AbortController();
        try {
            const pending = engine.evaluate(buildPlayState(deal()), contract, controller.signal);
            controller.abort();
            await expect(pending).rejects.toMatchObject({ name: "AbortError" });
            const values = await engine.evaluate(buildPlayState(deal()), contract, new AbortController().signal);
            expect(values).toHaveLength(2);
        } finally {
            engine.dispose();
        }
    }, 20_000);
});
