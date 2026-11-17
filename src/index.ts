import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { resolveWandbCredentials, WandbClient } from "./client.ts";
import { showWandbBrowser, type WandbTarget } from "./ui.ts";

/**
 * Parses `/wandb` arguments: nothing, `project`, `entity/project`, `entity/project/run`, or a W&B project or run URL.
 */
export function parseWandbTarget(args: string): WandbTarget {
	const value = args.trim();
	if (!value) return {};
	if (/^https?:\/\//.test(value)) {
		// https://wandb.ai/<entity>/<project>/runs/<run>?…, or a project page such as …/<project>/workspace
		const [entity, project, section, run] = new URL(value).pathname.split("/").filter(Boolean);
		return { entity, project, run: section === "runs" ? run : undefined };
	}
	const segments = value.split("/").filter(Boolean);
	if (segments.length === 1) return { project: segments[0] };
	const [entity, project, run] = segments;
	return { entity, project, run };
}

export default function wandbExtension(pi: ExtensionAPI): void {
	pi.registerCommand("wandb", {
		description: "Browse W&B projects, runs, charts, and files",
		handler: async (args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/wandb is available in interactive mode", "warning");
				return;
			}
			let target: WandbTarget;
			try {
				target = parseWandbTarget(args);
			} catch {
				ctx.ui.notify(`Not a W&B project or run: ${args.trim()}`, "error");
				return;
			}
			try {
				const client = new WandbClient(await resolveWandbCredentials());
				const viewer = await client.viewer(ctx.signal);
				await showWandbBrowser(ctx, client, viewer, target);
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});
}
