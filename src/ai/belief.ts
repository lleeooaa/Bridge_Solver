import { RANKS, SUITS, type Card, type Contract, type Direction, type PlayedCard, type Suit } from "../bridge";
import { isDeclarerSide, nextPlayer } from "../play";
import type { AdvisorContext } from "./context";
import { buildObservation, getObservedPlayableCards } from "./observation";
import type { AdvisorInput } from "./types";

export const BELIEF_FEATURE_SCHEMA = "bridge-declarer-features/v1";
export const BELIEF_MODEL_SCHEMA = "bridge-belief-model/v1";
export const BELIEF_OUTPUT_SCHEMA = "bridge-hidden-deal-log-weights/v1";

interface IndexedPlay {
    readonly player: Direction;
    readonly card: number;
}

export interface BeliefFeatures {
    readonly schema: typeof BELIEF_FEATURE_SCHEMA;
    readonly observer: Direction;
    readonly actor: Direction;
    readonly dummy: Direction;
    readonly contract: Readonly<Contract>;
    readonly context: AdvisorContext;
    readonly hiddenSeats: readonly [Direction, Direction];
    readonly declarerCards: readonly number[];
    readonly dummyCards: readonly number[];
    readonly unseenCards: readonly number[];
    readonly played: readonly IndexedPlay[];
    readonly currentTrick: readonly IndexedPlay[];
    readonly remainingCounts: Readonly<Record<Direction, number>>;
    readonly voids: Readonly<Record<Direction, readonly Suit[]>>;
    readonly declarerTricksWon: number;
    readonly defenderTricksWon: number;
    readonly legalCards: readonly number[];
}

export interface BeliefModelManifest {
    readonly schema: typeof BELIEF_MODEL_SCHEMA;
    readonly id: string;
    readonly version: string;
    readonly featureSchema: typeof BELIEF_FEATURE_SCHEMA;
    readonly outputSchema: typeof BELIEF_OUTPUT_SCHEMA;
}

// Each candidate assigns every unseen card to one defender or its complement.
export interface BeliefCandidate {
    readonly firstDefenderCards: readonly number[];
}

export interface BeliefScores {
    readonly schema: typeof BELIEF_OUTPUT_SCHEMA;
    readonly modelId: string;
    readonly modelVersion: string;
    readonly logWeights: readonly (number | null)[];
}

export interface BeliefModel {
    readonly manifest: BeliefModelManifest;
    scoreDeals: (
        features: BeliefFeatures, candidates: readonly BeliefCandidate[], signal: AbortSignal,
    ) => Promise<BeliefScores>;
}

const cardIndex = (card: Card): number => SUITS.indexOf(card.suit) * 13 + RANKS.indexOf(card.rank);
const indexedPlay = (play: PlayedCard): IndexedPlay => ({ player: play.player, card: cardIndex(play.card) });
const ascending = (left: number, right: number): number => left - right;

export const buildBeliefFeatures = (input: AdvisorInput, history: readonly PlayedCard[]): BeliefFeatures => {
    const observed = buildObservation(input, history);
    if (history.length === 0 || observed.isComplete || !isDeclarerSide(observed.playerToMove, input.contract)) {
        throw new Error("Model features are available only on declarer or dummy turns, after the opening lead.");
    }
    const { level, strain, declarer, doubling } = input.contract;
    const handIndices = (hand: typeof observed.declarerHand): number[] =>
        SUITS.flatMap((suit) => hand[suit].map((rank) => cardIndex({ suit, rank }))).sort(ascending);
    return {
        schema: BELIEF_FEATURE_SCHEMA, observer: declarer, actor: observed.playerToMove, dummy: observed.dummy,
        contract: { level, strain, declarer, doubling }, context: observed.context,
        hiddenSeats: [nextPlayer(declarer), nextPlayer(observed.dummy)],
        declarerCards: handIndices(observed.declarerHand), dummyCards: handIndices(observed.dummyHand),
        unseenCards: observed.unseenCards.map(cardIndex).sort(ascending), played: history.map(indexedPlay),
        currentTrick: observed.currentTrick.map(indexedPlay), remainingCounts: observed.remainingCounts,
        voids: observed.voids, declarerTricksWon: observed.declarerTricksWon, defenderTricksWon: observed.defenderTricksWon,
        legalCards: getObservedPlayableCards(observed, input.contract).map(cardIndex).sort(ascending),
    };
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);
const identifier = (value: unknown, name: string): string => {
    if (typeof value !== "string" || value.trim() === "" || value.length > 120 || value !== value.trim()) {
        throw new Error(`Belief model ${name} must be nonempty text of at most 120 characters, without surrounding whitespace.`);
    }
    return value;
};

export const validateBeliefModelManifest = (value: unknown): BeliefModelManifest => {
    if (!isRecord(value) || value.schema !== BELIEF_MODEL_SCHEMA) throw new Error("Unsupported belief model manifest schema.");
    if (value.featureSchema !== BELIEF_FEATURE_SCHEMA) throw new Error("Unsupported belief model feature schema.");
    if (value.outputSchema !== BELIEF_OUTPUT_SCHEMA) throw new Error("Unsupported belief model output schema.");
    return {
        schema: BELIEF_MODEL_SCHEMA, id: identifier(value.id, "id"), version: identifier(value.version, "version"),
        featureSchema: BELIEF_FEATURE_SCHEMA, outputSchema: BELIEF_OUTPUT_SCHEMA,
    };
};

export const validateBeliefScores = (value: unknown, manifest: BeliefModelManifest, candidateCount: number): BeliefScores => {
    validateBeliefModelManifest(manifest);
    if (!isRecord(value) || value.schema !== BELIEF_OUTPUT_SCHEMA) throw new Error("Unsupported belief score schema.");
    if (value.modelId !== manifest.id || value.modelVersion !== manifest.version) throw new Error("Belief scores belong to a different model.");
    if (!Number.isInteger(candidateCount) || candidateCount < 1 ||
        !Array.isArray(value.logWeights) || value.logWeights.length !== candidateCount) {
        throw new Error("Belief score count must match the candidate count.");
    }
    const logWeights = value.logWeights.map((weight: unknown): number | null => {
        if (weight === null) return null;
        if (typeof weight !== "number" || !Number.isFinite(weight)) throw new Error("Belief log weights must be finite numbers or null for zero mass.");
        return weight;
    });
    if (logWeights.every((weight) => weight === null)) throw new Error("Belief model assigned zero mass to every candidate.");
    return { schema: BELIEF_OUTPUT_SCHEMA, modelId: manifest.id, modelVersion: manifest.version, logWeights };
};
