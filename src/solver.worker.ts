import type { EngineAnalysisSession, SolverInput } from "./bridge";
import { createBrowserDdsEngine } from "./dds/browser";
import { createDdsAnalysisSession, solveDdsContract } from "./dds/session";
import type { AnalysisWorkerRequest, AnalysisWorkerResponse, SolverWorkerResponse } from "./solverClient";

let session: { id: number; engine: EngineAnalysisSession } | undefined;
let active: { requestId: number; controller: AbortController } | undefined;
const errorMessage = (error: unknown): string =>
    error instanceof Error && error.message.length > 0
        ? error.message
        : "The solver returned an unknown error.";
const postAnalysis = (response: AnalysisWorkerResponse): void => self.postMessage(response);

const handleAnalysisRequest = (request: AnalysisWorkerRequest): void => {
    if (request.type === "initialize") {
        active?.controller.abort();
        session?.engine.dispose();
        session = undefined;
        active = undefined;

        try {
            session = {
                id: request.sessionId,
                engine: createDdsAnalysisSession(request.input, createBrowserDdsEngine(request.runtimeUrl)),
            };
        } catch (error: unknown) {
            postAnalysis({
                type: "session-error",
                sessionId: request.sessionId,
                message: errorMessage(error),
            });
        }
        return;
    }

    if (session?.id !== request.sessionId) {
        postAnalysis({
            type: "session-error",
            sessionId: request.sessionId,
            message: "Analysis session is not initialized.",
        });
        return;
    }

    if (request.type === "cancel") {
        if (active?.requestId === request.requestId) {
            active.controller.abort();
        }
        return;
    }

    active?.controller.abort();
    const controller = new AbortController();
    active = { requestId: request.requestId, controller };
    void session.engine.analyze(request.history, controller.signal).then(
        (result) => {
            if (!controller.signal.aborted) {
                postAnalysis({
                    type: "analysis",
                    sessionId: request.sessionId,
                    requestId: request.requestId,
                    result,
                });
            }
        },
        (error: unknown) => postAnalysis({
            type: "analysis-error",
            sessionId: request.sessionId,
            requestId: request.requestId,
            message: errorMessage(error),
            cancelled: controller.signal.aborted,
        }),
    ).finally(() => {
        if (active?.controller === controller) {
            active = undefined;
        }
    });
};

/** Runs one solver request and returns either the result or a readable error. */
const handleSolverMessage = (event: MessageEvent<
    { type: "solve"; input: SolverInput; runtimeUrl: string } | AnalysisWorkerRequest
>): void => {
    if (event.data.type !== "solve") {
        handleAnalysisRequest(event.data);
        return;
    }
    const request = event.data;
    void solveDdsContract(
        request.input, createBrowserDdsEngine(request.runtimeUrl), new AbortController().signal,
    ).then((result) => {
        const response: SolverWorkerResponse = { type: "result", result };
        self.postMessage(response);
    }, (error: unknown) => {
        const message = errorMessage(error);
        const response: SolverWorkerResponse = { type: "error", message };
        self.postMessage(response);
    });
};

self.addEventListener("message", handleSolverMessage);
