import { describe, expect, it } from "vitest";
import {
    assessDeal,
    createRandomHands,
    DIRECTIONS,
    RANKS,
    SUITS,
} from "./bridge";

describe("random deal generation", () => {
    it("deals a complete unique deck with thirteen cards per seat", () => {
        const hands = createRandomHands();
        const assessment = assessDeal(hands);
        const dealtCards = DIRECTIONS.flatMap((direction) =>
            SUITS.flatMap((suit) =>
                hands[direction][suit].map((rank) => `${suit}-${rank}`),
            ),
        );
        const deck = SUITS.flatMap((suit) =>
            RANKS.map((rank) => `${suit}-${rank}`),
        );

        expect(assessment.isValid).toBe(true);
        expect(assessment.counts).toEqual({
            North: 13,
            East: 13,
            South: 13,
            West: 13,
        });
        expect(dealtCards.sort()).toEqual(deck.sort());
    });
});
