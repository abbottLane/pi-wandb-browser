import type { WandbPoint } from "./client.ts";

export interface ChartSeries {
	label: string;
	/** Colors the series' braille cells and legend entry. */
	color: (text: string) => string;
	/** Points in step order. */
	points: readonly WandbPoint[];
}

export interface ChartStyle {
	/** Axis lines and tick labels. */
	axis: (text: string) => string;
}

const Y_TICKS = 5;
/** Braille dot bits by [row][column] within a 2x4 cell. */
const BRAILLE_BITS = [
	[0x01, 0x08],
	[0x02, 0x10],
	[0x04, 0x20],
	[0x40, 0x80],
] as const;

/** Compact number label: four significant digits, exponent notation for very large or small magnitudes. */
export function formatChartNumber(value: number): string {
	if (value === 0) return "0";
	const magnitude = Math.abs(value);
	if (magnitude >= 1e6 || magnitude < 1e-3) return value.toExponential(2).replace(/\.?0+e/, "e");
	return String(Number(value.toPrecision(4)));
}

function range(values: Iterable<number>): { min: number; max: number } | undefined {
	let min = Number.POSITIVE_INFINITY;
	let max = Number.NEGATIVE_INFINITY;
	for (const value of values) {
		if (value < min) min = value;
		if (value > max) max = value;
	}
	return min <= max ? { min, max } : undefined;
}

/**
 * Renders series as a braille line chart with a labeled y axis on the left and steps along the bottom.
 * Returns exactly `height` lines, each at most `width` columns. Where series overlap in a cell, the later one's
 * color wins.
 */
export function renderLineChart(
	series: readonly ChartSeries[],
	width: number,
	height: number,
	style: ChartStyle,
): string[] {
	const steps = range(series.flatMap((s) => s.points.map((p) => p.step)));
	const values = range(series.flatMap((s) => s.points.map((p) => p.value)));
	const lines: string[] = [];
	const finish = () => {
		while (lines.length < height) lines.push("");
		return lines.slice(0, height);
	};
	if (!steps || !values) {
		lines.push(style.axis("No numeric values logged"));
		return finish();
	}

	// A flat series gets a band around its value, so it draws as a line through the middle.
	let { min: yMin, max: yMax } = values;
	if (yMin === yMax) {
		const pad = Math.abs(yMin) * 0.05 || 1;
		yMin -= pad;
		yMax += pad;
	}
	const plotRows = height - 2;
	const tickRows = new Map<number, string>();
	for (let tick = 0; tick < Y_TICKS; tick++) {
		const row = Math.round((tick * (plotRows - 1)) / (Y_TICKS - 1));
		tickRows.set(row, formatChartNumber(yMax - ((yMax - yMin) * row) / Math.max(1, plotRows - 1)));
	}
	const labelWidth = Math.max(...[...tickRows.values()].map((label) => label.length));
	const plotColumns = width - labelWidth - 2;
	if (plotColumns < 4 || plotRows < 2) {
		lines.push(style.axis("Too small to draw"));
		return finish();
	}

	const dotWidth = plotColumns * 2;
	const dotHeight = plotRows * 4;
	const cells = new Uint8Array(plotColumns * plotRows);
	// Index of the series that last drew into each cell, for its color.
	const owners = new Int16Array(plotColumns * plotRows).fill(-1);
	const toX = (step: number) =>
		steps.max === steps.min
			? Math.floor(dotWidth / 2)
			: Math.round(((step - steps.min) / (steps.max - steps.min)) * (dotWidth - 1));
	const toY = (value: number) => Math.round(((yMax - value) / (yMax - yMin)) * (dotHeight - 1));

	series.forEach((s, seriesIndex) => {
		const plot = (x: number, y: number) => {
			const cell = Math.floor(y / 4) * plotColumns + Math.floor(x / 2);
			cells[cell]! |= BRAILLE_BITS[y % 4]![x % 2];
			owners[cell] = seriesIndex;
		};
		let previous: { x: number; y: number } | undefined;
		for (const point of s.points) {
			const next = { x: toX(point.step), y: toY(point.value) };
			if (!previous) plot(next.x, next.y);
			else {
				// Bresenham from the previous point, so sparse logs still draw a connected line.
				let { x, y } = previous;
				const dx = Math.abs(next.x - x);
				const dy = -Math.abs(next.y - y);
				const sx = x < next.x ? 1 : -1;
				const sy = y < next.y ? 1 : -1;
				let error = dx + dy;
				while (true) {
					plot(x, y);
					if (x === next.x && y === next.y) break;
					const doubled = 2 * error;
					if (doubled >= dy) {
						error += dy;
						x += sx;
					}
					if (doubled <= dx) {
						error += dx;
						y += sy;
					}
				}
			}
			previous = next;
		}
	});

	for (let row = 0; row < plotRows; row++) {
		const tick = tickRows.get(row);
		let line = style.axis(tick ? `${tick.padStart(labelWidth)} ┤` : `${" ".repeat(labelWidth)} │`);
		let run = "";
		let runOwner = -1;
		const flush = () => {
			if (!run) return;
			line += runOwner < 0 ? run : series[runOwner]!.color(run);
			run = "";
		};
		for (let column = 0; column < plotColumns; column++) {
			const cell = row * plotColumns + column;
			const owner = cells[cell] ? owners[cell]! : -1;
			if (owner !== runOwner) flush();
			runOwner = owner;
			run += cells[cell] ? String.fromCharCode(0x2800 + cells[cell]!) : " ";
		}
		flush();
		lines.push(line);
	}

	lines.push(style.axis(`${" ".repeat(labelWidth)} └${"─".repeat(plotColumns)}`));
	const first = formatChartNumber(steps.min);
	const last = formatChartNumber(steps.max);
	const gap = plotColumns - first.length - last.length;
	lines.push(style.axis(`${" ".repeat(labelWidth + 2)}${gap > 0 ? `${first}${" ".repeat(gap)}${last}` : first}`));
	return finish();
}
