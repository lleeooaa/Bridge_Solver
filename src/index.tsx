import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { createWorkerAnalysisSession, solveInWorker } from "./solverClient";
import "./styles.css";

const rootElement = document.getElementById("root");
if (rootElement === null) {
    throw new Error("The application root element was not found.");
}

createRoot(rootElement).render(
    <StrictMode>
        <App onSolve={solveInWorker} createAnalysisSession={createWorkerAnalysisSession} />
    </StrictMode>,
);
