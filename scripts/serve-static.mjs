import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve, sep, extname } from "node:path";

const root = resolve("dist");
const prefix = "/bridge/";
const types = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".wasm": "application/wasm", ".json": "application/json" };
const server = createServer(async (request, response) => {
    if (request.method !== "GET" && request.method !== "HEAD") {
        response.writeHead(405).end();
        return;
    }
    let pathname;
    try {
        pathname = decodeURIComponent(new URL(request.url, "http://localhost").pathname);
    } catch {
        response.writeHead(400).end("Invalid URL.");
        return;
    }
    if (!pathname.startsWith(prefix)) {
        response.writeHead(404).end();
        return;
    }
    const testPrefix = `${prefix}models/test-only/`;
    const selectedRoot = pathname.startsWith(testPrefix) ? resolve("e2e", "fixtures", "belief") : root;
    const target = resolve(selectedRoot, pathname.slice(pathname.startsWith(testPrefix) ? testPrefix.length : prefix.length) || "index.html");
    if (!target.startsWith(selectedRoot + sep)) {
        response.writeHead(403).end();
        return;
    }
    try {
        const contents = await readFile(target);
        // Deliberately no COOP/COEP: browser tests exercise the Pages service worker.
        response.writeHead(200, { "Content-Type": types[extname(target)] ?? "text/plain", "Cache-Control": "no-cache" });
        response.end(request.method === "HEAD" ? undefined : contents);
    } catch (error) {
        if (error.code === "ENOENT" || error.code === "EISDIR") response.writeHead(404).end();
        else {
            console.error(error);
            response.writeHead(500).end("Static server error.");
        }
    }
});
const port = Number(process.env.PORT ?? 4138);
if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error(`Invalid static server port: ${port}.`);
server.listen(port, "127.0.0.1", () => console.log(`Static Pages test server: http://127.0.0.1:${port}/bridge/`));
