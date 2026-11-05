import {
    createEmptyHands, DIRECTIONS, RANKS, SUITS,
    type Card, type Contract, type Direction, type Hands, type PlayedCard, type SolverInput,
} from "./bridge";

export interface PlayState {
    readonly hands: Hands;
    readonly playerToMove: Direction;
    readonly currentTrick: readonly PlayedCard[];
    readonly lastTrick: readonly PlayedCard[];
    readonly declarerTricksWon: number;
    readonly defenderTricksWon: number;
    readonly totalTricks: number;
    readonly cardsPlayed: number;
    readonly isComplete: boolean;
}

export const nextPlayer = (seat: Direction): Direction => {
    const index = DIRECTIONS.indexOf(seat);
    const next = DIRECTIONS[(index + 1) % 4];
    if (index < 0 || next === undefined) {
        throw new Error(`Invalid seat "${String(seat)}".`);
    }
    return next;
};

export const isDeclarerSide = (seat: Direction, contract: Readonly<Contract>): boolean =>
    DIRECTIONS.indexOf(seat) % 2 === DIRECTIONS.indexOf(contract.declarer) % 2;

/**
 * Measures a card choice against the exact value before it was played.
 *
 * Declarer-side choices may only preserve or lower declarer's optimum; a
 * defender-side choice may only preserve or raise it. Equal values mean the
 * choice was optimal, even if it was not the single recommended card shown.
 */
export const getTricksLostByMove = (
    previousOptimalTricks: number,
    currentOptimalTricks: number,
    player: Direction,
    contract: Readonly<Contract>,
): number => {
    const valueChange = currentOptimalTricks - previousOptimalTricks;
    const tricksLost = valueChange === 0
        ? 0
        : isDeclarerSide(player, contract)
            ? -valueChange
            : valueChange;

    if (tricksLost < 0) {
        throw new Error("The move contradicts the previous exact position value.");
    }

    return tricksLost;
};

/** This helper is shared by simulation, the solver's public API, and CLI formatting. */
export const getTrickWinner = (
    trick: readonly PlayedCard[], contract: Readonly<Contract>,
): Direction => {
    if (trick.length !== 4) {
        throw new Error("A complete trick must contain exactly four cards.");
    }
    let winner = trick[0];
    if (winner === undefined) {
        throw new Error("A trick must contain a winning play.");
    }
    for (const play of trick) {
        if (!RANKS.includes(play.card.rank)) {
            throw new Error(`Invalid trick rank "${String(play.card.rank)}".`);
        }
        if ((play.card.suit === winner.card.suit &&
            RANKS.indexOf(play.card.rank) > RANKS.indexOf(winner.card.rank)) ||
            (play.card.suit === contract.strain && winner.card.suit !== contract.strain)) {
            winner = play;
        }
    }
    return winner.player;
};

export const getLegalCards = (state: PlayState): Card[] => {
    if (state.isComplete) {
        return [];
    }
    const hand = state.hands[state.playerToMove];
    const ledSuit = state.currentTrick[0]?.card.suit;
    const suits = ledSuit !== undefined && hand[ledSuit].length > 0 ? [ledSuit] : SUITS;
    return suits.flatMap((suit) =>
        [...RANKS].reverse().filter((rank) => hand[suit].includes(rank)).map((rank) => ({ suit, rank })),
    );
};

/** Replaying a short history makes Undo and branching independent of mutable solver state. */
export const buildPlayState = (
    input: SolverInput, history: readonly PlayedCard[] = [],
): PlayState => {
    const hands = createEmptyHands();
    for (const seat of DIRECTIONS) {
        for (const suit of SUITS) {
            hands[seat][suit] = [...input.hands[seat][suit]];
        }
    }

    const totalTricks = SUITS.reduce((count, suit) => count + hands.North[suit].length, 0);
    let playerToMove = nextPlayer(input.contract.declarer);
    let currentTrick: PlayedCard[] = [];
    let lastTrick: PlayedCard[] = [];
    let declarerTricksWon = 0;
    let defenderTricksWon = 0;

    for (const play of history) {
        if (play.player !== playerToMove) {
            throw new Error(`It is ${playerToMove}'s turn.`);
        }
        if (declarerTricksWon + defenderTricksWon === totalTricks) {
            throw new Error("All cards have already been played.");
        }

        const ranks = hands[playerToMove][play.card.suit];
        if (ranks === undefined || !ranks.includes(play.card.rank)) {
            throw new Error(`${playerToMove} does not hold that card.`);
        }

        const ledSuit = currentTrick[0]?.card.suit;
        if (ledSuit !== undefined && hands[playerToMove][ledSuit].length > 0 && play.card.suit !== ledSuit) {
            throw new Error(`${playerToMove} must follow ${ledSuit}.`);
        }

        hands[playerToMove][play.card.suit] = ranks.filter((rank) => rank !== play.card.rank);
        currentTrick.push({ player: play.player, card: { ...play.card } });
        playerToMove = nextPlayer(playerToMove);

        if (currentTrick.length === 4) {
            playerToMove = getTrickWinner(currentTrick, input.contract);
            if (isDeclarerSide(playerToMove, input.contract)) {
                declarerTricksWon += 1;
            }
            else {
                defenderTricksWon += 1;
            }
            lastTrick = currentTrick;
            currentTrick = [];
        }
    }

    return {
        hands, playerToMove, currentTrick, lastTrick, declarerTricksWon, defenderTricksWon,
        totalTricks, cardsPlayed: history.length,
        isComplete: declarerTricksWon + defenderTricksWon === totalTricks,
    };
};
