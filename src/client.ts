import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const DEFAULT_BASE_URL = "https://api.wandb.ai";
const PROJECT_PAGE_SIZE = 100;
const FILE_PAGE_SIZE = 500;
/** Keys W&B records for every history row. They are axes, not metrics. */
const INTERNAL_HISTORY_KEY = /^_/;

export interface WandbViewer {
	username: string;
	/** Default entity of the API key. */
	entity: string;
	teams: string[];
}

export interface WandbProject {
	entity: string;
	name: string;
	runCount: number;
	createdAt: string;
}

export interface WandbRunSummary {
	/** Run ID, the last path segment of the run's URL. */
	name: string;
	displayName: string;
	state: string;
	createdAt: string;
	user: string | undefined;
}

export interface WandbRunPage {
	runs: WandbRunSummary[];
	nextCursor: string | undefined;
}

export interface WandbFile {
	/** Path within the run, such as `media/images/plot_3_abc.png`. */
	name: string;
	sizeBytes: number;
	mimetype: string | undefined;
	/** Signed download URL; needs no credentials. */
	directUrl: string;
}

export interface WandbRunDetails extends WandbRunSummary {
	entity: string;
	project: string;
	/** Numeric history keys, sorted, without W&B's internal `_step`, `_runtime`, and `_timestamp`. */
	metrics: string[];
	summary: Record<string, unknown>;
	config: Record<string, unknown>;
	files: WandbFile[];
}

/** One sampled history point of a metric. */
export interface WandbPoint {
	step: number;
	value: number;
}

export interface WandbCredentials {
	baseUrl: string;
	apiKey: string;
}

/** Parses the password of `machine` from a .netrc file. */
export function netrcPassword(netrc: string, machine: string): string | undefined {
	const tokens = netrc.split(/\s+/).filter(Boolean);
	let current: string | undefined;
	for (let index = 0; index < tokens.length; index++) {
		const token = tokens[index];
		if (token === "machine") current = tokens[++index];
		else if (token === "default") current = undefined;
		else if (token === "password" && current === machine) return tokens[index + 1];
	}
	return undefined;
}

/**
 * Credentials as the wandb CLI resolves them: `WANDB_API_KEY`, else the `wandb login` entry in ~/.netrc
 * (or `NETRC`). `WANDB_BASE_URL` selects a dedicated or self-hosted server.
 */
export async function resolveWandbCredentials(env: NodeJS.ProcessEnv = process.env): Promise<WandbCredentials> {
	const baseUrl = (env.WANDB_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, "");
	const fromEnv = env.WANDB_API_KEY?.trim();
	if (fromEnv) return { baseUrl, apiKey: fromEnv };
	const netrcPath = env.NETRC || join(homedir(), ".netrc");
	const netrc = await readFile(netrcPath, "utf8").catch(() => "");
	const apiKey = netrcPassword(netrc, new URL(baseUrl).hostname);
	if (!apiKey) {
		throw new Error(`No W&B API key. Run \`wandb login\` or set WANDB_API_KEY (looked in ${netrcPath}).`);
	}
	return { baseUrl, apiKey };
}

interface Connection<T> {
	edges: Array<{ node: T }>;
	pageInfo: { hasNextPage: boolean; endCursor: string | null };
}

interface RawRun {
	name: string;
	displayName: string | null;
	state: string;
	createdAt: string;
	user: { username: string } | null;
}

const RUN_FIELDS = "name displayName state createdAt user { username }";

function toRunSummary(run: RawRun): WandbRunSummary {
	return {
		name: run.name,
		displayName: run.displayName || run.name,
		state: run.state,
		createdAt: run.createdAt,
		user: run.user?.username,
	};
}

/** W&B returns some JSON fields as objects (`historyKeys`) and others as JSON strings (`summaryMetrics`, `config`). */
function jsonObject(field: unknown): Record<string, unknown> {
	let value = field;
	if (typeof value === "string") {
		try {
			value = JSON.parse(value);
		} catch {
			return {};
		}
	}
	return value && typeof value === "object" && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : {};
}

/** Numeric, user-logged keys from a run's `historyKeys`. */
function numericHistoryKeys(historyKeys: unknown): string[] {
	const keys = jsonObject(historyKeys).keys;
	if (!keys || typeof keys !== "object") return [];
	const isNumeric = (info: unknown) =>
		!!info &&
		typeof info === "object" &&
		"typeCounts" in info &&
		Array.isArray(info.typeCounts) &&
		info.typeCounts.some(
			(count: unknown) => !!count && typeof count === "object" && "type" in count && count.type === "number",
		);
	return Object.entries(keys)
		.filter(([key, info]) => !INTERNAL_HISTORY_KEY.test(key) && isNumeric(info))
		.map(([key]) => key)
		.sort((left, right) => left.localeCompare(right));
}

export class WandbClient {
	readonly baseUrl: string;
	private readonly authorization: string;

	constructor(credentials: WandbCredentials) {
		this.baseUrl = credentials.baseUrl;
		this.authorization = `Basic ${Buffer.from(`api:${credentials.apiKey}`).toString("base64")}`;
	}

	/** Web UI URL of a project or run, for the app's own server or wandb.ai. */
	webUrl(entity: string, project: string, run?: string): string {
		const host = this.baseUrl === DEFAULT_BASE_URL ? "https://wandb.ai" : this.baseUrl;
		return `${host}/${entity}/${project}${run ? `/runs/${run}` : ""}`;
	}

	private async query<T>(query: string, variables: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
		const response = await fetch(`${this.baseUrl}/graphql`, {
			method: "POST",
			headers: { authorization: this.authorization, "content-type": "application/json" },
			body: JSON.stringify({ query, variables }),
			signal,
		});
		if (response.status === 401) throw new Error("W&B rejected the API key. Run `wandb login --relogin`.");
		if (!response.ok) throw new Error(`W&B API returned ${response.status} ${response.statusText}`);
		const payload = (await response.json()) as { data?: T; errors?: Array<{ message: string }> };
		if (payload.errors?.length) throw new Error(payload.errors.map((error) => error.message).join("; "));
		if (!payload.data) throw new Error("W&B API returned no data");
		return payload.data;
	}

	async viewer(signal?: AbortSignal): Promise<WandbViewer> {
		const data = await this.query<{
			viewer: { username: string; entity: string; teams: Connection<{ name: string }> } | null;
		}>("query { viewer { username entity teams { edges { node { name } } } } }", {}, signal);
		if (!data.viewer) throw new Error("W&B API key has no user");
		return {
			username: data.viewer.username,
			entity: data.viewer.entity,
			teams: data.viewer.teams.edges.map((edge) => edge.node.name),
		};
	}

	/** All projects of an entity, newest first. */
	async projects(entity: string, signal?: AbortSignal): Promise<WandbProject[]> {
		const projects: WandbProject[] = [];
		let cursor: string | null = null;
		do {
			const data: { projects: Connection<Omit<WandbProject, "entity">> | null } = await this.query(
				`query ($entity: String!, $first: Int!, $after: String) {
					projects(entityName: $entity, first: $first, after: $after, order: "-createdAt") {
						edges { node { name runCount createdAt } }
						pageInfo { hasNextPage endCursor }
					}
				}`,
				{ entity, first: PROJECT_PAGE_SIZE, after: cursor },
				signal,
			);
			if (!data.projects) break;
			for (const edge of data.projects.edges) projects.push({ entity, ...edge.node });
			cursor = data.projects.pageInfo.hasNextPage ? data.projects.pageInfo.endCursor : null;
		} while (cursor);
		return projects;
	}

	/** One page of runs, newest first. */
	async runs(
		entity: string,
		project: string,
		options: { first: number; after?: string },
		signal?: AbortSignal,
	): Promise<WandbRunPage> {
		const data = await this.query<{ project: { runs: Connection<RawRun> } | null }>(
			`query ($entity: String!, $project: String!, $first: Int!, $after: String) {
				project(entityName: $entity, name: $project) {
					runs(first: $first, after: $after, order: "-created_at") {
						edges { node { ${RUN_FIELDS} } }
						pageInfo { hasNextPage endCursor }
					}
				}
			}`,
			{ entity, project, first: options.first, after: options.after ?? null },
			signal,
		);
		if (!data.project) throw new Error(`Project ${entity}/${project} not found`);
		const { edges, pageInfo } = data.project.runs;
		return {
			runs: edges.map((edge) => toRunSummary(edge.node)),
			nextCursor: pageInfo.hasNextPage ? (pageInfo.endCursor ?? undefined) : undefined,
		};
	}

	async run(entity: string, project: string, run: string, signal?: AbortSignal): Promise<WandbRunDetails> {
		type RawDetails = RawRun & {
			historyKeys: unknown;
			summaryMetrics: unknown;
			config: unknown;
			files: Connection<{ name: string; sizeBytes: number; mimetype: string | null; directUrl: string }>;
		};
		let details: RawDetails | undefined;
		const files: WandbFile[] = [];
		let cursor: string | null = null;
		do {
			const data: { project: { run: RawDetails | null } | null } = await this.query(
				`query ($entity: String!, $project: String!, $run: String!, $first: Int!, $after: String) {
					project(entityName: $entity, name: $project) {
						run(name: $run) {
							${RUN_FIELDS} historyKeys summaryMetrics config
							files(first: $first, after: $after) {
								edges { node { name sizeBytes mimetype directUrl } }
								pageInfo { hasNextPage endCursor }
							}
						}
					}
				}`,
				{ entity, project, run, first: FILE_PAGE_SIZE, after: cursor },
				signal,
			);
			const raw = data.project?.run;
			if (!raw) throw new Error(`Run ${entity}/${project}/${run} not found`);
			details ??= raw;
			for (const edge of raw.files.edges) {
				files.push({ ...edge.node, mimetype: edge.node.mimetype ?? undefined });
			}
			cursor = raw.files.pageInfo.hasNextPage ? raw.files.pageInfo.endCursor : null;
		} while (cursor);
		// W&B stores config values as `{ value, desc }`; show the values.
		const config = Object.fromEntries(
			Object.entries(jsonObject(details.config))
				.filter(([key]) => !key.startsWith("_"))
				.map(([key, entry]) => [key, entry && typeof entry === "object" && "value" in entry ? entry.value : entry]),
		);
		return {
			...toRunSummary(details),
			entity,
			project,
			metrics: numericHistoryKeys(details.historyKeys),
			summary: jsonObject(details.summaryMetrics),
			config,
			files,
		};
	}

	/** Up to `samples` history points of `metric`, sampled across the run like the W&B charts, in step order. */
	async history(
		entity: string,
		project: string,
		run: string,
		metric: string,
		samples: number,
		signal?: AbortSignal,
	): Promise<WandbPoint[]> {
		const data = await this.query<{
			project: { run: { sampledHistory: Array<Array<Record<string, unknown>>> } | null } | null;
		}>(
			`query ($entity: String!, $project: String!, $run: String!, $specs: [JSONString!]!) {
				project(entityName: $entity, name: $project) { run(name: $run) { sampledHistory(specs: $specs) } }
			}`,
			{ entity, project, run, specs: [JSON.stringify({ keys: ["_step", metric], samples })] },
			signal,
		);
		const rows = data.project?.run?.sampledHistory[0] ?? [];
		const points: WandbPoint[] = [];
		for (const row of rows) {
			const step = row._step;
			const value = row[metric];
			if (typeof step === "number" && typeof value === "number" && Number.isFinite(value)) {
				points.push({ step, value });
			}
		}
		return points.sort((left, right) => left.step - right.step);
	}

	/** Downloads a run file. Rejects files larger than `maxBytes` before reading them. */
	async download(file: WandbFile, maxBytes: number, signal?: AbortSignal): Promise<Buffer> {
		if (file.sizeBytes > maxBytes) throw new Error(`File is larger than ${maxBytes} bytes`);
		const response = await fetch(file.directUrl, { signal });
		if (!response.ok) throw new Error(`Download failed: ${response.status} ${response.statusText}`);
		return Buffer.from(await response.arrayBuffer());
	}
}
