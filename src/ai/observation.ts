import {
    DIRECTIONS, RANKS, SUITS, cloneHand, getHandCardCount,
    type Card, type Contract, type Direction, type PlayedCard, type Suit,
} from "../bridge";
import { cardKey } from "../dds/engine";
import { getTrickWinner, isDeclarerSide, nextPlayer } from "../play";
import { normalizeAdvisorContext } from "./context";
import type { AdvisorInput, Observation } from "./types";

export const getDummy = (declarer: Direction): Direction => nextPlayer(nextPlayer(declarer));

export const getHiddenAllocation = (observation: Observation, contract: Readonly<Contract>): {
    first: Direction; second: Direction; forcedFirst: Card[]; forcedSecond: Card[]; flexible: Card[]; firstNeeds: number;
} => {
    const first = nextPlayer(contract.declarer);
    const second = nextPlayer(getDummy(contract.declarer));
    const forcedFirst: Card[] = [];
    const forcedSecond: Card[] = [];
    const flexible: Card[] = [];
    for (const card of observation.unseenCards) {
        const canFirst = !observation.voids[first].includes(card.suit);
        const canSecond = !observation.voids[second].includes(card.suit);
        if (!canFirst && !canSecond) throw new Error("No compatible deal: both defenders have shown void in an unseen card's suit.");
        if (!canFirst) forcedSecond.push(card);
        else if (!canSecond) forcedFirst.push(card);
        else flexible.push(card);
    }
    const firstNeeds = observation.remainingCounts[first] - forcedFirst.length;
    const secondNeeds = observation.remainingCounts[second] - forcedSecond.length;
    if (firstNeeds < 0 || secondNeeds < 0 || firstNeeds + secondNeeds !== flexible.length) {
        throw new Error("No compatible deal: the public cards, hand counts and shown voids contradict each other.");
    }
    return { first, second, forcedFirst, forcedSecond, flexible, firstNeeds };
};

export const buildObservation = (input: AdvisorInput, history: readonly PlayedCard[] = []): Observation => {
    const { contract } = input;
    if (!DIRECTIONS.includes(contract.declarer) || !Number.isInteger(contract.level) ||
        contract.level < 1 || contract.level > 7 ||
        (contract.strain !== "no-trump" && !SUITS.includes(contract.strain)) ||
        !["undoubled", "doubled", "redoubled"].includes(contract.doubling)) {
        throw new Error("Invalid bridge contract.");
    }
    const context = normalizeAdvisorContext(input.context, contract);
    const dummy = getDummy(contract.declarer);
    const declarerHand = cloneHand(input.declarerHand);
    const dummyHand = cloneHand(input.dummyHand);
    const visible = new Set<string>();
    for (const hand of [declarerHand, dummyHand]) {
        if (getHandCardCount(hand) !== 13) throw new Error("Declarer and dummy must each start with thirteen cards.");
        for (const suit of SUITS) {
            for (const rank of hand[suit]) {
                if (!RANKS.includes(rank)) throw new Error(`Invalid card rank "${String(rank)}".`);
                const key = cardKey({ suit, rank });
                if (visible.has(key)) throw new Error(`Visible card ${key} appears more than once.`);
                visible.add(key);
            }
        }
    }
    const unseen = new Map(SUITS.flatMap((suit) => RANKS.map((rank) => ({ suit, rank })))
        .filter((card) => !visible.has(cardKey(card))).map((card) => [cardKey(card), card]));
    const remainingCounts: Record<Direction, number> = { North: 13, East: 13, South: 13, West: 13 };
    const voids: Record<Direction, Suit[]> = { North: [], East: [], South: [], West: [] };
    const played = new Set<string>();
    let playerToMove = nextPlayer(contract.declarer);
    let currentTrick: PlayedCard[] = [];
    let lastTrick: PlayedCard[] = [];
    let declarerTricksWon = 0;
    let defenderTricksWon = 0;

    for (const play of history) {
        if (play.player !== playerToMove) throw new Error(`It is ${playerToMove}'s turn.`);
        if (!SUITS.includes(play.card.suit) || !RANKS.includes(play.card.rank)) throw new Error("Invalid played card.");
        if (history.length > 52 || remainingCounts[play.player] <= 0) throw new Error("All cards for that seat have been played.");
        const key = cardKey(play.card);
        if (played.has(key)) throw new Error("That card has already been played.");
        if (voids[play.player].includes(play.card.suit)) throw new Error(`${play.player} previously showed void in ${play.card.suit}.`);
        const hand = play.player === contract.declarer ? declarerHand : play.player === dummy ? dummyHand : undefined;
        const ledSuit = currentTrick[0]?.card.suit;
        if (hand !== undefined) {
            if (!hand[play.card.suit].includes(play.card.rank)) throw new Error(`${play.player} does not hold that card.`);
            if (ledSuit !== undefined && hand[ledSuit].length > 0 && play.card.suit !== ledSuit) {
                throw new Error(`${play.player} must follow ${ledSuit}.`);
            }
            hand[play.card.suit] = hand[play.card.suit].filter((rank) => rank !== play.card.rank);
        } else {
            if (visible.has(key)) throw new Error("A defender cannot play a card from a visible hand.");
            if (!unseen.delete(key)) throw new Error("That card is not unseen.");
        }
        if (ledSuit !== undefined && play.card.suit !== ledSuit && !voids[play.player].includes(ledSuit)) {
            voids[play.player].push(ledSuit);
        }
        played.add(key);
        remainingCounts[play.player] -= 1;
        currentTrick.push({ player: play.player, card: { ...play.card } });
        playerToMove = nextPlayer(play.player);
        if (currentTrick.length === 4) {
            playerToMove = getTrickWinner(currentTrick, contract);
            if (isDeclarerSide(playerToMove, contract)) declarerTricksWon += 1;
            else defenderTricksWon += 1;
            lastTrick = currentTrick;
            currentTrick = [];
        }
    }
    const observation: Observation = {
        context, declarerHand, dummyHand, dummy, playerToMove, currentTrick, lastTrick,
        declarerTricksWon, defenderTricksWon, remainingCounts, voids,
        unseenCards: [...unseen.values()], cardsPlayed: history.length, isComplete: history.length === 52,
    };
    getHiddenAllocation(observation, contract);
    return observation;
};

export const getObservedPlayableCards = (observation: Observation, contract: Readonly<Contract>): Card[] => {
    if (observation.isComplete) return [];
    const hand = observation.playerToMove === contract.declarer ? observation.declarerHand
        : observation.playerToMove === observation.dummy ? observation.dummyHand : undefined;
    if (hand === undefined) {
        return observation.unseenCards.filter((card) => !observation.voids[observation.playerToMove].includes(card.suit));
    }
    const led = observation.currentTrick[0]?.card.suit;
    const suits = led !== undefined && hand[led].length > 0 ? [led] : SUITS;
    return suits.flatMap((suit) => [...RANKS].reverse().filter((rank) => hand[suit].includes(rank)).map((rank) => ({ suit, rank })));
};
