# Bridge Solver — GitHub Pages

A browser-based bridge deal builder, double-dummy solver and single-dummy advisor. The app and model inference run in the browser; this project is configured for deployment to GitHub Pages.

## Included

- The web application and its DDS WebAssembly runtime.
- Browser ONNX inference code and the `human-pilot-colab` model in `public/models/belief/`.
- The GitHub Pages deployment workflow and web-app tests.

Training datasets and the Python training pipeline are intentionally not included. The small test fixtures are synthetic and are used only by the automated tests.

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

## Model and data

The ONNX model and its manifest are public static assets and can be downloaded by any visitor to the site. The app checks asset hashes and sizes before inference. Model inference runs locally in the browser; observations are not uploaded to a model server.

No training or validation datasets are bundled. The optional validation-deal picker only works if a user selects their own local prepared dataset folder.
