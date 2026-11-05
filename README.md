Bridge Solver (WIP)

## Run locally

Requires Node.js 22 and pnpm 10.

```powershell
pnpm install --frozen-lockfile
pnpm dev
```

Open `http://localhost:3002/`. The learned model defaults to the bundled `models/belief/manifest.json`. The model is a research pilot; its advice is not a guaranteed playable strategy.

To check or build the project:

```powershell
pnpm typecheck
pnpm test
pnpm build
pnpm preview
```

## Publish to GitHub Pages

Push this project to the `main` branch of a GitHub repository, then set **Settings → Pages → Build and deployment → Source** to **GitHub Actions**. The workflow at `.github/workflows/deploy.yml` builds and deploys the site.

Serve the site over HTTPS. DDS uses WebAssembly threads, so `public/coi-serviceworker.js` enables cross-origin isolation on GitHub Pages; the page may reload on the first visit. Browser support and memory limits still apply, especially on mobile.
