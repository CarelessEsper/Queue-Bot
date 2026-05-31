import { type AnyThreadChannel, ChannelType, EmbedBuilder } from "discord.js";

import type { DbQueue } from "../db/schema.ts";
import type { ArrayOrCollection } from "../types/misc.types.ts";
import { CustomError } from "./error.utils.ts";
import { map } from "./misc.utils.ts";
import { queueMention } from "./string.utils.ts";

export namespace QueueTagUtils {
	/**
	 * Verify that the interaction channel (if a forum thread) has the required tag
	 * for each queue being pulled from. Throws if any queue's tag requirement is unmet.
	 *
	 * If the channel is not a forum thread, or a queue has no tagId set, the check
	 * passes silently.
	 */
	export function verifyForumTagAccess(queues: ArrayOrCollection<bigint, DbQueue>, channel: AnyThreadChannel | null) {
		// Only applies to public/private thread channels (forum posts)
		if (!channel || (channel.type !== ChannelType.PublicThread && channel.type !== ChannelType.PrivateThread)) return;

		const appliedTagIds: string[] = (channel as any).appliedTags ?? [];

		for (const queue of map(queues, q => q)) {
			if (!queue.tagId) continue;

			if (!appliedTagIds.includes(queue.tagId)) {
				throw new CustomError({
					message: "Forum tag requirement not met",
					embeds: [
						new EmbedBuilder().setDescription(
							`You cannot pull from the ${queueMention(queue)} queue in this forum post.\n` +
							`This queue requires the forum tag \`${queue.tagId}\` to be applied.`
						),
					],
				});
			}
		}
	}
}
