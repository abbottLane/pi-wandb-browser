import { spawn } from "node:child_process";
import {
	type ExtensionCommandContext,
	formatSize,
	type KeybindingsManager,
	keyHint,
	rawKeyHint,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import {
	type Component,
	type Focusable,
	fuzzyFilter,
	getCapabilities,
	getSelectPageIndex,
	Image,
	Input,
	matchesKey,
	rgbColor,
	stripTerminalSequences,
	type TUI,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { type ChartSeries, formatChartNumber, renderLineChart } from "./chart.ts";
import type { WandbClient, WandbFile, WandbRunDetails, WandbRunSummary, WandbViewer } from "./client.ts";

const RUN_PAGE_SIZE = 100;
/** Points per metric, like the W&B line plots. */
const HISTORY_SAMPLES = 1000;
const MAX_TEXT_BYTES = 5 * 1024 * 1024;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
/** Terminal rows left to pi's status lines below the browser. */
const RESERVED_ROWS = 2;
/** Border, title, blank line, hints, border. */
const CHROME_ROWS = 5;
const SERIES_COLORS = [
	[83, 135, 221],
	[229, 107, 111],
	[95, 184, 120],
	[240, 173, 78],
	[160, 108, 214],
	[72, 190, 190],
	[218, 112, 182],
	[160, 160, 160],
] as const;
const IMAGE_TYPES: Record<string, string> = {
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	gif: "image/gif",
	webp: "image/webp",
};

export interface WandbTarget {
	entity?: string;
	project?: string;
	run?: string;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function age(iso: string): string {
	const seconds = (Date.now() - Date.parse(iso)) / 1000;
	if (!Number.isFinite(seconds)) return iso;
	const units: Array<[number, string]> = [
		[365 * 86400, "y"],
		[30 * 86400, "mo"],
		[86400, "d"],
		[3600, "h"],
		[60, "m"],
	];
	for (const [size, unit] of units) if (seconds >= size) return `${Math.floor(seconds / size)}${unit} ago`;
	return "just now";
}

/**
 * Opens a URL with the platform's default handler, without a shell so URLs cannot inject commands.
 * Best effort: a missing launcher is ignored.
 */
function openBrowser(target: string): void {
	const [command, args]: [string, string[]] =
		process.platform === "darwin"
			? ["open", [target]]
			: process.platform === "win32"
				? ["rundll32", ["url.dll,FileProtocolHandler", target]]
				: ["xdg-open", [target]];
	spawn(command, args, { stdio: "ignore", detached: true, cwd: "/" })
		.on("error", () => {})
		.unref();
}

/** One line of a run file for display: the final state of `\r` progress bars, without escapes or controls. */
function displayLine(line: string): string {
	const segments = line.split("\r");
	const visible = segments.findLast((segment) => segment.length > 0) ?? "";
	// Control characters break width measurement; U+FFF9..U+FFFB crash string-width.
	return stripTerminalSequences(visible)
		.replaceAll("\t", "    ")
		.replace(/[\x00-\x08\x0A-\x1F\x7F\uFFF9-\uFFFB]/g, "");
}

abstract class Page {
	readonly controller = new AbortController();
	readonly view: WandbView;
	title: string;

	constructor(view: WandbView, title: string) {
		this.view = view;
		this.title = title;
	}

	abstract hints(): string;
	/** At most `height` lines of at most `width` columns. */
	abstract render(width: number, height: number): readonly string[];
	abstract handleInput(data: string): void;
	protected abstract showError(message: string): void;

	setFocused(_focused: boolean): void {}

	/** Runs async work for this page. Errors show on the page; nothing updates once the page is closed. */
	load(work: (signal: AbortSignal) => Promise<void>): void {
		const { signal } = this.controller;
		work(signal).then(
			() => this.view.update(),
			(error: unknown) => {
				if (signal.aborted) return;
				this.showError(errorMessage(error));
				this.view.update();
			},
		);
	}
}

interface ListItem {
	key: string;
	label: string;
	detail?: string;
	marked?: boolean;
	/** Actions such as "Load more" that stay visible while filtering and cannot be marked. */
	pinned?: boolean;
}

interface ListOptions {
	openHint: string;
	onOpen(item: ListItem): void;
	/** Enables marking with tab. */
	onMark?(item: ListItem): void;
}

class ListPage extends Page {
	private readonly options: ListOptions;
	private readonly input: Input;
	private items: ListItem[] = [];
	private filtered: ListItem[] = [];
	private selected = 0;
	private status: { text: string; error: boolean } | undefined = { text: "Loading…", error: false };
	private visibleRows = 10;

	constructor(view: WandbView, title: string, options: ListOptions) {
		super(view, title);
		this.options = options;
		this.input = new Input({
			prompt: "/ ",
			placeholder: "type to filter",
			placeholderStyle: (text) => view.theme.fg("dim", text),
		});
	}

	setItems(items: ListItem[], emptyText = "Nothing here"): void {
		const selectedKey = this.filtered[this.selected]?.key;
		this.items = items;
		this.status = items.length === 0 ? { text: emptyText, error: false } : undefined;
		this.applyFilter(selectedKey);
		this.view.update();
	}

	protected showError(message: string): void {
		this.status = { text: message, error: true };
	}

	override setFocused(focused: boolean): void {
		this.input.focused = focused;
	}

	private applyFilter(preferredKey?: string): void {
		const query = this.input.getValue().trim();
		if (query) {
			const candidates = this.items.filter((item) => !item.pinned);
			const matches = new Set(fuzzyFilter(candidates, query, (item) => `${item.label} ${item.detail ?? ""}`));
			this.filtered = this.items.filter((item) => item.pinned || matches.has(item));
		} else {
			this.filtered = this.items;
		}
		const preferred = preferredKey ? this.filtered.findIndex((item) => item.key === preferredKey) : -1;
		this.selected = preferred >= 0 ? preferred : Math.min(this.selected, Math.max(0, this.filtered.length - 1));
	}

	hints(): string {
		return [
			keyHint("tui.select.confirm", this.options.openHint),
			this.options.onMark ? rawKeyHint("tab", "mark to compare") : undefined,
			keyHint("tui.select.cancel", this.input.getValue() ? "clear filter" : "back"),
		]
			.filter(Boolean)
			.join(this.view.theme.fg("muted", " · "));
	}

	render(width: number, height: number): readonly string[] {
		const { theme } = this.view;
		const lines = [this.input.render(width)[0] ?? "", ""];
		if (this.status) {
			lines.push(theme.fg(this.status.error ? "error" : "muted", this.status.text));
			return lines;
		}
		if (this.filtered.length === 0) {
			lines.push(theme.fg("muted", "No matches"));
			return lines;
		}
		const listRows = Math.max(1, height - lines.length - 1);
		this.visibleRows = listRows;
		const start = Math.max(0, Math.min(this.selected - Math.floor(listRows / 2), this.filtered.length - listRows));
		const visible = this.filtered.slice(start, start + listRows);
		const marks = this.options.onMark !== undefined;
		const labelWidth = Math.min(
			Math.max(...visible.map((item) => visibleWidth(item.label))),
			Math.floor(width * 0.6),
		);
		visible.forEach((item, offset) => {
			const isSelected = start + offset === this.selected;
			const prefix = isSelected ? theme.fg("accent", "› ") : "  ";
			const mark = !marks ? "" : item.pinned ? "  " : item.marked ? theme.fg("accent", "● ") : theme.fg("dim", "○ ");
			const label = truncateToWidth(item.label, labelWidth);
			const padded = label + " ".repeat(Math.max(0, labelWidth - visibleWidth(label)));
			const text = isSelected ? theme.fg("accent", padded) : item.pinned ? theme.fg("muted", padded) : padded;
			const detail = item.detail ? theme.fg("dim", `  ${item.detail}`) : "";
			lines.push(truncateToWidth(`${prefix}${mark}${text}${detail}`, width));
		});
		if (this.filtered.length > listRows) {
			lines.push(theme.fg("dim", `  ${this.selected + 1}/${this.filtered.length}`));
		}
		return lines;
	}

	handleInput(data: string): void {
		const { keybindings } = this.view;
		const count = this.filtered.length;
		if (keybindings.matches(data, "tui.select.up")) {
			if (count) this.selected = this.selected === 0 ? count - 1 : this.selected - 1;
			return;
		}
		if (keybindings.matches(data, "tui.select.down")) {
			if (count) this.selected = this.selected === count - 1 ? 0 : this.selected + 1;
			return;
		}
		const pageIndex = getSelectPageIndex(keybindings, data, this.selected, count, this.visibleRows);
		if (pageIndex !== undefined) {
			if (count) this.selected = pageIndex;
			return;
		}
		const item = this.filtered[this.selected];
		if (keybindings.matches(data, "tui.select.confirm")) {
			if (item && !this.status) this.options.onOpen(item);
			return;
		}
		if (matchesKey(data, "tab")) {
			if (item && !item.pinned && !this.status) this.options.onMark?.(item);
			return;
		}
		if (keybindings.matches(data, "tui.select.cancel")) {
			if (!this.input.getValue()) {
				this.view.pop();
				return;
			}
			this.input.setValue("");
			this.applyFilter(item?.key);
			return;
		}
		const before = this.input.getValue();
		this.input.handleInput(data);
		if (this.input.getValue() !== before) {
			this.selected = 0;
			this.applyFilter();
		}
	}
}

/** Scrollable text, wrapped to the width. `o` opens `url` in the browser when set. */
class TextPage extends Page {
	private readonly url: string | undefined;
	private source: string[] | undefined;
	private status = { text: "Loading…", error: false };
	private wrapped: { width: number; lines: string[] } | undefined;
	private scroll = 0;
	private viewport = 10;

	constructor(view: WandbView, title: string, url?: string) {
		super(view, title);
		this.url = url;
	}

	setText(text: string): void {
		this.source = text.split("\n").map(displayLine);
		this.wrapped = undefined;
		this.view.update();
	}

	protected showError(message: string): void {
		this.status = { text: message, error: true };
	}

	hints(): string {
		const { theme } = this.view;
		const total = this.wrapped?.lines.length ?? 0;
		const position =
			total > this.viewport ? theme.fg("dim", `${Math.min(total, this.scroll + this.viewport)}/${total} lines`) : "";
		return [
			rawKeyHint("↑↓/pgup/pgdn", "scroll"),
			this.url ? rawKeyHint("o", "open in browser") : undefined,
			keyHint("tui.select.cancel", "back"),
			position,
		]
			.filter(Boolean)
			.join(theme.fg("muted", " · "));
	}

	render(width: number, height: number): readonly string[] {
		if (!this.source) return [this.view.theme.fg(this.status.error ? "error" : "muted", this.status.text)];
		if (this.wrapped?.width !== width) {
			this.wrapped = { width, lines: this.source.flatMap((line) => (line ? wrapTextWithAnsi(line, width) : [""])) };
		}
		this.viewport = height;
		this.scroll = Math.max(0, Math.min(this.scroll, this.wrapped.lines.length - height));
		return this.wrapped.lines.slice(this.scroll, this.scroll + height);
	}

	handleInput(data: string): void {
		const { keybindings } = this.view;
		if (keybindings.matches(data, "tui.select.up")) this.scroll--;
		else if (keybindings.matches(data, "tui.select.down")) this.scroll++;
		else if (keybindings.matches(data, "tui.select.pageUp")) this.scroll -= this.viewport;
		else if (keybindings.matches(data, "tui.select.pageDown")) this.scroll += this.viewport;
		else if (matchesKey(data, "home")) this.scroll = 0;
		else if (matchesKey(data, "end")) this.scroll = Number.MAX_SAFE_INTEGER;
		else if (data === "o" && this.url) openBrowser(this.url);
		else if (keybindings.matches(data, "tui.select.cancel")) this.view.pop();
		this.scroll = Math.max(0, this.scroll);
	}
}

class ImagePage extends Page {
	private readonly file: WandbFile;
	private readonly mimeType: string;
	private data: string | undefined;
	private status = { text: "Loading…", error: false };
	private image: { height: number; component: Image } | undefined;

	constructor(view: WandbView, file: WandbFile, mimeType: string) {
		super(view, file.name.split("/").pop() ?? file.name);
		this.file = file;
		this.mimeType = mimeType;
	}

	setData(base64: string): void {
		this.data = base64;
		this.image = undefined;
		this.view.update();
	}

	protected showError(message: string): void {
		this.status = { text: message, error: true };
	}

	hints(): string {
		return [rawKeyHint("o", "open in browser"), keyHint("tui.select.cancel", "back")].join(
			this.view.theme.fg("muted", " · "),
		);
	}

	render(width: number, height: number): readonly string[] {
		const { theme } = this.view;
		if (!this.data) return [theme.fg(this.status.error ? "error" : "muted", this.status.text)];
		if (!getCapabilities().images) {
			return [
				theme.fg("muted", `${this.file.name} · ${formatSize(this.file.sizeBytes)}`),
				"",
				theme.fg(
					"warning",
					"This terminal cannot show images (needs Kitty or iTerm2 graphics). Press o to open it.",
				),
			];
		}
		if (this.image?.height !== height) {
			this.image = {
				height,
				component: new Image(
					this.data,
					this.mimeType,
					{ fallbackColor: (text) => theme.fg("muted", text) },
					{ maxWidthCells: width, maxHeightCells: height, filename: this.file.name },
				),
			};
		}
		return this.image.component.render(width);
	}

	handleInput(data: string): void {
		if (data === "o") openBrowser(this.file.directUrl);
		else if (this.view.keybindings.matches(data, "tui.select.cancel")) this.view.pop();
	}
}

/** One metric over steps for one or more runs; left and right switch between metrics. */
class ChartPage extends Page {
	private readonly client: WandbClient;
	private readonly runs: WandbRunDetails[];
	private readonly metrics: string[];
	private index: number;
	private readonly series = new Map<string, ChartSeries[] | { error: string }>();
	private chart: { key: string; lines: string[] } | undefined;

	constructor(view: WandbView, client: WandbClient, runs: WandbRunDetails[], metrics: string[], index: number) {
		super(view, metrics[index]!);
		this.client = client;
		this.runs = runs;
		this.metrics = metrics;
		this.index = index;
		this.loadMetric();
	}

	private get metric(): string {
		return this.metrics[this.index]!;
	}

	private loadMetric(): void {
		const metric = this.metric;
		this.title = metric;
		if (this.series.has(metric)) return;
		const { theme } = this.view;
		// Color by position among all runs, so a run keeps its color across metrics.
		const plotted = this.runs.flatMap((run, runIndex) => (run.metrics.includes(metric) ? [{ run, runIndex }] : []));
		this.load(async (signal) => {
			try {
				const series = await Promise.all(
					plotted.map(async ({ run, runIndex }) => {
						const [r, g, b] = SERIES_COLORS[runIndex % SERIES_COLORS.length]!;
						return {
							label: run.displayName,
							color: (text: string) => theme.style(text, { fg: rgbColor(r, g, b) }),
							points: await this.client.history(
								run.entity,
								run.project,
								run.name,
								metric,
								HISTORY_SAMPLES,
								signal,
							),
						};
					}),
				);
				this.series.set(metric, series);
			} catch (error) {
				if (!signal.aborted) this.series.set(metric, { error: errorMessage(error) });
			}
		});
	}

	protected showError(message: string): void {
		this.series.set(this.metric, { error: message });
	}

	hints(): string {
		return [
			rawKeyHint("←→", "previous/next metric"),
			keyHint("tui.select.cancel", "back"),
			this.view.theme.fg("dim", `${this.index + 1}/${this.metrics.length}`),
		].join(this.view.theme.fg("muted", " · "));
	}

	render(width: number, height: number): readonly string[] {
		const { theme } = this.view;
		const header = `${theme.bold(this.metric)}${theme.fg("dim", " by step")}`;
		const series = this.series.get(this.metric);
		if (!series) return [header, "", theme.fg("muted", "Loading…")];
		if ("error" in series) return [header, "", theme.fg("error", series.error)];
		const legend = series.map((s) => {
			const values = s.points.map((point) => point.value);
			const stats = values.length
				? `last ${formatChartNumber(values.at(-1)!)} · min ${formatChartNumber(Math.min(...values))} · max ${formatChartNumber(Math.max(...values))} · ${values.length} points`
				: "no points";
			return truncateToWidth(`${s.color("━━")} ${s.label}${theme.fg("dim", `  ${stats}`)}`, width);
		});
		const chartHeight = height - legend.length - 2;
		const key = `${this.metric}\0${width}\0${chartHeight}`;
		if (this.chart?.key !== key) {
			this.chart = {
				key,
				lines: renderLineChart(series, width, chartHeight, { axis: (text) => theme.fg("dim", text) }),
			};
		}
		return [header, ...legend, "", ...this.chart.lines];
	}

	handleInput(data: string): void {
		if (matchesKey(data, "left") || matchesKey(data, "right")) {
			const step = matchesKey(data, "left") ? -1 : 1;
			this.index = (this.index + step + this.metrics.length) % this.metrics.length;
			this.loadMetric();
		} else if (this.view.keybindings.matches(data, "tui.select.cancel")) this.view.pop();
	}
}

/** A stack of pages; escape pops back, and closing the last page ends the browser. */
class WandbView implements Component, Focusable {
	readonly tui: TUI;
	readonly theme: Theme;
	readonly keybindings: KeybindingsManager;
	/** First breadcrumb, naming the signed-in user so a wrong API key is obvious. */
	private readonly root: string;
	private readonly close: () => void;
	private readonly pages: Page[] = [];
	private _focused = false;

	constructor(tui: TUI, theme: Theme, keybindings: KeybindingsManager, root: string, close: () => void) {
		this.tui = tui;
		this.theme = theme;
		this.keybindings = keybindings;
		this.root = root;
		this.close = close;
	}

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		this.pages.at(-1)?.setFocused(value);
	}

	push<T extends Page>(page: T): T {
		this.pages.at(-1)?.setFocused(false);
		this.pages.push(page);
		page.setFocused(this._focused);
		this.update();
		return page;
	}

	pop(): void {
		const page = this.pages.pop();
		page?.controller.abort();
		const top = this.pages.at(-1);
		if (!top) {
			this.close();
			return;
		}
		top.setFocused(this._focused);
		this.update();
	}

	dispose(): void {
		for (const page of this.pages) page.controller.abort();
	}

	update(): void {
		this.tui.requestRender();
	}

	render(width: number): string[] {
		const page = this.pages.at(-1);
		if (!page) return [];
		const { theme } = this;
		const height = Math.max(CHROME_ROWS + 3, this.tui.terminal.rows - RESERVED_ROWS);
		const bodyHeight = height - CHROME_ROWS;
		const inner = Math.max(1, width - 2);
		let crumbs = [this.root, ...this.pages.map((p) => p.title)].join(" › ");
		if (visibleWidth(crumbs) > inner) crumbs = `…${crumbs.slice(-(inner - 1))}`;
		const body = [...page.render(inner, bodyHeight)].slice(0, bodyHeight);
		while (body.length < bodyHeight) body.push("");
		const border = theme.fg("accent", "─".repeat(width));
		return [
			border,
			` ${theme.fg("accent", theme.bold(crumbs))}`,
			"",
			...body.map((line) => ` ${line}`),
			` ${page.hints()}`,
			border,
		].map((line) => (visibleWidth(line) > width ? truncateToWidth(line, width, "") : line));
	}

	handleInput(data: string): void {
		this.pages.at(-1)?.handleInput(data);
		this.update();
	}

	invalidate(): void {
		// Pages render from state on every frame; theme colors are applied at render time.
	}
}

/** Navigation between W&B pages: projects → runs → run → charts or files. */
class WandbBrowser {
	private readonly view: WandbView;
	private readonly client: WandbClient;
	private readonly viewer: WandbViewer;

	constructor(view: WandbView, client: WandbClient, viewer: WandbViewer) {
		this.view = view;
		this.client = client;
		this.viewer = viewer;
	}

	open(target: WandbTarget): void {
		this.openProjects();
		if (!target.project) return;
		const entity = target.entity ?? this.viewer.entity;
		this.openRuns(entity, target.project);
		if (target.run) this.openRun(entity, target.project, target.run);
	}

	private openProjects(): void {
		const page = this.view.push(
			new ListPage(this.view, "Projects", {
				openHint: "open",
				onOpen: (item) => {
					const [entity, project] = item.key.split("/");
					this.openRuns(entity!, project!);
				},
			}),
		);
		const entities = [...new Set([this.viewer.entity, this.viewer.username, ...this.viewer.teams])];
		page.load(async (signal) => {
			const projects = (await Promise.all(entities.map((entity) => this.client.projects(entity, signal)))).flat();
			projects.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
			page.setItems(
				projects.map((project) => ({
					key: `${project.entity}/${project.name}`,
					label: `${project.entity}/${project.name}`,
					detail: `${project.runCount} run${project.runCount === 1 ? "" : "s"} · created ${age(project.createdAt)}`,
				})),
				"No projects",
			);
		});
	}

	private openRuns(entity: string, project: string): void {
		const COMPARE = "\0compare";
		const MORE = "\0more";
		const marked = new Map<string, WandbRunSummary>();
		let runs: WandbRunSummary[] = [];
		let cursor: string | undefined;
		let loadingMore = false;
		const refresh = () =>
			page.setItems(
				[
					...(marked.size > 0
						? [
								{
									key: COMPARE,
									label: `Compare ${marked.size} marked run${marked.size === 1 ? "" : "s"}`,
									pinned: true,
								},
							]
						: []),
					...runs.map((run) => ({
						key: run.name,
						label: run.displayName,
						detail: [run.state, age(run.createdAt), run.user].filter(Boolean).join(" · "),
						marked: marked.has(run.name),
					})),
					...(cursor
						? [{ key: MORE, label: loadingMore ? "Loading more runs…" : "Load more runs…", pinned: true }]
						: []),
				],
				"No runs",
			);
		const loadPage = () => {
			if (loadingMore) return;
			loadingMore = true;
			if (runs.length > 0) refresh();
			page.load(async (signal) => {
				try {
					const next = await this.client.runs(entity, project, { first: RUN_PAGE_SIZE, after: cursor }, signal);
					runs = [...runs, ...next.runs];
					cursor = next.nextCursor;
				} finally {
					loadingMore = false;
				}
				refresh();
			});
		};
		const page = this.view.push(
			new ListPage(this.view, project, {
				openHint: "open",
				onOpen: (item) => {
					if (item.key === COMPARE) this.openCompare(entity, project, [...marked.values()]);
					else if (item.key === MORE) loadPage();
					else this.openRun(entity, project, item.key, item.label);
				},
				onMark: (item) => {
					const run = runs.find((candidate) => candidate.name === item.key);
					if (!run) return;
					if (marked.has(run.name)) marked.delete(run.name);
					else marked.set(run.name, run);
					refresh();
				},
			}),
		);
		loadPage();
	}

	private openRun(entity: string, project: string, run: string, displayName = run): void {
		let details: WandbRunDetails | undefined;
		const page = this.view.push(
			new ListPage(this.view, displayName, {
				openHint: "open",
				onOpen: (item) => {
					if (!details) return;
					if (item.key === "charts") this.openMetrics([details], "Charts");
					else if (item.key === "files") this.openFiles(details, "");
					else if (item.key === "summary") this.openJson("Summary", details.summary);
					else if (item.key === "config") this.openJson("Config", details.config);
					else if (item.key === "web") openBrowser(this.client.webUrl(entity, project, run));
				},
			}),
		);
		page.load(async (signal) => {
			details = await this.client.run(entity, project, run, signal);
			page.title = details.displayName;
			const summaryCount = Object.keys(details.summary).filter((key) => !key.startsWith("_")).length;
			page.setItems([
				{ key: "charts", label: "Charts", detail: `${details.metrics.length} metrics` },
				{ key: "files", label: "Files", detail: `${details.files.length} files` },
				{ key: "summary", label: "Summary", detail: `${summaryCount} values` },
				{ key: "config", label: "Config", detail: `${Object.keys(details.config).length} keys` },
				{ key: "web", label: "Open in browser", detail: `${details.state} · ${age(details.createdAt)}` },
			]);
		});
	}

	private openCompare(entity: string, project: string, runs: WandbRunSummary[]): void {
		let loaded: WandbRunDetails[] = [];
		const page = this.view.push(
			new ListPage(
				this.view,
				`Compare ${runs.length}`,
				this.metricOptions(() => loaded),
			),
		);
		page.load(async (signal) => {
			// Run details carry each run's metric keys.
			loaded = await Promise.all(runs.map((run) => this.client.run(entity, project, run.name, signal)));
			page.setItems(this.metricItems(loaded), "The marked runs logged no numeric metrics");
		});
	}

	private metricOptions(runs: () => WandbRunDetails[]): ListOptions {
		return {
			openHint: "chart",
			onOpen: (item) => {
				const loaded = runs();
				const metrics = this.metricItems(loaded).map((metric) => metric.key);
				const index = metrics.indexOf(item.key);
				if (index >= 0) this.view.push(new ChartPage(this.view, this.client, loaded, metrics, index));
			},
		};
	}

	private metricItems(runs: WandbRunDetails[]): ListItem[] {
		const metrics = [...new Set(runs.flatMap((run) => run.metrics))].sort((left, right) => left.localeCompare(right));
		return metrics.map((metric) => {
			if (runs.length > 1) {
				const count = runs.filter((run) => run.metrics.includes(metric)).length;
				return { key: metric, label: metric, detail: `${count}/${runs.length} runs` };
			}
			const value = runs[0]?.summary[metric];
			return {
				key: metric,
				label: metric,
				detail: typeof value === "number" ? formatChartNumber(value) : undefined,
			};
		});
	}

	private openMetrics(runs: WandbRunDetails[], title: string): void {
		const page = this.view.push(
			new ListPage(
				this.view,
				title,
				this.metricOptions(() => runs),
			),
		);
		page.setItems(this.metricItems(runs), "This run logged no numeric metrics");
	}

	private openJson(title: string, value: Record<string, unknown>): void {
		const shown = Object.fromEntries(Object.entries(value).filter(([key]) => key !== "_wandb"));
		this.view.push(new TextPage(this.view, title)).setText(JSON.stringify(shown, null, 2));
	}

	private openFiles(run: WandbRunDetails, prefix: string): void {
		const directories = new Map<string, number>();
		const files: WandbFile[] = [];
		for (const file of run.files) {
			if (!file.name.startsWith(prefix)) continue;
			const rest = file.name.slice(prefix.length);
			const slash = rest.indexOf("/");
			if (slash < 0) files.push(file);
			else {
				const directory = rest.slice(0, slash + 1);
				directories.set(directory, (directories.get(directory) ?? 0) + 1);
			}
		}
		const byName = new Map(files.map((file) => [file.name, file]));
		const title = prefix ? `${prefix.slice(0, -1).split("/").pop()}/` : "Files";
		const page = this.view.push(
			new ListPage(this.view, title, {
				openHint: "open",
				onOpen: (item) => {
					const file = byName.get(item.key);
					if (file) this.openFile(file);
					else this.openFiles(run, item.key);
				},
			}),
		);
		page.setItems(
			[
				...[...directories]
					.sort(([left], [right]) => left.localeCompare(right))
					.map(([directory, count]) => ({
						key: `${prefix}${directory}`,
						label: directory,
						detail: `${count} file${count === 1 ? "" : "s"}`,
					})),
				...files
					.sort((left, right) => left.name.localeCompare(right.name))
					.map((file) => ({
						key: file.name,
						label: file.name.slice(prefix.length),
						detail: formatSize(file.sizeBytes),
					})),
			],
			"No files",
		);
	}

	private openFile(file: WandbFile): void {
		const extension = file.name.split(".").pop()?.toLowerCase() ?? "";
		const imageType = IMAGE_TYPES[extension];
		if (imageType) {
			const page = this.view.push(new ImagePage(this.view, file, imageType));
			page.load(async (signal) => {
				page.setData((await this.client.download(file, MAX_IMAGE_BYTES, signal)).toString("base64"));
			});
			return;
		}
		const page = this.view.push(new TextPage(this.view, file.name.split("/").pop() ?? file.name, file.directUrl));
		page.load(async (signal) => {
			if (file.sizeBytes > MAX_TEXT_BYTES) {
				page.setText(
					`${file.name} is ${formatSize(file.sizeBytes)}, too large to preview. Press o to download it.`,
				);
				return;
			}
			const data = await this.client.download(file, MAX_TEXT_BYTES, signal);
			if (data.subarray(0, 8000).includes(0)) {
				page.setText(`${file.name} is binary (${formatSize(file.sizeBytes)}). Press o to download it.`);
				return;
			}
			const text = data.toString("utf8");
			if (extension !== "json") {
				page.setText(text);
				return;
			}
			try {
				page.setText(JSON.stringify(JSON.parse(text), null, 2));
			} catch {
				page.setText(text);
			}
		});
	}
}

export async function showWandbBrowser(
	ctx: ExtensionCommandContext,
	client: WandbClient,
	viewer: WandbViewer,
	target: WandbTarget,
): Promise<void> {
	await ctx.ui.custom<void>((tui, theme, keybindings, done) => {
		const view = new WandbView(tui, theme, keybindings, `W&B (${viewer.username})`, () => done());
		new WandbBrowser(view, client, viewer).open(target);
		return view;
	});
}
