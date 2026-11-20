import { RANKS, SUITS, cloneHand, createEmptyHands, type Contract, type Direction } from "../bridge";
import type { PlayState } from "../play";
import { getHiddenAllocation } from "./observation";
import type { Observation } from "./types";

export const createRandom = (seed: number): (() => number) => {
    if (!Number.isInteger(seed) || seed < 0 || seed > 0xffff_ffff) throw new Error("Seed must be an unsigned 32-bit integer.");
    let state = seed;
    return () => {
        state = (state + 0x6d2b79f5) | 0;
        let value = Math.imul(state ^ (state >>> 15), state | 1);
        value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
        return ((value ^ (value >>> 14)) >>> 0) / 0x1_0000_0000;
    };
};

export const samplePosition = (
    observation: Observation, contract: Readonly<Contract>, random: () => number,
): PlayState => {
    const allocation = getHiddenAllocation(observation, contract);
    const cards = [...allocation.flexible];
    for (let index = cards.length - 1; index > 0; index -= 1) {
        const draw = random();
        if (!(draw >= 0 && draw < 1)) throw new Error("Random source must return a number in [0, 1).");
        const target = Math.floor(draw * (index + 1));
        const left = cards[index];
        const right = cards[target];
        if (left === undefined || right === undefined) throw new Error("Invalid shuffle index.");
        cards[index] = right;
        cards[target] = left;
    }
    const hands = createEmptyHands();
    hands[contract.declarer] = cloneHand(observation.declarerHand);
    hands[observation.dummy] = cloneHand(observation.dummyHand);
    for (const card of [...allocation.forcedFirst, ...cards.slice(0, allocation.firstNeeds)]) {
        hands[allocation.first][card.suit].push(card.rank);
    }
    for (const card of [...allocation.forcedSecond, ...cards.slice(allocation.firstNeeds)]) {
        hands[allocation.second][card.suit].push(card.rank);
    }
    return {
        hands, playerToMove: observation.playerToMove, currentTrick: observation.currentTrick,
        lastTrick: observation.lastTrick, declarerTricksWon: observation.declarerTricksWon,
        defenderTricksWon: observation.defenderTricksWon, totalTricks: 13,
        cardsPlayed: observation.cardsPlayed, isComplete: observation.isComplete,
    };
};

export const positionFromCandidate = (
    observation: Observation, contract: Readonly<Contract>, first: Direction,
    firstDefenderCards: readonly number[],
): PlayState => {
    const allocation = getHiddenAllocation(observation, contract);
    const assigned = new Set(firstDefenderCards);
    if (first !== allocation.first || assigned.size !== firstDefenderCards.length ||
        assigned.size !== observation.remainingCounts[first]) {
        throw new Error("Belief candidate must allocate the correct number of distinct cards to the first defender.");
    }
    const unseen = new Set(observation.unseenCards.map((card) =>
        SUITS.indexOf(card.suit) * 13 + RANKS.indexOf(card.rank)));
    if ([...assigned].some((card) => !unseen.has(card))) {
        throw new Error("Belief candidate contains a card that is not unseen.");
    }
    const hands = createEmptyHands();
    hands[contract.declarer] = cloneHand(observation.declarerHand);
    hands[observation.dummy] = cloneHand(observation.dummyHand);
    for (const card of observation.unseenCards) {
        const index = SUITS.indexOf(card.suit) * 13 + RANKS.indexOf(card.rank);
        const owner = assigned.has(index) ? allocation.first : allocation.second;
        if (observation.voids[owner].includes(card.suit)) {
            throw new Error("Belief candidate violates a public defender void.");
        }
        hands[owner][card.suit].push(card.rank);
    }
    return {
        hands, playerToMove: observation.playerToMove, currentTrick: observation.currentTrick,
        lastTrick: observation.lastTrick, declarerTricksWon: observation.declarerTricksWon,
        defenderTricksWon: observation.defenderTricksWon, totalTricks: 13,
        cardsPlayed: observation.cardsPlayed, isComplete: observation.isComplete,
    };
};
