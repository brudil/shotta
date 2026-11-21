`shotta`: a CLI and library that runs scripted flows through a web app with Playwright
and writes checkpoint screenshots and journey videos. README.md is the user-facing
reference; keep it in step with any change to the flow steps, config keys, flags or
the run report.

- `pnpm test` — unit tests (`src/**/*.test.ts`), no browser.
- `pnpm test:e2e` — builds, then runs the built CLI against `test/fixture` in a real
  browser. Needs `pnpm exec playwright install chromium-headless-shell`.
- `pnpm typecheck`, `pnpm lint` (Biome; `pnpm format` to fix).
- The dev dependency on `playwright` is pinned exactly: each Playwright release wants
  its own browser build, so bumping it means running `playwright install` again.
  Consumers bring their own (`peerDependencies`).

Layout:

- `src/flow.ts`, `src/config.ts` — the two public vocabularies (steps, config keys) and
  the pure logic over them. `resolveConfig` takes Playwright's device list as an
  argument so it is testable without a browser.
- `src/run.ts` → `src/run-flow.ts` — the run (`run`, `snap`, `exportShots`, `listFlows`), then one
  flow at one profile. `checkSteps` in `flow.ts` validates every flow before it runs;
  a new step or step key has to be taught to it as well as to `perform`.
- `src/settle.ts` — when a page counts as still. `src/steps.ts` — performing a step,
  with pointer travel. `src/overlays.ts` — cursor, tap ring and caption drawn into the
  page. `src/recorder.ts` — the video: frames taken from the page and piped to ffmpeg,
  so recording starts when the app is ready and pauses while a shot is captured.
- `src/targets.ts` — addresses (`flow/shot@profile`) and turning them into the passes
  to run. Pure, and the one place that decides what a target means.
- `src/server.ts`, `src/keeper.ts` — the app's lifecycle. `keeper.js` is a separate
  detached process that owns a kept-alive app and stops it once it has sat idle; a
  change there needs the two server tests in `test/e2e.test.ts` to still pass, and no
  `server.mjs` process left behind after the suite.
- `src/storyboard.ts` — the per-step contact sheet, laid out by the browser itself.
- `src/tiles.ts` — cutting tall shots into pieces for `--agent`.
- `src/report.ts` — the shape of `run.json`. It is an interface other tools and agents
  read: add fields, do not rename or repurpose them.

Things that are easy to get wrong:

- `installOverlays` and every callback passed to `page.evaluate` are serialised into
  the browser. They can use nothing from module scope, only their arguments.
- Flows and configs in a consuming project are loaded by Node's type stripping, which
  does not apply inside `node_modules`. So this package ships compiled JS, and what a
  project imports from it must work from `dist/`.
- The fixture imports the package by name (`from 'shotta'`), which resolves to `dist/`.
  Build before running the CLI against it by hand.
- Anything that changes the page only to take a screenshot (hiding the overlays,
  growing the viewport so a scrolling panel shows all it holds) must happen inside
  `recorder.pause()` … `resume()`, and be undone before it, or it shows up in the
  video as a blink.
- A request's end is not always reported: one made as a document unloads gets neither
  a `requestfinished` nor a `requestfailed`. `trackNetwork` in `src/settle.ts` drops a
  replaced document's requests for that reason, and must still tell a new document
  from a `pushState`, whose requests are the app's own data.
- Nothing here may assume a single-page app: a click can be a full navigation, which
  tears down the document mid-step (see `acrossNavigation` in `src/settle.ts`).
- Timing constants in `settle.ts`, `steps.ts` and `recorder.ts` were tuned against real
  recordings. Change one only with a before-and-after video to show for it.
