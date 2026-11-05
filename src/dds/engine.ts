import {
    DIRECTIONS, RANKS, SUITS, formatHand,
    type Card, type Contract,
} from "../bridge";
import { getLegalCards, isDeclarerSide, type PlayState } from "../play";

export interface DdsRequest {
    readonly id: number;
    readonly pbn: string;
    readonly trump: number;
    readonly first: number;
    readonly trick: readonly number[];
}

export interface DdsRawCard {
    readonly suit: number;
    readonly rank: number;
    readonly score: number;
}

export type DdsResponse =
    | { readonly id: number; readonly cards: readonly DdsRawCard[] }
    | { readonly id: number; readonly error: string };

export interface DdsPort {
    post: (request: DdsRequest) => void;
    subscribe: (result: (response: DdsResponse) => void, error: (error: Error) => void) => () => void;
    terminate: () => void;
}

export interface CardEvaluation {
    readonly card: Card;
    readonly declarerTricks: number;
}

export interface DdsEngine {
    evaluate: (state: PlayState, contract: Readonly<Contract>, signal: AbortSignal) => Promise<readonly CardEvaluation[]>;
    dispose: () => void;
}

export const cardKey = (card: Card): string => `${card.suit}:${card.rank}`;
export const analysisAborted = (): Error => new DOMException("Analysis cancelled.", "AbortError");

export const createDdsEngine = (createPort: () => DdsPort): DdsEngine => {
    let port: DdsPort | undefined;
    let unsubscribe: (() => void) | undefined;
    let disposed = false;
    let nextId = 0;
    const pending = new Map<number, {
        resolve: (cards: readonly DdsRawCard[]) => void;
        reject: (error: Error) => void;
        cleanup: () => void;
    }>();

    const stop = (error: Error): void => {
        unsubscribe?.();
        unsubscribe = undefined;
        port?.terminate();
        port = undefined;
        for (const entry of pending.values()) {
            entry.cleanup();
            entry.reject(error);
        }
        pending.clear();
    };

    const request = (payload: Omit<DdsRequest, "id">, signal: AbortSignal): Promise<readonly DdsRawCard[]> => {
        if (disposed) return Promise.reject(new Error("DDS engine is closed."));
        if (signal.aborted) return Promise.reject(analysisAborted());
        if (port === undefined) {
            port = createPort();
            unsubscribe = port.subscribe((response) => {
                const entry = pending.get(response.id);
                if (entry === undefined) return;
                pending.delete(response.id);
                entry.cleanup();
                if ("error" in response) entry.reject(new Error(response.error));
                else entry.resolve(response.cards);
            }, stop);
        }
        return new Promise((resolve, reject) => {
            const id = ++nextId;
            // An uninterruptible WASM call must be stopped at the worker boundary.
            const abort = (): void => stop(analysisAborted());
            pending.set(id, {
                resolve, reject,
                cleanup: () => signal.removeEventListener("abort", abort),
            });
            signal.addEventListener("abort", abort, { once: true });
            try {
                port?.post({ ...payload, id });
            } catch (error: unknown) {
                stop(error instanceof Error ? error : new Error("Could not send a DDS request."));
            }
        });
    };

    return {
        evaluate: async (state, contract, signal) => {
            if (signal.aborted) throw analysisAborted();
            if (disposed) throw new Error("DDS engine is closed.");
            if (state.isComplete) return [];
            const raw = await request({
                pbn: `N:${DIRECTIONS.map((seat) => formatHand(state.hands[seat])).join(" ")}`,
                trump: contract.strain === "no-trump" ? 4 : SUITS.indexOf(contract.strain),
                first: DIRECTIONS.indexOf(state.currentTrick[0]?.player ?? state.playerToMove),
                trick: state.currentTrick.flatMap((play) => [
                    SUITS.indexOf(play.card.suit), RANKS.indexOf(play.card.rank) + 2,
                ]),
            }, signal);
            const tricksLeft = state.totalTricks - state.declarerTricksWon - state.defenderTricksWon;
            const values = new Map<string, number>();
            for (const value of raw) {
                const suit = SUITS[value.suit];
                const rank = RANKS[value.rank - 2];
                if (suit === undefined || rank === undefined || !Number.isInteger(value.score) ||
                    value.score < 0 || value.score > tricksLeft) {
                    throw new Error("DDS returned an invalid card or trick value.");
                }
                const key = cardKey({ suit, rank });
                if (values.has(key)) throw new Error("DDS returned a duplicate card.");
                values.set(key, state.declarerTricksWon +
                    (isDeclarerSide(state.playerToMove, contract) ? value.score : tricksLeft - value.score));
            }
            const legal = getLegalCards(state);
            if (values.size !== legal.length) throw new Error("DDS did not evaluate every legal card.");
            return legal.map((card) => {
                const declarerTricks = values.get(cardKey(card));
                if (declarerTricks === undefined) throw new Error("DDS omitted a legal card.");
                return { card, declarerTricks };
            });
        },
        dispose: () => {
            disposed = true;
            stop(new Error("DDS engine is closed."));
        },
    };
};
