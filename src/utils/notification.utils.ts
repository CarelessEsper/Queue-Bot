import { type GuildTextBasedChannel, userMention } from "discord.js";

import type { DbMember, DbQueue } from "../db/schema.ts";
import type { Store } from "../db/store.ts";
import { NotificationAction } from "../types/notification.types.ts";

export namespace NotificationUtils {
	/**
	 * Sends a notification message in the given channel tagging each pulled member.
	 * Mentions must be in message content (not embeds) to actually ping users.
	 * Falls back to the interaction channel if no messageChannelId is provided.
	 */
	export async function notifyMembers(options: {
		store: Store,
		queue: DbQueue,
		action: NotificationAction,
		members: DbMember[],
		messageChannelId?: string,
	}) {
		const { store, queue, action, members, messageChannelId } = options;

		const channelId = messageChannelId ?? store.inter?.channelId;
		if (!channelId) return;

		const channel = await store.jsChannel(channelId) as GuildTextBasedChannel;
		if (!channel) return;

		const mentions = members.map(m => userMention(m.userId)).join(" ");
		let content = `${mentions} — you were ${action} the **${queue.name}** queue.`;
		if (queue.pullMessage) {
			content += `\n> ${queue.pullMessage}`;
		}

		await channel.send({ content }).catch(e =>
			console.error(`[NotificationUtils] Failed to send notification in channel ${channelId}:`, e)
		);
	}
}
