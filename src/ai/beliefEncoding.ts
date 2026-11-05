import { DIRECTIONS, SUITS } from "../bridge";
import { VULNERABILITIES } from "./context";
import type { BeliefCandidate, BeliefFeatures } from "./belief";

export const BELIEF_TENSOR_SCHEMA = "bridge-belief-tensors/v1";
export const BELIEF_STATE_SIZE = 201;
export const BELIEF_AUCTION_SIZE = 319;
export const BELIEF_PLAY_SIZE = 52;
export const BELIEF_HIDDEN_SIZE = 26;
const actions = ["P", "X", "XX", ...[1, 2, 3, 4, 5, 6, 7].flatMap((level) =>
    ["C", "D", "H", "S", "NT"].map((strain) => `${level}${strain}`))];

export const encodeBeliefFeatures = (features: BeliefFeatures): {
    state: number[]; auction: number[]; play: number[]; cards: number[];
} => {
    const { context } = features;
    if (context.auction.length === 0 || context.dealer === null || context.vulnerability === "unknown") {
        throw new Error("Learned beliefs require a complete auction, dealer and known vulnerability.");
    }
    if (context.auction.length > BELIEF_AUCTION_SIZE || features.played.length > BELIEF_PLAY_SIZE ||
        features.unseenCards.length > BELIEF_HIDDEN_SIZE) throw new Error("Belief sequence exceeds its legal maximum.");
    const declarer = DIRECTIONS.indexOf(features.observer);
    const relative = (seat: (typeof DIRECTIONS)[number]): number => (DIRECTIONS.indexOf(seat) - declarer + 4) % 4;
    const state: number[] = [];
    const oneHot = (index: number, count: number): void => {
        for (let value = 0; value < count; value += 1) state.push(Number(value === index));
    };
    for (const cards of [features.declarerCards, features.dummyCards, features.unseenCards]) {
        const held = new Set(cards);
        for (let card = 0; card < 52; card += 1) state.push(Number(held.has(card)));
    }
    const seats = [...DIRECTIONS].sort((a, b) => relative(a) - relative(b));
    for (const seat of seats) for (const suit of SUITS) state.push(Number(features.voids[seat].includes(suit)));
    for (const seat of seats) state.push(features.remainingCounts[seat] / 13);
    state.push(features.contract.level / 7);
    oneHot([...SUITS, "no-trump"].indexOf(features.contract.strain), 5);
    oneHot(["undoubled", "doubled", "redoubled"].indexOf(features.contract.doubling), 3);
    let vulnerable: number = VULNERABILITIES.indexOf(context.vulnerability);
    if (declarer % 2 === 1 && (vulnerable === 2 || vulnerable === 3)) vulnerable = 5 - vulnerable;
    oneHot(vulnerable, 5);
    oneHot(relative(context.dealer), 4);
    oneHot(relative(features.actor), 4);
    state.push(features.declarerTricksWon / 13, features.defenderTricksWon / 13, features.currentTrick.length / 4);
    if (state.length !== BELIEF_STATE_SIZE) throw new Error("Belief tensor encoder size mismatch.");
    const auction = context.auction.map((entry) => 1 + actions.indexOf(entry.call) * 4 + relative(entry.player));
    const play = features.played.map((entry) => 1 + entry.card * 4 + relative(entry.player));
    return {
        state, auction: [...auction, ...Array<number>(BELIEF_AUCTION_SIZE - auction.length).fill(0)],
        play: [...play, ...Array<number>(BELIEF_PLAY_SIZE - play.length).fill(0)],
        cards: [...features.unseenCards, ...Array<number>(BELIEF_HIDDEN_SIZE - features.unseenCards.length).fill(52)],
    };
};

export const encodeBeliefCandidate = (features: BeliefFeatures, candidate: BeliefCandidate): {
    targets: number[]; previous: number[]; allowed: number[]; active: number[];
} => {
    const [first, second] = features.hiddenSeats;
    const assigned = new Set(candidate.firstDefenderCards);
    let needs = features.remainingCounts[first];
    if (assigned.size !== candidate.firstDefenderCards.length || assigned.size !== needs ||
        [...assigned].some((card) => !features.unseenCards.includes(card))) {
        throw new Error("Belief candidate must allocate the correct number of distinct unseen cards.");
    }
    const possible = features.unseenCards.map((card): readonly [boolean, boolean] => {
        const suit = SUITS[Math.floor(card / 13)];
        if (suit === undefined) throw new Error("Invalid unseen card identity.");
        return [!features.voids[first].includes(suit), !features.voids[second].includes(suit)];
    });
    const targets: number[] = [];
    const allowed: number[] = [];
    features.unseenCards.forEach((card, index) => {
        const pair = possible[index];
        if (pair === undefined) throw new Error("Missing candidate constraint.");
        const future = possible.slice(index + 1);
        const minimum = future.filter((value) => !value[1]).length;
        const maximum = future.filter((value) => value[0]).length;
        const left = pair[0] && minimum <= needs - 1 && needs - 1 <= maximum;
        const right = pair[1] && minimum <= needs && needs <= maximum;
        const target = assigned.has(card) ? 0 : 1;
        if (!(target === 0 ? left : right)) throw new Error("Belief candidate violates public void/count constraints.");
        targets.push(target);
        allowed.push(Number(left), Number(right));
        needs -= Number(target === 0);
    });
    const length = targets.length;
    const previous = [2, ...targets].slice(0, BELIEF_HIDDEN_SIZE);
    while (previous.length < BELIEF_HIDDEN_SIZE) previous.push(0);
    while (targets.length < BELIEF_HIDDEN_SIZE) { targets.push(0); allowed.push(1, 0); }
    return { targets, previous, allowed, active: Array.from({ length: BELIEF_HIDDEN_SIZE }, (_, n) => Number(n < length)) };
};
