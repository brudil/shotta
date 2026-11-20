# shots

Scripted screenshots and journey videos of a web app, driven by Playwright.

A flow is a short script: go here, click that, checkpoint a screenshot. `shots` runs
flows at the viewport profiles you configure and writes, per flow and profile, the
checkpoint PNGs, a `journey.webm` of the whole thing, and a storyboard: the journey
as one captioned contact sheet. Use it to put real screens in pull requests and
design reviews, and to let a coding agent look at what it just built without driving
a browser.

It is not a visual-regression gate: nothing is compared against a baseline.

## Setup

```sh
pnpm add -D shots playwright
pnpm exec playwright install chromium-headless-shell
```

Node 22.18 or later, Playwright 1.59 or later. Flows and the config are TypeScript files that Node loads
directly, so they must use erasable syntax only (no enums, no parameter properties).

`shots.config.ts`, in the project root or in `.config/`:

```ts
import { defineConfig } from 'shots';

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
import { defineFlow } from 'shots';

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
pnpm shots                              # every flow, every profile
pnpm shots checkout                     # one flow
pnpm shots checkout/cart@phone          # one shot at one profile: the flow stops there
```

## What is where

|                                                        | Committed?                                         |
| ------------------------------------------------------ | -------------------------------------------------- |
| Flows (`*.shots.ts`), `shots.config.ts`, project steps | Yes. They are the source.                          |
| `.shots/` — everything a run writes                    | No. It is all regenerable; add it to `.gitignore`. |

```
.shots/
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
  server.json, server.log the app shots is keeping up, if any
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
file (see `shots snap`).

| Step                                       | Does                                                                  |
| ------------------------------------------ | --------------------------------------------------------------------- |
| `{ goto: '/path' }`                        | Navigate. Relative paths resolve against the app.                     |
| `{ click: selector }`                      | Move the pointer to the element and click it. Taps on touch profiles. |
| `{ hover: selector }`                      | Move the pointer over the element. Skipped on touch profiles.         |
| `{ type: 'text', into: selector }`         | Clear the field and type, one key at a time. `delay` sets ms per key. |
| `{ scroll: selector }` / `{ scroll: 400 }` | Scroll the element into view, or by that many pixels.                 |
| `{ press: 'Escape' }`                      | Press a key.                                                          |
| `{ wait: selector }`                       | Wait for the element to appear.                                       |
| `{ shot: 'name', shows: '…' }`             | Checkpoint a full-page screenshot, named for the state it shows.      |
| `{ run: async (page) => {…}, label: '…' }` | Anything else, with the Playwright `Page`.                            |

Selectors are Playwright selector strings: `text=Load more`,
`role=button[name="Clear"]`, `[data-testid=x]`, `css >> nth=1`.

`shows` — on the flow and on any shot — is one line saying what a reader should find
there. It is what turns "a screenshot" into a claim that can be checked: it appears in
the catalog, in the report beside the shot, and as the caption on the storyboard.
Write it for someone who has not seen the screen.

`{ annotate: 'Drill into a hazard', steps: [...] }` names a chapter. It is captioned
in the video for the length of its steps and its shots go in a subdirectory. Narrate a
journey this way rather than leaving a reviewer to guess.

After every step the runner waits for the page to settle: fonts and images loaded,
nothing `aria-busy`, no finite animation running, the network quiet, and before a
shot, successive frames identical (which covers canvas). So a numeric `wait` should not
be needed; if a flow needs one, something is busy that settling cannot see.

Flow options, beside `steps` and `shows`:

- `video` — a flow is recorded only when something moves in it (a click, hover, type,
  scroll, press or `run`). One that loads a route and shoots it is fully described by
  its shots. Set `true` or `false` to force the decision.
- `cursor` — a cursor is drawn and travels between targets, because headless Chromium
  draws none; it holds on a target before pressing so the click reads on video.
  `false` turns it off. Touch profiles show a ring where the tap landed instead.
- `pace` — pause between steps in ms, overriding the configured one.

A recording opens on the app once it has first settled, not on a blank page, and is
paused while each shot is captured, so nothing done for the screenshot shows in it.

The cursor, its travel and the pace exist for the recording. A pass that records no
video skips them and clicks directly, which is what makes `--no-video` fast.

Sizes are a project decision, so a flow cannot set its own.

### Where flows live

By default the whole project is searched (not `node_modules`, not dot-directories), so
a flow can sit beside the feature it shows — `src/checkout/checkout.shots.ts` next to
the checkout code. That is what lets someone who changed a file find what shows it:

```sh
shots list --near src/checkout/summary.component.ts   # the flows beside it, or in the nearest directory above
shots list --route /checkout                          # the flows that go there
```

Both options work on `shots run` too. Set `flows` to a directory to keep them all in
one place instead.

### Steps of your own

A project can add steps, so flows — JSON ones included — can say things like
`{ login: 'admin' }` instead of repeating a `run`. Declare each step's name and value
type, and give its handler, in `shots.config.ts`:

```ts
import { defineConfig } from 'shots';

declare module 'shots' {
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

`shots.config.{ts,mts,js,mjs,json}` in the project root or `.config/`, or anywhere
with `--config`. Paths in it are relative to the directory `shots` runs in.

| Key              | Default                     |                                                                                                                                                            |
| ---------------- | --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `flows`          | `.`                         | Directory searched, recursively, for flow files.                                                                                                           |
| `outDir`         | `.shots`                    | Where output is written. Each flow-and-profile directory is emptied before its pass.                                                                       |
| `profiles`       | one 1440×1000 @2x `desktop` | Named viewports: a Playwright `device` preset, or a `viewport` and `deviceScaleFactor`, or a preset with overrides.                                        |
| `run`            | every profile               | Profiles a run uses unless a target names another (`@tablet`), in order.                                                                                   |
| `server`         | —                           | `{ command, url?, readyTimeout?, keepAlive? }` — see below.                                                                                                |
| `baseUrl`        | —                           | An app that is already running; wins over `server`.                                                                                                        |
| `workers`        | half the cores, at most 4   | Passes run at once when none is being recorded. Set `1` if passes share state outside the browser.                                                         |
| `pace`           | `200`                       | Pause between steps while recording, in ms.                                                                                                                |
| `video`          | `true`                      | Record journey videos.                                                                                                                                     |
| `storyboard`     | `true`                      | Write a storyboard for every flow in which something moves.                                                                                                |
| `actionTimeout`  | `30000`                     | How long one step may take to find and act on its target, in ms.                                                                                           |
| `localStorage`   | `{}`                        | Set before the app boots on every page, e.g. a flag that turns API mocking on.                                                                             |
| `hide`           | `[]`                        | CSS selectors hidden in every shot and video, e.g. dev-only overlays.                                                                                      |
| `ignoreRequests` | `[]`                        | Requests that never go quiet (pollers, telemetry), as URL substrings or regular expressions. Dev-server module and hot-update requests are always ignored. |
| `failWhen`       | `[]`                        | `{ selector, message? }` conditions checked after every step — e.g. the app's error boundary.                                                              |
| `steps`          | `{}`                        | Steps of the project's own, as name → `(page, value) => Promise<void>`. Needs a `.ts` or `.js` config.                                                     |

### The app server

`server.command` is run in a shell with `{port}` replaced by a free port (also exported
as `PORT`); `server.url` (default `http://localhost:{port}`) is where it answers.

The app is then **left running** for `server.keepAlive` ms after its last use (default
ten minutes), so the next run — or several at once — skip the startup. A run uses the
app an earlier one left up only if `shots` started it, for this project, with the
command still configured; otherwise it is restarted. `shots stop` stops it now.
Its output goes to `.shots/server.log`.

This assumes the app picks up source changes by itself, as a dev server does. For one
that does not (a static build, say), set `keepAlive: 0`: the app is then started and
stopped with every run.

To run against an app you already have up, give its URL: `--base-url <url>` on the
command line, or `baseUrl` in the config. `shots` then manages no process at all — it
starts nothing, and neither uses nor stops an app it left up earlier — and exits `2`
straight away if nothing answers there. Without a URL, a server the developer happens
to have running is never used by accident: it may be another checkout or another
environment.

### Running side by side

Passes that are not being recorded run several at once, each in its own browser
context — its own cookies, storage and service workers — against the one app. That is
safe when a pass's state lives in the browser (mocked APIs, local storage). If passes
write to a shared backend, set `workers: 1`. Recorded passes always run alone, after
the others: a recording is only as smooth as the machine is idle.

## Command line

```
shots [run] [target…]     run flows: all of them, or the targets
shots list [target…]      the catalog: each flow, what it shows, its routes and shots
shots snap <route…>       screenshot routes without writing a flow
shots snap --steps <src>  run steps given as JSON: a file, - for stdin, or the JSON itself
shots stop                stop the app an earlier run left up

  --near <path>       only the flows closest to this source file or directory
  --route <prefix>    only flows that navigate to a route starting with this
  --profiles <names>  comma-separated profiles to run (default: all configured)
  --agent             output for a model to read: 1x images, tall pages cut into
                      tiles, no video, and only the JSON report on stdout
  --scale <n>         device scale factor for every profile, e.g. 3 for print
  --workers <n>       passes to run at once when none is being recorded
  --no-video          skip journey.webm
  --video             record it even where the config or snap would not
  --headed            show the browser
  --out <dir>         output directory
  --base-url <url>    use an already-running app instead of starting one
  --config <file>     config file
  --json              print the report as JSON on stdout; progress goes to stderr
  --name <name>       snap: the flow name its output goes under (default snap)
```

A failed pass never stops the others: narrow profiles are expected to find real
breakage, and the list of what broke where is the point of the run. Exit code is `0`
when every pass succeeded, `1` when any failed, `2` when the run could not start.

### snap

`shots snap` is for looking at the app without committing a flow. Given routes, it
loads and shoots each one, naming the shot for the route:

```sh
shots snap / /settings/billing     # → .shots/review/snap/<profile>/01-index.png, 02-settings-billing.png
```

Given steps, it runs them as a flow — an array of steps, or
`{ "steps": [...], "shows": …, "video": …, "cursor": …, "pace": … }`:

```sh
shots snap --name filters --steps - <<'JSON'
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

1. **The catalog** (`shots list --json`) — text. Which flows exist, what each claims to
   show, the routes it visits, its shots by address. Enough to choose what to run.
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
  "outDir": "/repo/.shots/review",
  "report": "/repo/.shots/review/runs/20261120T174000000Z-4242.json",
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
          "chapter": null,
          "step": 2,
          "file": "/repo/.shots/review/checkout/phone/01-cart.png",
          "tiles": []
        }
      ],
      "video": "/repo/.shots/review/checkout/phone/journey.webm",
      "storyboard": ["/repo/.shots/review/checkout/phone/storyboard.png"],
      "consoleErrors": ["TypeError: card is undefined"],
      "failure": {
        "step": 3,
        "action": "click role=button[name=\"Checkout\"]",
        "chapter": "Pay with a saved card",
        "message": "locator.click: Timeout 30000ms exceeded. …",
        "url": "http://localhost:51234/cart",
        "screenshot": "/repo/.shots/review/checkout/phone/failure.png",
        "aria": "/repo/.shots/review/checkout/phone/failure.aria.yml"
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
(the first 20).

### The storyboard

`storyboard` is the journey as a contact sheet: one frame of the viewport per step
that changed something, captioned with the steps it stands for, the shots taken of
that state, and what the shot `shows` (or else the chapter), with a ring where the
step pressed. A step that changed nothing visible (a `wait`, a `shot`) joins the frame
before it, and a failed step's frame is outlined in red with its error. Long journeys
run to several pages (`storyboard.1.png`, …); every page fits what a vision model
reads at full detail. Frames are small — read a shot for detail. A flow that only
loads a route and shoots it has no storyboard.

### Output for a model

`--agent` writes to `.shots/agent/` instead of `.shots/review/`, so looking at a
screen never overwrites what a person will open. Images are 1x; `shots[].tiles` lists
each page top to bottom in pieces at most 1568 pixels tall, overlapping slightly — a
vision model scales a taller image down until its text is unreadable. A page that
fits is its own only tile. No video is recorded, and stdout carries only the report.

When the work is done, run the same targets again without `--agent` to produce the
full-size shots, storyboard and video for a person.

## From code

```ts
import { listFlows, run, snap, stop } from 'shots';

const result = await run({ targets: ['checkout/cart@phone'] });
const look = await snap({ paths: ['/cart'], agent: true });
```

`run` and `snap` resolve with the report and throw only when the run could not start.

## For coding agents

Put something like this in the project's `AGENTS.md`:

> To see a screen you changed, find the flow that shows it:
> `pnpm shots list --near <file you changed> --json` (or `--route <route>`). Run what
> you need in one command — several targets run side by side:
> `pnpm shots checkout/cart@desktop settings@phone --agent`. Read
> `passes[].storyboard` first: one image shows a whole journey. Then read
> `passes[].shots[].tiles` for the states that need a closer look, and check each
> against its `shows`. For a screen with no flow, use `pnpm shots snap <route> --agent`,
> or pipe steps as JSON to `pnpm shots snap --steps - --agent`. If `ok` is false, read
> `failure.message` and `failure.aria` (then `failure.screenshot` and
> `consoleErrors`) before changing anything. When you are done, run the same targets
> without `--agent` and give the user the storyboard and video paths. A screen's
> change ships with its flow: add or update `<name>.shots.ts` beside it, with a
> `shows` line on the flow and on each shot.
