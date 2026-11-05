import { useEffect, useMemo, useRef, useState } from "react";
import {
    DIRECTIONS, RANKS, SUITS,
    type EngineAnalysisSession, type AnalysisSessionFactory, type Card, type Direction, type PlayedCard,
    type EnginePositionAnalysis, type SolverInput, type Suit,
} from "./bridge";
import {
    buildPlayState,
    getLegalCards,
    getTrickWinner,
    getTricksLostByMove,
    isDeclarerSide,
} from "./play";
import { formatAnalysisStatistics } from "./solverText";

export type PlayMode = "guided" | "challenge";

interface PlayBoardProps {
    input: SolverInput;
    createSession: AnalysisSessionFactory;
    mode: PlayMode;
    active?: boolean;
}

interface ChallengeMoveGrade {
    player: Direction;
    card: Card;
    tricksLost: number;
}

interface PendingChallengeMove extends Omit<ChallengeMoveGrade, "tricksLost"> {
    history: readonly PlayedCard[];
    previousOptimalTricks: number;
}

interface AnalysisView {
    history: readonly PlayedCard[];
    result?: EnginePositionAnalysis;
    certifiedTotal?: number;
    error?: string;
    feedback?: ChallengeMoveGrade;
}

const SYMBOLS: Record<Suit, string> = {
    spades: "\u2660", hearts: "\u2665", diamonds: "\u2666", clubs: "\u2663",
};
const cardKey = (card: Card): string => `${card.suit}-${card.rank}`;
const rankLabel = (card: Card): string => card.rank === "T" ? "10" : card.rank;
const messageFor = (error: unknown): string =>
    error instanceof Error ? error.message : "The position analysis failed.";

const PlayBoard = ({ input, createSession, mode, active = true }: PlayBoardProps) => {
    const [history, setHistory] = useState<readonly PlayedCard[]>([]);
    const [session, setSession] = useState<EngineAnalysisSession | null>(null);
    const [sessionError, setSessionError] = useState<string | null>(null);
    const [view, setView] = useState<AnalysisView | null>(null);
    const [gradedMoves, setGradedMoves] = useState<readonly ChallengeMoveGrade[]>([]);
    const [originalValue, setOriginalValue] = useState<number | null>(null);
    const originalValueRef = useRef<number | null>(null);
    const [retry, setRetry] = useState(0);
    const [paused, setPaused] = useState(false);
    const activeRequest = useRef<AbortController | null>(null);
    const pendingChallengeMove = useRef<PendingChallengeMove | null>(null);
    const board = useMemo(() => buildPlayState(input, history), [input, history]);
    const legal = useMemo(() => new Set(getLegalCards(board).map(cardKey)), [board]);

    const currentView = view?.history === history ? view : null;
    const result = currentView?.result;
    const feedback = currentView?.feedback;
    const optimalTotal = result?.optimalDeclarerTricks ?? currentView?.certifiedTotal;
    const error = sessionError ?? currentView?.error;
    const pending = result === undefined && error === undefined && !paused;
    const isChallenge = mode === "challenge";
    const recommended = new Set(
        isChallenge ? [] : result?.recommendedCards.map(cardKey) ?? [],
    );
    const challengeMoveBlocked =
        isChallenge &&
        (result === undefined || pending || paused || error !== undefined);

    const requiredTricks = input.contract.level + 6;
    const shownTrick = board.currentTrick.length > 0 ? board.currentTrick : board.lastTrick;
    const delta = optimalTotal === undefined || originalValue === null
        ? null
        : optimalTotal - originalValue;

    const optimalTotalLabel = optimalTotal === undefined
        ? paused
            ? "Analysis paused"
            : error !== undefined
                ? "Unavailable"
                : "Calculating..."
        : `${optimalTotal} / ${board.totalTricks}`;
    const analysisSource = result?.statistics.fromCache
        ? "Restored saved analysis"
        : result?.statistics.inheritedValue
            ? "Optimal value preserved; next recommendation certified"
            : "Position analyzed";
    const optimalCardMessage =
        "Evaluating legal cards with library DDS. Legal yellow cards are playable now.";
    const analysisProgress = optimalTotal === undefined
        ? optimalCardMessage
        : `Optimal total preserved. ${optimalCardMessage}`;
    const analysisDetails = result === undefined
        ? ""
        : `${formatAnalysisStatistics(result)}.`;
    const analysisStatus = result !== undefined
        ? `${analysisSource} in ${analysisDetails}`
        : pending
            ? analysisProgress
            : "";
    const optimalMoves = gradedMoves.filter((move) => move.tricksLost === 0).length;
    const challengeFeedbackMessage = feedback !== undefined
        ? feedback.tricksLost === 0
            ? `${feedback.player}'s ${rankLabel(feedback.card)}${SYMBOLS[feedback.card.suit]} was optimal.`
            : isDeclarerSide(feedback.player, input.contract)
                ? `Suboptimal declarer play: ${feedback.player}'s card cost ${feedback.tricksLost} trick${
                    feedback.tricksLost === 1 ? "" : "s"
                }.`
                : `Suboptimal defense: ${feedback.player}'s card allowed declarer ${
                    feedback.tricksLost
                } extra trick${feedback.tricksLost === 1 ? "" : "s"}.`
        : paused
            ? "Analysis paused. Resume to continue the challenge."
            : error !== undefined
                ? "Analysis failed. Resume analysis before continuing."
                : pending
                    ? history.length === 0
                        ? "Preparing the challenge position..."
                        : "Checking your last card. Wait for its result before continuing."
                    : history.length === 0
                        ? "Challenge ready. Choose any legal card; best-card and exact-total hints are hidden."
                        : "Position checked. Choose the next legal card.";

    useEffect(() => {
        if (!active) {
            setSession(null);
            return;
        }
        let created: EngineAnalysisSession;
        try {
            created = createSession(input);
            setSession(created);
        } catch (error: unknown) {
            setSessionError(messageFor(error));
            return;
        }
        return () => created.dispose();
    }, [input, createSession, active]);

    useEffect(() => {
        if (session === null || paused || !active) {
            return;
        }
        const controller = new AbortController();
        activeRequest.current = controller;
        setView((current) => ({
            history, certifiedTotal: current?.history === history ? current.certifiedTotal : undefined,
        }));
        const analyze = async (): Promise<void> => {
            try {
                const result = await session.analyze(history, controller.signal);
                if (controller.signal.aborted) {
                    return;
                }

                const pendingMove = pendingChallengeMove.current;
                if (mode === "challenge" && pendingMove?.history === history) {
                    const moveGrade: ChallengeMoveGrade = {
                        player: pendingMove.player,
                        card: pendingMove.card,
                        tricksLost: getTricksLostByMove(
                            pendingMove.previousOptimalTricks,
                            result.optimalDeclarerTricks,
                            pendingMove.player,
                            input.contract,
                        ),
                    };
                    pendingChallengeMove.current = null;
                    setGradedMoves((current) => [
                        ...current.slice(0, history.length - 1),
                        moveGrade,
                    ]);
                    setView({ history, result, feedback: moveGrade });
                }
                else {
                    setView({ history, result });
                }

                if (originalValueRef.current === null) {
                    // A user can leave the opening position before its first analysis finishes.
                    const root = history.length === 0 ? result : await session.analyze([], controller.signal);
                    if (!controller.signal.aborted) {
                        originalValueRef.current = root.optimalDeclarerTricks;
                        setOriginalValue(root.optimalDeclarerTricks);
                    }
                }
            } catch (error: unknown) {
                if (!controller.signal.aborted) {
                    setView({ history, error: messageFor(error) });
                }
            }
        };
        void analyze();
        return () => {
            controller.abort();
            if (activeRequest.current === controller) {
                activeRequest.current = null;
            }
        };
    }, [session, history, retry, paused, mode, input.contract, active]);

    const play = (card: Card): void => {
        if (!legal.has(cardKey(card))) {
            throw new Error("Only a legal card can be played.");
        }
        if (isChallenge && (result === undefined || challengeMoveBlocked)) {
            throw new Error("Wait for the challenge analysis before choosing a card.");
        }

        setPaused(false);
        const player = board.playerToMove;
        const nextHistory = [...history, { player, card }];
        if (isChallenge && result !== undefined) {
            pendingChallengeMove.current = {
                history: nextHistory,
                player,
                card,
                previousOptimalTricks: result.optimalDeclarerTricks,
            };
        }
        else if (recommended.has(cardKey(card)) && result !== undefined) {
            setView({ history: nextHistory, certifiedTotal: result.optimalDeclarerTricks });
        }
        setHistory(nextHistory);
    };

    const undoOneCard = (): void => {
        pendingChallengeMove.current = null;
        if (isChallenge) {
            setGradedMoves((current) =>
                current.slice(0, Math.max(0, history.length - 1)),
            );
        }
        setPaused(false);
        setHistory((current) => current.slice(0, -1));
    };

    const restartPlay = (): void => {
        pendingChallengeMove.current = null;
        setGradedMoves([]);
        setPaused(false);
        setHistory([]);
    };

    const pause = (): void => {
        activeRequest.current?.abort();
        setPaused(true);
    };

    return (
        <section className="panel play-board-panel" aria-labelledby="play-heading">
            <div className="play-heading">
                <div>
                    <p className="panel-kicker">DOUBLE-DUMMY PLAYGROUND</p>
                    <h2 id="play-heading">
                        {isChallenge ? "Challenge play" : "Explore the play"}
                    </h2>
                    <p>
                        Contract: {input.contract.level}
                        {input.contract.strain === "no-trump" ? "NT" : SYMBOLS[input.contract.strain]}
                        {" by "}
                        {input.contract.declarer}
                        {input.contract.doubling !== "undoubled" ? ` (${input.contract.doubling})` : ""}.
                        {" "}
                        {isChallenge
                            ? "You choose cards for all four seats; each choice is graded against double-dummy best play."
                            : "Both partnerships play to maximize their own result."}
                    </p>
                </div>
                <div className="play-controls">
                    <button
                        type="button"
                        onClick={undoOneCard}
                        disabled={history.length === 0}
                    >
                        Undo one card
                    </button>
                    <button
                        type="button"
                        onClick={restartPlay}
                        disabled={history.length === 0}
                    >
                        Restart play
                    </button>
                    {pending && <button type="button" onClick={pause}>Pause analysis</button>}
                    {(paused || error !== undefined) && session !== null && (
                        <button
                            type="button"
                            onClick={() => {
                                setPaused(false);
                                setRetry((current) => current + 1);
                            }}
                        >
                            Resume analysis
                        </button>
                    )}
                </div>
            </div>

            {isChallenge ? (
                <div className="challenge-summary">
                    <div className="challenge-progress">
                        <div>
                            <span>Declarer tricks won</span>
                            <strong>{board.declarerTricksWon}</strong>
                        </div>
                        <div>
                            <span>Contract needs</span>
                            <strong>{requiredTricks}</strong>
                        </div>
                        <div>
                            <span>Optimal choices</span>
                            <strong>{optimalMoves} / {gradedMoves.length}</strong>
                        </div>
                    </div>
                    <p
                        className={`challenge-feedback ${
                            feedback === undefined
                                ? ""
                                : feedback.tricksLost === 0
                                    ? "is-optimal"
                                    : "is-suboptimal"
                        }`}
                        role="status"
                        aria-live="polite"
                    >
                        {challengeFeedbackMessage}
                    </p>
                    {board.isComplete && result !== undefined && (
                        <p className="challenge-result">
                            Challenge complete. Declarer took {result.optimalDeclarerTricks} of{" "}
                            {board.totalTricks} tricks; the contract is{" "}
                            {result.canMakeContract ? "made" : "set"}.
                        </p>
                    )}
                </div>
            ) : (
                <div className="play-totals" role="status" aria-live="polite">
                    <div className="play-optimum">
                        <span>Declarer can force</span>
                        <strong data-testid="optimal-total">
                            {optimalTotalLabel}
                        </strong>
                        <span>against optimal defense, including tricks already won</span>
                    </div>
                    <dl>
                        <div>
                            <dt>Already won</dt>
                            <dd>{board.declarerTricksWon}</dd>
                        </div>
                        <div>
                            <dt>Best additional</dt>
                            <dd>
                                {optimalTotal === undefined
                                    ? "..."
                                    : optimalTotal - board.declarerTricksWon}
                            </dd>
                        </div>
                        <div>
                            <dt>Contract needs</dt>
                            <dd>{requiredTricks}</dd>
                        </div>
                        <div>
                            <dt>Outlook</dt>
                            <dd>
                                {optimalTotal === undefined
                                    ? "..."
                                    : optimalTotal >= requiredTricks
                                        ? "Makes"
                                        : "Set"}
                            </dd>
                        </div>
                        <div>
                            <dt>Original optimum</dt>
                            <dd>{originalValue ?? "Calculating..."}</dd>
                        </div>
                        <div>
                            <dt>Change</dt>
                            <dd>{delta === null ? "..." : delta > 0 ? `+${delta}` : delta}</dd>
                        </div>
                    </dl>
                </div>
            )}
            <p className="play-legend">
                {isChallenge ? (
                    <>
                        <span className="legend-legal">Yellow: legal</span>
                        <span>Best cards and exact trick totals are hidden until after each choice.</span>
                    </>
                ) : (
                    <>
                        <span className="legend-legal">Yellow: legal</span>
                        <span className="legend-optimal">Orange + Best: certified optimal</span>
                        <span>Best marks certified optimal choices. Unhighlighted cards cannot be played.</span>
                    </>
                )}
            </p>
            {error !== undefined && (
                <p className="submit-status error" role="alert">
                    Analysis error: {error}
                </p>
            )}
            {paused && (
                <p role="status">
                    {isChallenge
                        ? "Analysis paused. Resume before continuing the challenge; undo and restart remain available."
                        : "Analysis paused. You can still play or undo, or resume analysis."}
                </p>
            )}

            <div className="play-table">
                {DIRECTIONS.map((seat) => (
                    <section
                        key={seat}
                        className={`play-hand play-${seat.toLowerCase()} ${
                            !board.isComplete && seat === board.playerToMove ? "is-active" : ""
                        }`}
                        aria-label={`${seat} remaining hand`}
                    >
                        <h3>
                            {seat}
                            <span>
                                {seat === input.contract.declarer ? "Declarer" : ""}
                                {!board.isComplete && seat === board.playerToMove
                                    ? " \u00b7 To play"
                                    : ""}
                            </span>
                        </h3>
                        {SUITS.map((suit) => (
                            <div className="play-suit" key={suit}>
                                <span
                                    className={`play-suit-symbol ${
                                        suit === "hearts" || suit === "diamonds" ? "red" : ""
                                    }`}
                                    aria-label={suit}
                                >
                                    {SYMBOLS[suit]}
                                </span>
                                <div className="play-cards">
                                    {board.hands[seat][suit].length === 0 && (
                                        <span className="play-void">-</span>
                                    )}
                                    {[...RANKS]
                                        .reverse()
                                        .filter((rank) => board.hands[seat][suit].includes(rank))
                                        .map((rank) => {
                                            const card = { suit, rank };
                                            const isLegal =
                                                seat === board.playerToMove && legal.has(cardKey(card));
                                            const isOptimal =
                                                !isChallenge && isLegal && recommended.has(cardKey(card));
                                            const unavailableForAnalysis =
                                                isChallenge && challengeMoveBlocked;

                                            return (
                                                <button
                                                    type="button"
                                                    key={rank}
                                                    className={`play-card ${
                                                        isLegal ? "is-legal" : ""
                                                    } ${isOptimal ? "is-optimal" : ""}`}
                                                    disabled={!isLegal || unavailableForAnalysis}
                                                    onClick={() => play(card)}
                                                    aria-label={`${seat} ${rankLabel(card)} of ${suit}${
                                                        isOptimal
                                                            ? ", recommended optimal"
                                                            : isLegal && unavailableForAnalysis
                                                                ? ", legal, waiting for analysis"
                                                            : isLegal
                                                                ? ", legal"
                                                                : ", not playable"
                                                    }`}
                                                >
                                                    <strong
                                                        className={
                                                            suit === "hearts" || suit === "diamonds"
                                                                ? "red"
                                                                : ""
                                                        }
                                                    >
                                                        {rankLabel(card)}
                                                    </strong>
                                                    {isOptimal && <small>Best</small>}
                                                </button>
                                            );
                                        })}
                                </div>
                            </div>
                        ))}
                    </section>
                ))}
                <div className="play-current-trick">
                    <p className="panel-kicker">
                        {board.currentTrick.length > 0
                            ? "CURRENT TRICK"
                            : board.lastTrick.length > 0
                                ? "LAST TRICK"
                                : "OPENING LEAD"}
                    </p>
                    <div className="play-trick-cards">
                        {shownTrick.map((play) => (
                            <div className="play-trick-card" key={cardKey(play.card)}>
                                <span>{play.player}</span>
                                <strong
                                    className={
                                        play.card.suit === "hearts" || play.card.suit === "diamonds"
                                            ? "red"
                                            : ""
                                    }
                                >
                                    {rankLabel(play.card)}
                                    {SYMBOLS[play.card.suit]}
                                </strong>
                            </div>
                        ))}
                    </div>
                    {board.currentTrick.length === 0 && board.lastTrick.length === 4 && (
                        <p>
                            {getTrickWinner(board.lastTrick, input.contract)} won the trick.
                        </p>
                    )}
                    <p role="status">
                        {board.isComplete
                            ? "All cards played."
                            : `${board.playerToMove} to play${
                                board.currentTrick.length === 0 ? " (leads)" : ""
                            }.`}
                    </p>
                    <p>Card {history.length} / {board.totalTricks * 4}</p>
                    <p>Declarer {board.declarerTricksWon} : {board.defenderTricksWon} Defenders</p>
                </div>
            </div>
            <p className="play-analysis-status" aria-live="polite">
                {analysisStatus}
            </p>
        </section>
    );
};

export default PlayBoard;
