import { describe, expect, it } from "vitest";
import type { Contract } from "../bridge";
import { createAdvisorContext, normalizeAdvisorContext, parseAuction } from "./context";

const contract: Contract = { level: 3, strain: "no-trump", declarer: "North", doubling: "undoubled" };
const contextFor = (text: string) => ({
    ...createAdvisorContext(), dealer: "North" as const, auction: parseAuction(text, "North"),
});

describe("public auction and convention context", () => {
    it("keeps unavailable metadata explicitly unknown and copies only supported fields", () => {
        expect(normalizeAdvisorContext(undefined, contract)).toEqual(createAdvisorContext());
        const context = {
            ...contextFor("1C P 1H P 1NT P 3NT P P P"),
            northSouth: { biddingSystem: "  2/1 game forcing  ", carding: "  UDCA  ", privateCards: "secret" },
            auctionNotes: "  1NT rebid: 12-14  ",
            hiddenHands: "secret",
        };
        const normalized = normalizeAdvisorContext(context, contract);
        expect(normalized.northSouth).toEqual({ biddingSystem: "2/1 game forcing", carding: "UDCA" });
        expect(normalized.auctionNotes).toBe("1NT rebid: 12-14");
        expect(normalized).not.toHaveProperty("hiddenHands");
        expect(context.northSouth.biddingSystem).toBe("  2/1 game forcing  ");
        expect(normalized.auction.map((entry) => entry.player)).toEqual([
            "North", "East", "South", "West", "North", "East", "South", "West", "North", "East",
        ]);
    });

    it("normalizes common call aliases and rotates from the selected dealer", () => {
        expect(parseAuction("pass, 1n; double redouble P P P", "West").map((entry) => entry.call))
            .toEqual(["P", "1NT", "X", "XX", "P", "P", "P"]);
        expect(parseAuction("", null)).toEqual([]);
        expect(() => parseAuction("1NT P P P", null)).toThrow(/dealer/i);
        expect(() => parseAuction("1NT mystery P P P", "North")).toThrow(/call 2/i);
        expect(() => parseAuction("8C P P P", "North")).toThrow(/call 1/i);
    });

    it("accepts legal doubles, redoubles and an overcall that resets doubling", () => {
        normalizeAdvisorContext(contextFor("3NT X XX P P P"), { ...contract, doubling: "redoubled" });
        normalizeAdvisorContext(contextFor("1C X XX 1D P P P"), {
            level: 1, strain: "diamonds", declarer: "West", doubling: "undoubled",
        });
        normalizeAdvisorContext(contextFor("3NT P P X P P P"), { ...contract, doubling: "doubled" });
    });

    it.each([
        ["1NT P 1S P P P", /higher/i],
        ["1NT P X P P P", /double/i],
        ["1NT XX P P P", /redouble/i],
        ["1NT X P XX P P P", /redouble/i],
        ["P P P P", /passed out/i],
        ["3NT P P", /complete/i],
        ["3NT P P P P", /ended/i],
    ])("rejects illegal or incomplete auctions: %s", (text, error) => {
        expect(() => normalizeAdvisorContext(contextFor(text), contract)).toThrow(error);
    });

    it("checks final level, strain, doubling and the first partnership bidder of the final strain", () => {
        expect(() => normalizeAdvisorContext(contextFor("1NT P 3NT P P P"), {
            ...contract, declarer: "South",
        })).toThrow(/declarer/i);
        expect(() => normalizeAdvisorContext(contextFor("2NT P P P"), contract)).toThrow(/contract/i);
        expect(() => normalizeAdvisorContext(contextFor("3NT X P P P"), contract)).toThrow(/contract/i);
        const wrongTurn = contextFor("3NT P P P");
        expect(() => normalizeAdvisorContext({
            ...wrongTurn, auction: wrongTurn.auction.map((call) => ({ ...call, player: "North" })),
        }, contract)).toThrow(/turn/i);
    });

    it("rejects invalid metadata rather than silently replacing it", () => {
        expect(() => normalizeAdvisorContext({
            ...createAdvisorContext(), northSouth: { biddingSystem: "x".repeat(501), carding: "" },
        }, contract)).toThrow(/500/);
        const invalid = JSON.parse('{"dealer":null,"vulnerability":"sometimes","auction":[],"auctionNotes":"","northSouth":{"biddingSystem":"","carding":""},"eastWest":{"biddingSystem":"","carding":""}}');
        expect(() => normalizeAdvisorContext(invalid, contract)).toThrow(/vulnerability/i);
    });
});
