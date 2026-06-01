import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, type GuildTextBasedChannel, userMention } from "discord.js";

import { AdminButton } from "../../types/button.types.ts";
import { MemberRemovalReason, PullMessageDisplayType } from "../../types/db.types.ts";
import type { ButtonInteraction } from "../../types/interaction.types.ts";
import { MemberUtils } from "../../utils/member.utils.ts";
import { LoggingUtils } from "../../utils/message-utils/logging.utils.ts";
import { queueMention } from "../../utils/string.utils.ts";

export class UndoPullButton extends AdminButton {
	static readonly ID = "undo-pull";
	static readonly SEPARATOR = ":";
	static readonly USER_SEPARATOR = ",";

	customId = UndoPullButton.ID;
	label = "Undo Pull";
	style = ButtonStyle.Secondary;

	/**
	 * Format: "undo-pull:<guildId>:<queueId>:<userId1>,<userId2>,..."
	 * Messages are not encoded — they are retrieved from dbArchivedMembers at restore time.
	 * Returns null if the resulting customId would exceed Discord's 100-char limit.
	 */
	static buildCustomId(guildId: string, queueId: bigint, userIds: string[]): string | null {
		const id = [
			UndoPullButton.ID,
			guildId,
			queueId.toString(),
			userIds.join(UndoPullButton.USER_SEPARATOR),
		].join(UndoPullButton.SEPARATOR);
		return id.length <= 100 ? id : null;
	}

	static parseCustomId(customId: string): {
		guildId: string;
		queueId: bigint;
		userIds: string[];
	} | null {
		const sep = UndoPullButton.SEPARATOR;
		const prefix = UndoPullButton.ID + sep;
		if (!customId.startsWith(prefix)) return null;
		const rest = customId.slice(prefix.length);
		const firstColon = rest.indexOf(sep);
		const secondColon = rest.indexOf(sep, firstColon + 1);
		if (firstColon === -1 || secondColon === -1) return null;
		try {
			const guildId = rest.slice(0, firstColon);
			const queueId = BigInt(rest.slice(firstColon + 1, secondColon));
			const userIds = rest.slice(secondColon + 1).split(UndoPullButton.USER_SEPARATOR);
			return { guildId, queueId, userIds };
		}
		catch {
			return null;
		}
	}

	/** Build an ActionRow containing the undo button, or null if the customId would exceed 100 chars. */
	static buildRow(guildId: string, queueId: bigint, userIds: string[]): ActionRowBuilder<ButtonBuilder> | null {
		const customId = UndoPullButton.buildCustomId(guildId, queueId, userIds);
		if (!customId) return null;
		const button = new ButtonBuilder()
			.setCustomId(customId)
			.setLabel("Undo Pull")
			.setStyle(ButtonStyle.Secondary);
		return new ActionRowBuilder<ButtonBuilder>().addComponents(button);
	}

	async handle(inter: ButtonInteraction) {
		const parsed = UndoPullButton.parseCustomId(inter.customId);
		if (!parsed) {
			await inter.respond("Invalid button data.");
			return;
		}

		const { queueId, userIds } = parsed;
		const store = inter.store;
		const queue = store.dbQueues().get(queueId);

		if (!queue) {
			await inter.respond("That queue no longer exists.");
			return;
		}

		const restored: string[] = [];
		for (const userId of userIds) {
			const jsMember = await store.jsMember(userId);
			if (!jsMember) continue;

			// Retrieve the original message from the archived member record
			const archived = store.dbArchivedMembers().find(
				m => m.queueId === queueId && m.userId === userId && m.reason === MemberRemovalReason.Pulled
			);

			await MemberUtils.restoreMember({
				store,
				queue,
				jsMember,
				message: archived?.message,
			}).catch(() => null);

			restored.push(userId);
		}

		if (restored.length === 0) {
			await inter.respond("No members could be restored (they may have already rejoined or left the server).");
			return;
		}

		const membersStr = restored.map(userId => `- ${userMention(userId)}`).join("\n");

		const embed = new EmbedBuilder()
			.setColor(queue.color as any)
			.setTitle(queueMention(queue))
			.setDescription(`Restored to their original position in the queue:\n${membersStr}`);

		const messageToSend = { embeds: [embed], components: [] };

		// Remove the undo button from the original pull message
		await inter.editReply({ components: [] }).catch(() => null);

		if (queue.pullMessageDisplayType === PullMessageDisplayType.Public) {
			const channel = inter.channel as GuildTextBasedChannel;
			if (channel) {
				const sentMessage = await channel.send(messageToSend).catch(() => null);
				LoggingUtils.log(store, true, sentMessage).catch(() => null);
			}
		}
		else {
			await inter.respond(messageToSend, true);
		}
	}
}
