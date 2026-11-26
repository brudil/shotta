# shotta

Scripted screenshots and journey videos of a web app, driven by Playwright.

A flow is a short script: go here, click that, checkpoint a screenshot. `shotta` runs
flows at the viewport profiles you configure and writes, per flow and profile, the
checkpoint PNGs, a `journey.webm` of the whole thing, and a storyboard: the journey
as one captioned contact sheet. Use it to put real screens in pull requests and
design reviews, and to let a coding agent look at what it just built without driving
a browser.

It is not a visual-regression gate: nothing is compared against a baseline.

## Setup

```sh
pnpm add -D shotta playwright
pnpm exec playwright install chromium-headless-shell
```

Node 22.18 or later, Playwright 1.59 or later. Flows and the config are TypeScript files that Node loads
directly, so they must use erasable syntax only (no enums, no parameter properties).

Videos are written by the ffmpeg that the project's Playwright installs beside its
browsers (`playwright install ffmpeg` if it is missing), as VP9 WebM, or VP8 where
that ffmpeg has only VP8.

`shotta.config.ts`, in the project root or in `.config/`:

```ts
import { defineConfig } from 'shotta';

export default defineConfig({
  server: { command: 'pnpm exec vite --port {port}' },
  profiles: {
    desktop: { viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 2 },
    phone: { device: 'iPhone 15' },
  },
});
```

`src/checkout/checkout.shots.ts`, beside the code it shows:

```ts
import { defineFlow } from 'shotta';

export default defineFlow({
  shows: 'Paying for a cart with a saved card',
  steps: [
    { goto: '/cart' },
    { shot: 'cart', shows: 'Two items and their total' },
    {
      annotate: 'Pay with a saved card',
      steps: [
        { click: 'role=button[name="Checkout"]' },
        { type: '123', into: '[data-testid=cvc]' },
        { shot: 'ready-to-pay', shows: 'The pay button is enabled' },
      ],
    },
  ],
});
```

```sh
pnpm shotta                              # every flow, every profile
pnpm shotta checkout                     # one flow
pnpm shotta checkout/cart@phone          # one shot at one profile: the flow stops there
```

## What is where

|                                                         | Committed?                                                         |
| ------------------------------------------------------- | ------------------------------------------------------------------ |
| Flows (`*.shots.ts`), `shotta.config.ts`, project steps | Yes. They are the source.                                          |
| `.shotta/` — everything a run writes                    | No. It is all regenerable; add it to `.gitignore`.                 |
| An export's `dir`                                       | Your call. Commit it when the images are part of what you publish. |

```
.shotta/
  export/                 scratch for `shotta export`
  review/                 what a person opens: full-size shots, videos, storyboards
    checkout/
      desktop/
        01-cart.png
        pay-with-a-saved-card/02-ready-to-pay.png
        journey.webm
        storyboard.png
      phone/…
    runs/<time>.json      one report per run, the newest 20
  agent/                  the same, sized for a model (--agent); never overwrites review/
  server.json, server.log the app shotta is keeping up, if any
```

## Addresses

One way of naming things, used for what to run, in the catalog and in reports:

|                               |                                            |
| ----------------------------- | ------------------------------------------ |
| `checkout`                    | a flow, at every profile a run uses        |
| `checkout/ready-to-pay`       | one shot: the flow runs only as far as it  |
| `checkout@phone`              | a flow at one profile (any configured one) |
| `checkout/ready-to-pay@phone` | one shot at one profile                    |

A flow part that is not a flow's whole name selects every flow whose name contains it.
Targets that name the same flow and profile share one pass, which runs to the furthest
shot any of them asks for.

## Flows

A flow file is named `<name>.shots.ts` (kebab-case) and default-exports
`defineFlow(...)`. The name is the file stem, unique across the project. Every step
but `run` is plain data, so the same steps can be written as JSON and run without a
file (see `shotta snap`).

| Step                                       | Does                                                                                                                                                                                                                   |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `{ goto: '/path' }`                        | Navigate. Relative paths resolve against the app.                                                                                                                                                                      |
| `{ click: selector }`                      | Move the pointer to the element and click it. Taps on touch profiles.                                                                                                                                                  |
| `{ hover: selector }`                      | Move the pointer over the element. Skipped on touch profiles.                                                                                                                                                          |
| `{ type: 'text', into: selector }`         | Clear the field and type, one key at a time. `delay` sets ms per key. Without `into`, the keys go to whatever has the focus.                                                                                           |
| `{ scroll: selector }` / `{ scroll: 400 }` | Scroll the element into view, or by that many pixels.                                                                                                                                                                  |
| `{ press: 'Escape' }`                      | Press a key.                                                                                                                                                                                                           |
| `{ wait: selector }`                       | Wait for the element to appear.                                                                                                                                                                                        |
| `{ shot: 'name', shows: '…' }`             | Checkpoint a screenshot of the full page, named for the state it shows. `of: selector` shoots one element instead, with `pad: 24` for that much of the page around it; `viewport: true` shoots only what is on screen. |
| `{ run: async (page) => {…}, label: '…' }` | Anything else, with the Playwright `Page`.                                                                                                                                                                             |

Selectors are Playwright selector strings: `text=Load more`,
`role=button[name="Clear"]`, `[data-testid=x]`, `css >> nth=1`.

`shows` — on the flow and on any shot — is one line saying what a reader should find
there. It is what turns "a screenshot" into a claim that can be checked: it appears in
the catalog, in the report beside the shot, and as the caption on the storyboard.
Write it for someone who has not seen the screen.

A shot's name is its address (`flow/shot`), so it is unique within its flow.

`{ annotate: 'Drill into a hazard', steps: [...] }` names a chapter. It is captioned
in the video for the length of its steps and its shots go in a subdirectory. Narrate a
journey this way rather than leaving a reviewer to guess.

After every step the runner waits for the page to settle: fonts and images loaded,
nothing `aria-busy`, no finite animation running, the network quiet, and before a
shot, the picture still. A page whose DOM has not changed and that has not scrolled
for a moment is known to be still; one with a canvas, video, iframe or SVG animation
on it, or that script is still rewriting, is watched frame by frame until successive
frames are identical. So a numeric `wait` should not be needed; if a flow needs one,
something is busy that settling cannot see.

Sockets and event streams (`WebSocket`, `EventSource`) are never waited for. Anything
else that stays in flight holds a step for twenty seconds before the flow carries on
without it; the log and the report's `unsettled` name what it was, and a request named
there belongs in `ignoreRequests`. Having outlasted one step, it is not waited for
again in that pass.

A shot of the page is of all of it, however the app scrolls. Where the document is
one screen tall and a panel inside it does the scrolling, the viewport is made as
tall as the panel's content for the screenshot and then put back, scroll positions
included, with the recording paused meanwhile. Anything the app loads only once it
comes into view is loaded by that, as it would be by scrolling. A panel with a height
of its own, or one under half the screen's height (a menu, a code block), is left as
it scrolls. `viewport: true` shoots only what is on screen.

A shot `of` one element is of all of that element too: one that a scrolling panel
shows only part of is shot whole, the same way. `pad` adds that many pixels of the
page around it, so a component is seen in its place rather than cut out at its edge;
the element is brought to the middle of what shows it first, so there is page to see
on every side. Either way the page is left scrolled as it was.

Flow options, beside `steps` and `shows`:

- `video` — a flow is recorded only when something moves in it (a click, hover, type,
  scroll, press or `run`). One that loads a route and shoots it is fully described by
  its shots. Set `true` or `false` to force the decision.
- `cursor` — a cursor is drawn and travels between targets, because headless Chromium
  draws none; it holds on a target before pressing so the click reads on video.
  `false` turns it off. Touch profiles show a ring where the tap landed instead.
- `pace` — pause between steps in ms, overriding the configured one.
- `profiles` — the profiles this flow runs at, in place of the config's `run`:
  `profiles: ['desktop', 'tablet']` for a journey through a layout a phone does not
  have. `--profiles` still narrows it, so a run asked for at `phone` alone skips the
  flow, and a target can still name any profile (`checkout@phone`).

A recording opens on the app once it has first settled, not on a blank page, and is
paused while each shot is captured, so nothing done for the screenshot shows in it.

The cursor, its travel and the pace exist for the recording. A pass that records no
video skips them and clicks directly, which is what makes `--no-video` fast.

Sizes are a project decision, so a flow cannot set its own; it can only say which of
the project's it is for. Where a journey differs between layouts, write a flow for
each and share the steps they have in common: steps are data, so they can be exported
from one file and spread into another.

### Where flows live

By default the whole project is searched (not `node_modules`, not dot-directories), so
a flow can sit beside the feature it shows — `src/checkout/checkout.shots.ts` next to
the checkout code. That is what lets someone who changed a file find what shows it:

```sh
shotta list --near src/checkout/summary.component.ts   # the flows beside it, or in the nearest directory above
shotta list --route /checkout                          # the flows that go there
```

Both options work on `shotta run` too. Set `flows` to a directory to keep them all in
one place instead.

### Steps of your own

A project can add steps, so flows — JSON ones included — can say things like
`{ login: 'admin' }` instead of repeating a `run`. Declare each step's name and value
type, and give its handler, in `shotta.config.ts`:

```ts
import { defineConfig } from 'shotta';

declare module 'shotta' {
  interface CustomSteps {
    login: 'admin' | 'viewer';
  }
}

export default defineConfig({
  steps: {
    login: async (page, role) => {
      await page.evaluate((r) => window.__auth.signInAs(r), role);
    },
  },
});
```

Flows that use the step are type-checked against the declaration, as long as the
config file is part of the same TypeScript project.

## Configuration

`shotta.config.{ts,mts,js,mjs,json}` in the project root or `.config/`, or anywhere
with `--config`. Paths in it are relative to the directory `shotta` runs in.

| Key              | Default                     |                                                                                                                                                                                                       |
| ---------------- | --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `flows`          | `.`                         | Directory searched, recursively, for flow files.                                                                                                                                                      |
| `outDir`         | `.shotta`                   | Where output is written. Each flow-and-profile directory is emptied before its pass.                                                                                                                  |
| `profiles`       | one 1440×1000 @2x `desktop` | Named viewports: a Playwright `device` preset, or a `viewport` and `deviceScaleFactor`, or a preset with overrides. `colorScheme: 'dark'` (or `'light'`) is what the page is told the system prefers. |
| `run`            | every profile               | Profiles a run uses, in order, unless a flow lists its own (`profiles`) or a target names another (`@tablet`).                                                                                        |
| `server`         | —                           | `{ command, url?, readyTimeout?, keepAlive? }` — see below.                                                                                                                                           |
| `baseUrl`        | —                           | An app that is already running; wins over `server`.                                                                                                                                                   |
| `workers`        | half the cores, at most 4   | Passes run at once when none is being recorded. Set `1` if passes share state outside the browser.                                                                                                    |
| `pace`           | `200`                       | Pause between steps while recording, in ms.                                                                                                                                                           |
| `video`          | `true`                      | Record journey videos.                                                                                                                                                                                |
| `storyboard`     | `true`                      | Write a storyboard for every flow in which something moves.                                                                                                                                           |
| `actionTimeout`  | `30000`                     | How long one step may take to find and act on its target, in ms.                                                                                                                                      |
| `localStorage`   | `{}`                        | Set before the app boots on every page, e.g. a flag that turns API mocking on.                                                                                                                        |
| `hide`           | `[]`                        | CSS selectors hidden in every shot and video, e.g. dev-only overlays.                                                                                                                                 |
| `ignoreRequests` | `[]`                        | Requests that never go quiet (pollers, telemetry), as URL substrings or regular expressions. Sockets, event streams, and dev-server module and hot-update requests are always ignored.                |
| `failWhen`       | `[]`                        | `{ selector, message? }` conditions checked after every step — e.g. the app's error boundary.                                                                                                         |
| `steps`          | `{}`                        | Steps of the project's own, as name → `(page, value) => Promise<void>`. Needs a `.ts` or `.js` config.                                                                                                |
| `setup`          | —                           | `(page, { baseUrl, profile }) => Promise<void>`, run once per pass before its first step — see below. Needs a `.ts` or `.js` config.                                                                  |
| `shareSetup`     | `false`                     | Run `setup` once per profile in a run, and start every pass from the cookies and storage it left — see below.                                                                                         |
| `exports`        | `{}`                        | Named sets of shots for `shotta export` — see below.                                                                                                                                                  |

### Signing in

Every pass starts in a browser of its own, with no cookies and no storage, which is
what keeps one flow's state out of the next. For an app behind a sign-in, `setup` is
where each pass signs in: it runs before the flow's first step and before any
recording starts, so it is in no video, and it applies to `shotta snap` and
`shotta export` as much as to a flow.

```ts
export default defineConfig({
  setup: async (page, { baseUrl }) => {
    await page.goto(`${baseUrl}/login`);
    await page.fill('[name=email]', 'demo@example.com');
    await page.fill('[name=password]', process.env.DEMO_PASSWORD ?? '');
    await page.click('role=button[name="Sign in"]');
    await page.waitForURL(`${baseUrl}/`);
  },
});
```

A cookie or a header does as well: `page.context().addCookies([...])`,
`page.setExtraHTTPHeaders({...})`. If `setup` throws, the pass fails at step `0`.

A sign-in through the app's own pages can take seconds, and every pass pays them.
With `shareSetup: true` the setup runs once per profile in a run instead, and each
pass starts in a fresh browser holding the cookies, local storage and IndexedDB it
left, so passes still cannot see each other's changes. Leave it off for a setup
whose effect lives anywhere else: session storage, headers set on the page, or state
on the server that each pass needs afresh. If a shared setup throws, every pass at
that profile fails at step `0`.

### The app server

`server.command` is run in a shell with `{port}` replaced by a free port (also exported
as `PORT`); `server.url` (default `http://localhost:{port}`) is where it answers.

The app is then **left running** for `server.keepAlive` ms after its last use (default
ten minutes), so the next run — or several at once — skip the startup. A run uses the
app an earlier one left up only if `shotta` started it, for this project, with the
command still configured; otherwise it is restarted. `shotta stop` stops it now.
Its output goes to `.shotta/server.log`.

This assumes the app picks up source changes by itself, as a dev server does. For one
that does not (a static build, say), set `keepAlive: 0`: the app is then started and
stopped with every run.

To run against an app you already have up, give its URL: `--base-url <url>` on the
command line, or `baseUrl` in the config. `shotta` then manages no process at all — it
starts nothing, and neither uses nor stops an app it left up earlier — and exits `2`
straight away if nothing answers there. Without a URL, a server the developer happens
to have running is never used by accident: it may be another checkout or another
environment.

### Running side by side

Passes that are not being recorded run several at once, each in its own browser
context — its own cookies, storage and service workers — against the one app. That is
safe when a pass's state lives in the browser (mocked APIs, local storage). If passes
write to a shared backend, set `workers: 1`. The passes that took longest last time
start first, so the run does not end on one long pass with the other workers idle;
the report keeps them in the planned order all the same. Recorded passes always run alone, after
the others: a recording is only as smooth as the machine is idle.

## Exports

Everything under `.shotta/` is scratch. An export is the opposite: a named set of
shots written under stable file names to a directory of your choosing — the screens
for a docs site, a README or a marketing page, regenerated with one command instead
of retaken by hand.

```ts
export default defineConfig({
  exports: {
    docs: {
      dir: 'docs/screens',
      scale: 2,
      shots: ['checkout/cart@desktop', 'checkout/ready-to-pay'],
    },
    site: {
      dir: 'site/public/img',
      scale: 3,
      shots: { 'hero.png': 'dashboard/summary-card@desktop' },
    },
  },
});
```

```sh
shotta export          # every export
shotta export site     # one
```

- `shots` — addresses, each `flow/shot` or `flow/shot@profile`. As a list, files are
  named `<flow>.<shot>.<profile>.png`, one per profile the address covers. As a map
  of file name → address, each address must come to exactly one profile.
- `format` — `png` (the default), `webp` or `jpeg`, for a list of shots; in a map,
  each file's own extension says (`'hero.webp': …`). `quality`, from 1 to 100
  (default 85), is how much a `webp` or `jpeg` keeps. The browser that took the shots
  writes them, so nothing else needs installing.
- `scale` — the device scale factor to shoot at; without it, each profile's own.
- `dir` — where the files go. Whether that directory is committed is the project's
  decision: commit it when the images are part of what you publish.

A shot of one element (`of`) or of the viewport (`viewport: true`) is usually what an
export wants, rather than a whole page. Flows run only as far as the shots asked
for, without video or storyboard, in scratch output of their own
(`.shotta/export/`), so an export never disturbs what anyone last looked at.
Exports shot at the same scale share one run, so a flow that several of them take
shots from runs once. If a
shot cannot be taken, the file already in `dir` is left as it is, the address is
listed under `missing`, and the command exits `1`.

## Command line

```
shotta [run] [target…]     run flows: all of them, or the targets
shotta list [target…]      the catalog: each flow, what it shows, its routes and shots
shotta snap <route…>       screenshot routes without writing a flow; with --of, one
                           element on each
shotta snap --steps <src>  run steps given as JSON: a file, - for stdin, or the JSON itself
shotta export [name…]      write the configured exports
shotta check               say what is wrong with the config, the flows and the exports
shotta stop                stop the app an earlier run left up

  --near <path>       only the flows closest to this source file or directory
  --route <prefix>    only flows that navigate to a route starting with this
  --profiles <names>  comma-separated profiles to run (default: the config's, or
                      each flow's own)
  --agent             output for a model to read: 1x images, tall pages cut into
                      tiles, no video, and only the JSON report on stdout
  --scale <n>         device scale factor for every profile, e.g. 3 for print
  --workers <n>       passes to run at once when none is being recorded
  --no-video          skip journey.webm
  --video             record it even where the config or snap would not
  --headed            show the browser
  --out <dir>         output directory, for this run only
  --tmp               write to a new directory under the system's temp folder
  --base-url <url>    use an already-running app instead of starting one
  --config <file>     config file
  --json              print the report as JSON on stdout; progress goes to stderr
  --name <name>       snap: the flow name its output goes under (default snap)
  --of <selector>     snap: shoot only this element on each route
  --pad <px>          snap: with --of, this much of the page around it as well
```

For output you will look at once, or move somewhere yourself, send it elsewhere:
`--out /tmp/look` writes to that directory, and `--tmp` makes a fresh one under the
system's temp folder and reports it as `outDir`. Either way the project's `.shotta/`
is left alone, and the app `shotta` is keeping up is still found and used. Since every
`--tmp` run gets its own directory, runs side by side cannot overwrite each other.

A failed pass never stops the others: narrow profiles are expected to find real
breakage, and the list of what broke where is the point of the run. Exit code is `0`
when every pass succeeded, `1` when any failed, `2` when the run could not start.

### check

`shotta check` reads the config, loads every flow and looks up every export, and says
what a run would refuse to start over — all of it at once, not only the first:

```
✗ src/cart/cart.shots.ts: steps[1]: not a step: {"clik":"#save"} (have: goto, click, …)
✗ src/admin/admin.shots.ts: admin: unknown profile: tablt (have: desktop, phone)
✗ exports.docs: checkout has no shot called paid (have: cart, ready-to-pay)
3 problems
```

It starts no browser and no app, so it takes a moment, and exits `0` when nothing is
wrong and `1` otherwise; `--json` prints `{ ok, flows, shots, exports, problems }`.
This is the way to validate a flow after writing or changing one. A TypeScript
compiler is not: flows are loaded by Node as they are, not compiled, and `tsc` run on
a flow file by hand knows nothing of the project's own steps unless it is given the
project's whole configuration. What `check` cannot know is whether a selector matches
anything, which takes the app: run the flow for that.

### snap

`shotta snap` is for looking at the app without committing a flow. Given routes, it
loads and shoots each one, naming the shot for the route:

```sh
shotta snap / /settings/billing     # → .shotta/review/snap/<profile>/01-index.png, 02-settings-billing.png
```

With `--of`, it shoots one element on each route instead of the page — the quick look
at a component that was just changed, small enough for a model to read in one piece:

```sh
shotta snap /settings/billing --of '[data-testid=plan-card]' --pad 24 --agent
```

Given steps, it runs them as a flow — an array of steps, or
`{ "steps": [...], "shows": …, "video": …, "cursor": …, "pace": …, "profiles": … }`:

```sh
shotta snap --name filters --steps - <<'JSON'
[
  { "goto": "/portfolio" },
  { "annotate": "Narrow to flood risk", "steps": [
    { "click": "role=button[name=\"Filters\"]" },
    { "click": "text=Flood" },
    { "shot": "flood-only", "shows": "Only flood hazards remain in the table" }
  ] }
]
JSON
```

Steps are checked before anything starts, and a mistake is reported by position:
`steps[1]: not a step: {"clik":"#save"} (have: goto, click, …)`. `snap` records no
video unless `--video` is passed. Two snaps at once need different `--name`s.

## Reading the output

Output is in levels, each cheaper than the next, each answering whether to go deeper:

1. **The catalog** (`shotta list --json`) — text. Which flows exist, what each claims to
   show, the routes it visits, the profiles it runs at, its shots by address. Enough
   to choose what to run.
2. **The report** — text. What ran, what passed, where each file is; for a failure,
   the step, the error, the console errors and the page's accessibility tree.
3. **The storyboard** — one image per flow. The whole journey at a glance.
4. **Shots** — one image per state, or a few tiles. The detail.
5. **Full-size shots and the video** — for people.

### The report

Every run writes one to `<outDir>/<review|agent>/runs/`; `--json` prints the same to
stdout. Paths are absolute.

```jsonc
{
  "ok": false,
  "startedAt": "2026-11-20T17:40:00.000Z",
  "durationMs": 8412,
  "outDir": "/repo/.shotta/review",
  "report": "/repo/.shotta/review/runs/20261120T174000000Z-4242.json",
  "passes": [
    {
      "flow": "checkout",
      "profile": "phone",
      "ok": false,
      "durationMs": 3120,
      "shots": [
        {
          "name": "cart",
          "shows": "Two items and their total",
          "area": "page",
          "chapter": null,
          "step": 2,
          "file": "/repo/.shotta/review/checkout/phone/01-cart.png",
          "tiles": []
        }
      ],
      "video": "/repo/.shotta/review/checkout/phone/journey.webm",
      "storyboard": ["/repo/.shotta/review/checkout/phone/storyboard.png"],
      "consoleErrors": ["TypeError: card is undefined"],
      "unsettled": [
        {
          "step": 1,
          "action": "goto /cart",
          "waitingOn": ["request /api/recommendations?for=cart"]
        }
      ],
      "failure": {
        "step": 3,
        "action": "click role=button[name=\"Checkout\"]",
        "chapter": "Pay with a saved card",
        "message": "locator.click: Timeout 30000ms exceeded. …",
        "url": "http://localhost:51234/cart",
        "screenshot": "/repo/.shotta/review/checkout/phone/failure.png",
        "aria": "/repo/.shotta/review/checkout/phone/failure.aria.yml"
      }
    }
  ]
}
```

Passes are listed in a stable order — flows by name, profiles as configured — however
they were asked for or finished.

`failure.screenshot` is the viewport as it was when the step failed. `failure.aria`
is the page's accessibility tree at that moment, as YAML — the roles and names a
selector could have matched, which is usually enough to see why one did not.
`consoleErrors` holds uncaught exceptions and `console.error` output from the page
(the first 20). `unsettled` lists the steps the page never went quiet after, and what
each was still waiting on: every one cost the pass a full settle timeout, so a pass
that is slow for no visible reason is explained here.

### The storyboard

`storyboard` is the journey as a contact sheet: one frame of the viewport per step
that changed something, captioned with the steps it stands for, the shots taken of
that state, and what the shot `shows` (or else the chapter), with a ring where the
step pressed if what it pressed is still on screen. A step that changed nothing visible (a `wait`, a `shot`) joins the frame
before it, and a failed step's frame is outlined in red with its error. Long journeys
run to several pages (`storyboard.1.png`, …); every page fits what a vision model
reads at full detail. Frames are small — read a shot for detail. A flow that only
loads a route and shoots it has no storyboard.

### Output for a model

`--agent` writes to `.shotta/agent/` instead of `.shotta/review/`, so looking at a
screen never overwrites what a person will open. Images are 1x; `shots[].tiles` lists
each page top to bottom in pieces at most 1568 pixels tall, overlapping slightly — a
vision model scales a taller image down until its text is unreadable. A page that
fits is its own only tile. No video is recorded, and stdout carries only the report.

When the work is done, run the same targets again without `--agent` to produce the
full-size shots, storyboard and video for a person.

## From code

```ts
import { check, exportShots, listFlows, run, snap, stop } from 'shotta';

const result = await run({ targets: ['checkout/cart@phone'] });
const look = await snap({ paths: ['/cart'], agent: true });
```

`run` and `snap` resolve with the report and throw only when the run could not start.

## For coding agents

Put something like this in the project's `AGENTS.md`:

> To see a screen you changed, find the flow that shows it:
> `pnpm shotta list --near <file you changed> --json` (or `--route <route>`). Run what
> you need in one command — several targets run side by side:
> `pnpm shotta checkout/cart@desktop settings@phone --agent`. Read
> `passes[].storyboard` first: one image shows a whole journey. Then read
> `passes[].shots[].tiles` for the states that need a closer look, and check each
> against its `shows`. For a screen with no flow, use `pnpm shotta snap <route> --agent`,
> or pipe steps as JSON to `pnpm shotta snap --steps - --agent`. For one component you
> changed, shoot only it: `pnpm shotta snap <route> --of '<selector>' --pad 24 --agent`. If `ok` is false, read
> `failure.message` and `failure.aria` (then `failure.screenshot` and
> `consoleErrors`) before changing anything. When you are done, run the same targets
> without `--agent` and give the user the storyboard and video paths. A screen's
> change ships with its flow: add or update `<name>.shots.ts` beside it, with a
> `shows` line on the flow and on each shot. After writing or changing a flow or the
> config, run `pnpm shotta check`: it says everything that is wrong with them in a
> moment, with no browser. Do not run `tsc` on a flow to validate it.
