import {
    DIRECTIONS, RANKS, SUITS,
    type DdsStatistics, type EngineAnalysisSession, type EnginePositionAnalysis,
    type EngineSolverResult, type PlayedCard, type SolverInput,
} from "../bridge";
import { buildPlayState, isDeclarerSide } from "../play";
import { analysisAborted, type DdsEngine } from "./engine";

const validate = (input: SolverInput): void => {
    const { contract } = input;
    if (!Number.isInteger(contract.level) || contract.level < 1 || contract.level > 7 ||
        !DIRECTIONS.includes(contract.declarer) ||
        (contract.strain !== "no-trump" && !SUITS.includes(contract.strain)) ||
        !["undoubled", "doubled", "redoubled"].includes(contract.doubling)) {
        throw new Error("Invalid bridge contract.");
    }
    const seen = new Set<string>();
    let count: number | undefined;
    for (const seat of DIRECTIONS) {
        let cards = 0;
        for (const suit of SUITS) {
            for (const rank of input.hands[seat][suit]) {
                if (!RANKS.includes(rank)) throw new Error(`Invalid rank "${String(rank)}".`);
                const key = `${suit}:${rank}`;
                if (seen.has(key)) throw new Error(`The card ${key} appears more than once.`);
                seen.add(key);
                cards += 1;
            }
        }
        if (cards > 13 || (count !== undefined && cards !== count)) {
            throw new Error("Each hand must contain the same number of cards, at most thirteen.");
        }
        count = cards;
    }
};

const statistics = (started: number, calls: number, size: number, fromCache = false): DdsStatistics => ({
    engine: "dds", elapsedMilliseconds: performance.now() - started,
    positionsEvaluated: calls, cacheEntries: size, fromCache, inheritedValue: false,
});

export const createDdsAnalysisSession = (input: SolverInput, engine: DdsEngine): EngineAnalysisSession => {
    validate(input);
    const original: SolverInput = { hands: buildPlayState(input).hands, contract: { ...input.contract } };
    const results = new Map<string, EnginePositionAnalysis>();
    let disposed = false;
    let queue = Promise.resolve();
    const check = (signal: AbortSignal): void => {
        if (disposed) throw new Error("Analysis session is closed.");
        if (signal.aborted) throw analysisAborted();
    };
    const analyze = async (history: readonly PlayedCard[], signal: AbortSignal): Promise<EnginePositionAnalysis> => {
        const started = performance.now();
        check(signal);
        const board = buildPlayState(original, history);
        const key = JSON.stringify(history);
        const cached = results.get(key);
        if (cached !== undefined) {
            return { ...cached, statistics: statistics(started, 0, results.size, true) };
        }
        const values = await engine.evaluate(board, original.contract, signal);
        check(signal);
        const totals = values.map((value) => value.declarerTricks);
        const optimum = board.isComplete ? board.declarerTricksWon
            : isDeclarerSide(board.playerToMove, original.contract) ? Math.max(...totals) : Math.min(...totals);
        const result: EnginePositionAnalysis = {
            optimalDeclarerTricks: optimum,
            canMakeContract: optimum >= original.contract.level + 6,
            recommendedCards: values.filter((value) => value.declarerTricks === optimum).map((value) => value.card),
            statistics: statistics(started, Number(!board.isComplete), Math.min(256, results.size + 1)),
        };
        if (results.size >= 256) {
            const oldest = results.keys().next().value;
            if (oldest !== undefined) results.delete(oldest);
        }
        results.set(key, result);
        return result;
    };
    return {
        analyze: (history, signal) => {
            const snapshot = history.map((play) => ({ player: play.player, card: { ...play.card } }));
            const pending = queue.then(() => analyze(snapshot, signal));
            queue = pending.then(() => undefined, () => undefined);
            return pending;
        },
        dispose: () => { disposed = true; engine.dispose(); },
    };
};

export const solveDdsContract = async (
    input: SolverInput, engine: DdsEngine, signal: AbortSignal,
): Promise<EngineSolverResult> => {
    const started = performance.now();
    const session = createDdsAnalysisSession(input, engine);
    const line: PlayedCard[] = [];
    let calls = 0;
    try {
        let analysis = await session.analyze(line, signal);
        const optimum = analysis.optimalDeclarerTricks;
        let board = buildPlayState(input);
        while (!board.isComplete) {
            if ("engine" in analysis.statistics) calls += analysis.statistics.positionsEvaluated;
            const card = analysis.recommendedCards[0];
            if (card === undefined) throw new Error("DDS did not provide an optimal continuation.");
            line.push({ player: board.playerToMove, card });
            board = buildPlayState(input, line);
            analysis = await session.analyze(line, signal);
            if (analysis.optimalDeclarerTricks !== optimum) throw new Error("DDS replay changed the exact position value.");
        }
        return {
            optimalDeclarerTricks: optimum, canMakeContract: optimum >= input.contract.level + 6,
            requiredTricks: input.contract.level + 6, line, declarerTricksInLine: board.declarerTricksWon,
            statistics: statistics(started, calls, 0),
        };
    } finally {
        session.dispose();
    }
};
