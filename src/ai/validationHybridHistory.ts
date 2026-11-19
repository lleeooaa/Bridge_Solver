import type { PlayedCard } from "../bridge";

export type ValidationHybridCheckpoints = readonly (readonly PlayedCard[])[];

export interface ValidationHybridUndo {
    readonly history: readonly PlayedCard[];
    readonly checkpoints: ValidationHybridCheckpoints;
}

export const createValidationHybridHistory = (openingLead: PlayedCard): readonly PlayedCard[] => [openingLead];

export const recordValidationHybridDecision = (
    checkpoints: ValidationHybridCheckpoints,
    history: readonly PlayedCard[],
): ValidationHybridCheckpoints => [...checkpoints, history];

export const undoValidationHybridDecision = (
    checkpoints: ValidationHybridCheckpoints,
): ValidationHybridUndo | null => {
    const history = checkpoints[checkpoints.length - 1];
    if (history === undefined) return null;
    return { history, checkpoints: checkpoints.slice(0, -1) };
};
