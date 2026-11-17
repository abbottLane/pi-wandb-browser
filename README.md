# pi-wandb-browser

A [pi](https://github.com/earendil-works/pi) extension for browsing [Weights & Biases](https://wandb.ai) experiments in the terminal: projects, runs, metric charts, run comparisons, and run files.

It adds one command, `/wandb`, for you rather than the model. To let the agent query W&B, use the official [W&B MCP server](https://github.com/wandb/wandb-mcp-server) alongside it.

## Install

```bash
pi install git:github.com/abbottLane/pi-wandb-browser
```

Or try it for one session:

```bash
git clone https://github.com/abbottLane/pi-wandb-browser
pi -e ./pi-wandb-browser
```

`/wandb` opens a browser for your [W&B](https://wandb.ai) projects in interactive mode. It shows runs, plots their logged metrics as line charts, compares runs on one chart, and previews run files.

## Sign in

The browser uses the same credentials as the `wandb` CLI:

1. `WANDB_API_KEY`, if set.
2. Otherwise the `wandb login` entry in `~/.netrc` (or the file in `NETRC`).

Set `WANDB_BASE_URL` for a dedicated or self-hosted W&B server. The title bar shows the signed-in user, so a key for the wrong account is easy to spot.

## Open the browser

```text
/wandb                                   all projects of your entity and teams
/wandb my-project                        runs of a project in your default entity
/wandb my-team/my-project                runs of a project
/wandb my-team/my-project/run-id         one run
/wandb https://wandb.ai/my-team/my-project/runs/run-id
```

Escape goes back one page and closes the browser from the first page.

## Navigate

| Page | Keys |
|---|---|
| Lists (projects, runs, metrics, files) | Type to filter; up/down and page up/down move; Enter opens; Escape clears the filter, then goes back |
| Runs | Tab marks a run; **Compare N marked runs** at the top charts the marked runs together. **Load more runs…** fetches the next 100 |
| Run | **Charts**, **Files**, **Summary**, **Config**, and **Open in browser** |
| Chart | Left/right switch to the previous/next metric |
| File preview | Up/down, page up/down, Home/End scroll; `o` opens the file in the browser |

## Charts

Charts plot each numeric metric against `_step`, sampled to 1,000 points per run like the W&B line plots. When several runs are compared, each run keeps its color across metrics, and the legend shows each run's last, minimum, and maximum value.

System metrics (GPU, CPU, memory) are not included.

## Files

Files are listed by directory, as stored with the run. Text files are shown wrapped, with progress-bar output collapsed to its final state and JSON pretty-printed. Images (PNG, JPEG, GIF, WebP), such as `wandb.Image` media under `media/images/`, render inline in terminals with Kitty or iTerm2 graphics; other terminals offer to open them in the browser. Text previews are limited to 5 MB and images to 20 MB.

## Develop

```bash
npm install
npm run check   # biome + tsc
npm test        # vitest
```

## License

MIT
