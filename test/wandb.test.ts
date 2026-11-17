import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, test } from "vitest";
import { type ChartSeries, renderLineChart } from "../src/chart.ts";
import { netrcPassword } from "../src/client.ts";
import { parseWandbTarget } from "../src/index.ts";

const style = { axis: (text: string) => text };
const series = (points: Array<[number, number]>): ChartSeries => ({
	label: "run",
	color: (text) => text,
	points: points.map(([step, value]) => ({ step, value })),
});
const brailleRows = (lines: string[]) =>
	lines.flatMap((line, row) => ([...line].some((char) => char >= "\u2801" && char <= "\u28ff") ? [row] : []));

describe("renderLineChart", () => {
	test.each([
		["no points", [series([])]],
		["one point", [series([[5, 1]])]],
		[
			"flat series",
			[
				series([
					[0, 3],
					[10, 3],
					[20, 3],
				]),
			],
		],
		[
			"two series",
			[
				series([
					[0, 1],
					[50, 9],
				]),
				series([
					[10, -4],
					[40, 1e7],
				]),
			],
		],
	])("fills exactly the requested area for %s", (_name, input) => {
		const lines = renderLineChart(input, 60, 12, style);
		expect(lines).toHaveLength(12);
		for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(60);
	});

	test("draws a flat series as one horizontal line in the middle", () => {
		const lines = renderLineChart(
			[
				series([
					[0, 3],
					[10, 3],
					[20, 3],
				]),
			],
			60,
			12,
			style,
		);
		const rows = brailleRows(lines);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toBeGreaterThan(2);
		expect(rows[0]).toBeLessThan(8);
	});

	test("connects sparse points into a continuous line", () => {
		const lines = renderLineChart(
			[
				series([
					[0, 0],
					[100, 10],
				]),
			],
			40,
			12,
			style,
		);
		// Every plot row between the endpoints holds part of the diagonal.
		expect(brailleRows(lines)).toEqual(Array.from({ length: 10 }, (_, row) => row));
	});
});

describe("netrcPassword", () => {
	test("reads the password of the matching machine only", () => {
		const netrc = `machine github.com login me password gh-token
machine api.wandb.ai
  login user
  password wandb-key
default login anon password nope`;
		expect(netrcPassword(netrc, "api.wandb.ai")).toBe("wandb-key");
		expect(netrcPassword(netrc, "example.com")).toBeUndefined();
	});
});

describe("parseWandbTarget", () => {
	test("accepts paths and W&B URLs", () => {
		expect(parseWandbTarget("")).toEqual({});
		expect(parseWandbTarget("my-project")).toEqual({ project: "my-project" });
		expect(parseWandbTarget("my-team/my-project")).toEqual({
			entity: "my-team",
			project: "my-project",
			run: undefined,
		});
		expect(parseWandbTarget("https://wandb.ai/my-team/my-project/runs/a1b2c3d4?nw=abc")).toEqual({
			entity: "my-team",
			project: "my-project",
			run: "a1b2c3d4",
		});
		expect(parseWandbTarget("https://wandb.ai/my-team/my-project/workspace?nw=abc")).toEqual({
			entity: "my-team",
			project: "my-project",
			run: undefined,
		});
	});
});
