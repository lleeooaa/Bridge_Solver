Bridge Solver (WIP)

## Run locally

Requires Node.js 22 and pnpm 10.

```powershell
pnpm install --frozen-lockfile
pnpm dev
```

Open `http://localhost:3002/`. The learned model defaults to the bundled `models/belief/manifest.json`. The model is a research pilot; its advice is not a guaranteed playable strategy.

## Single-dummy DDS comparison

Pick a bundled example or load a complete validation deal to enable the automatic DDS comparison toggle. When on, DDS refreshes its suggestion at each declarer/dummy decision. DDS uses all four hands, including both defenders' cards; the model still sees only declarer, dummy, and public play. DDS-optimal cards are highlighted separately as a perfect-information benchmark, not as single-dummy advice.

For a validation deal, **Start interactive hybrid play** lets you choose declarer/dummy cards while full-information DDS plays the defenders. **Undo last declarer/dummy decision** removes that choice and the DDS defensive cards that followed. **Restart play** returns to the deal's recorded opening lead. Stop hybrid play to return to manual defender-card entry.

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
