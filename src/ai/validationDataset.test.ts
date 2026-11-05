import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
    createEmptyHands, DIRECTIONS, RANKS, SUITS,
    type Contract, type Hands, type PlayedCard, type Rank, type Suit,
} from "../bridge";
import { buildPlayState, getLegalCards } from "../play";
import { pickRandomValidationDeal } from "./validationDataset";

const contract: Contract = { level: 1, strain: "no-trump", declarer: "West", doubling: "undoubled" };

const createHands = (differentDeal = false): Hands => {
    const hands = createEmptyHands();
    for (let card = 0; card < 52; card += 1) {
        const seat = DIRECTIONS[Math.floor(card / 13)];
        const suit = SUITS[Math.floor(card / 13)];
        const rank = RANKS[card % 13];
        if (seat === undefined || suit === undefined || rank === undefined) {
            throw new Error("Could not create a test deal.");
        }
        hands[seat][suit].push(rank);
    }
    if (differentDeal) {
        const northSpade = hands.North.spades.pop();
        const eastHeart = hands.East.hearts.pop();
        if (northSpade === undefined || eastHeart === undefined) throw new Error("Could not vary the test deal.");
        hands.North.hearts.push(eastHeart);
        hands.East.spades.push(northSpade);
    }
    return hands;
};

const cardId = (suit: Suit, rank: Rank): number =>
    SUITS.indexOf(suit) * 13 + RANKS.indexOf(rank);

const createRecord = (hands: Hands, variation: number): Record<string, unknown> => {
    const input = { hands, contract };
    const plays: PlayedCard[] = [];
    let state = buildPlayState(input, plays);
    while (!state.isComplete) {
        const legalCards = getLegalCards(state);
        const card = legalCards[(plays.length + variation) % legalCards.length];
        if (card === undefined) throw new Error("Could not finish a test play.");
        plays.push({ player: state.playerToMove, card });
        state = buildPlayState(input, plays);
    }

    const serializedHands: Record<string, number[]> = {};
    for (const seat of DIRECTIONS) {
        serializedHands[seat] = SUITS.flatMap((suit) =>
            hands[seat][suit].map((rank) => cardId(suit, rank))).sort((left, right) => left - right);
    }
    return {
        schema: "bridge-human-play/v2",
        hands: serializedHands,
        dealer: "West",
        vulnerability: "none",
        auction: ["1NT", "P", "P", "P"],
        plays: plays.map((play) => ({ player: play.player, card: cardId(play.card.suit, play.card.rank) })),
        claim: null,
        metadata: { variation },
    };
};

const datasetFiles = (records: readonly Record<string, unknown>[], checksum?: string): File[] => {
    const shardName = "validation-000000.jsonl";
    const contents = `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
    const shard = new File([contents], shardName, { type: "application/x-ndjson" });
    const sha256 = checksum ?? createHash("sha256").update(contents).digest("hex");
    const manifest = {
        schema: "bridge-human-play-dataset/v2",
        splits: { validation: { shards: [{ file: shardName, sha256 }] } },
    };
    return [new File([JSON.stringify(manifest)], "manifest.json"), shard];
};

describe("local validation dataset picker", () => {
    it("verifies and samples complete deals uniformly by unique deal, preserving only public advisor inputs", async () => {
        const records = [
            createRecord(createHands(), 0),
            createRecord(createHands(), 1),
            createRecord(createHands(true), 0),
        ];
        const randomValues = [0, 0.99, 0.99];
        const selection = await pickRandomValidationDeal(datasetFiles(records), {
            random: () => randomValues.shift() ?? 0.99,
        });

        const { sample } = selection;
        expect(sample.eligibleDeals).toBe(2);
        expect(sample.contract).toEqual(contract);
        expect(sample.context.dealer).toBe("West");
        expect(sample.context.vulnerability).toBe("none");
        expect(sample.auction).toEqual(["1NT", "P", "P", "P"]);
        expect(sample.openingLead.player).toBe("North");
        expect(sample).not.toHaveProperty("hands");
        expect(sample).not.toHaveProperty("plays");
        expect(selection.fullInformation.hands).toHaveProperty("North");
        expect(selection.fullInformation).not.toHaveProperty("recordedPlays");
    });

    it("rejects a changed or incomplete validation shard instead of sampling it", async () => {
        const files = datasetFiles([createRecord(createHands(), 0)], "0".repeat(64));
        await expect(pickRandomValidationDeal(files)).rejects.toThrow(/checksum mismatch/i);
    });
});
