import type { Card, Contract, Direction, Hand, PlayedCard, Rank, Suit } from "../bridge";
import type { AdvisorContext } from "./context";

export interface AdvisorInput {
    readonly contract: Readonly<Contract>;
    readonly declarerHand: Readonly<Record<Suit, readonly Rank[]>>;
    readonly dummyHand: Readonly<Record<Suit, readonly Rank[]>>;
    readonly context?: AdvisorContext;
}

export interface Observation {
    readonly context: AdvisorContext;
    readonly declarerHand: Hand;
    readonly dummyHand: Hand;
    readonly dummy: Direction;
    readonly playerToMove: Direction;
    readonly currentTrick: readonly PlayedCard[];
    readonly lastTrick: readonly PlayedCard[];
    readonly declarerTricksWon: number;
    readonly defenderTricksWon: number;
    readonly remainingCounts: Readonly<Record<Direction, number>>;
    readonly voids: Readonly<Record<Direction, readonly Suit[]>>;
    readonly unseenCards: readonly Card[];
    readonly cardsPlayed: number;
    readonly isComplete: boolean;
}

export interface AdvisorOptions {
    readonly samples: number;
    readonly seed: number;
    readonly belief?: { readonly type: "uniform" } | { readonly type: "learned"; readonly manifestUrl: string };
}

export interface CardEstimate {
    readonly card: Card;
    readonly makeProbability: number;
    readonly expectedTricks: number;
    readonly samplingInterval: readonly [number, number];
}

export interface Advice {
    readonly candidates: readonly CardEstimate[];
    readonly samples: number;
    readonly requestedSamples: number;
    readonly seed: number;
    readonly elapsedMilliseconds: number;
    readonly model: "uniform-hard-constraints" | "learned-joint";
    readonly modelId?: string;
    readonly modelVersion?: string;
    readonly modelNotice?: string;
    readonly effectiveSampleSize?: number;
    readonly intervalKind?: "wilson" | "importance-asymptotic";
    readonly warning?: string;
    readonly complete: boolean;
}
