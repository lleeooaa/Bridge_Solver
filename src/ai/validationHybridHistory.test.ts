import { describe, expect, it } from "vitest";
import type { PlayedCard } from "../bridge";
import {
    createValidationHybridHistory, recordValidationHybridDecision, undoValidationHybridDecision,
} from "./validationHybridHistory";

const openingLead: PlayedCard = { player: "North", card: { suit: "clubs", rank: "2" } };
const dummyPlay: PlayedCard = { player: "East", card: { suit: "clubs", rank: "3" } };
const firstDefense: PlayedCard = { player: "South", card: { suit: "clubs", rank: "4" } };
const declarerPlay: PlayedCard = { player: "West", card: { suit: "clubs", rank: "5" } };
const secondDefense: PlayedCard = { player: "North", card: { suit: "clubs", rank: "6" } };

describe("validation hybrid history", () => {
    it("starts from the recorded opening lead", () => {
        expect(createValidationHybridHistory(openingLead)).toEqual([openingLead]);
    });

    it("rewinds a decision and its DDS replies while preserving earlier decisions", () => {
        const initial = createValidationHybridHistory(openingLead);
        const checkpoints = recordValidationHybridDecision([], initial);
        const afterFirstDecision = [...initial, dummyPlay, firstDefense];
        const withSecondCheckpoint = recordValidationHybridDecision(checkpoints, afterFirstDecision);
        const current = [...afterFirstDecision, declarerPlay, secondDefense];

        const undone = undoValidationHybridDecision(withSecondCheckpoint);
        expect(undone).toEqual({ history: afterFirstDecision, checkpoints });
        expect(current).not.toEqual(undone?.history);

        expect(undoValidationHybridDecision(undone!.checkpoints)).toEqual({
            history: initial,
            checkpoints: [],
        });
    });

    it("does not undo past the opening lead when no declarer decision is recorded", () => {
        expect(undoValidationHybridDecision([])).toBeNull();
    });
});
