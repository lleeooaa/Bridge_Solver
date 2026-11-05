import { createSampleHands, type PlayedCard, type SolverInput } from "../bridge";
import { buildPlayState, getLegalCards, isDeclarerSide } from "../play";
import type { AdvisorInput } from "./types";

export const fixture = (): { deal: SolverInput; input: AdvisorInput } => {
    const hands = createSampleHands();
    const contract = { level: 3, strain: "no-trump", declarer: "North", doubling: "undoubled" } as const;
    return { deal: { hands, contract }, input: { contract, declarerHand: hands.North, dummyHand: hands.South } };
};

export const endgameHistory = (deal: SolverInput): PlayedCard[] => {
    const history: PlayedCard[] = [];
    while (history.length < 44 || !isDeclarerSide(buildPlayState(deal, history).playerToMove, deal.contract)) {
        const state = buildPlayState(deal, history);
        const card = getLegalCards(state)[0];
        if (card === undefined) throw new Error("Fixture ended too early.");
        history.push({ player: state.playerToMove, card });
    }
    return history;
};
