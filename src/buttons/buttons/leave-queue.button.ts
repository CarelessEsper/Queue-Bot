import { ButtonStyle, EmbedBuilder } from "discord.js";

import { EveryoneButton } from "../../types/button.types.ts";
import type { ButtonInteraction } from "../../types/interaction.types.ts";
import { Store } from "../../db/store.ts";
import { MemberRemovalReason } from "../../types/db.types.ts";
import { AutoRemoveUtils } from "../../utils/auto-remove.utils.ts";
import { ClientUtils } from "../../utils/client.utils.ts";
import { MemberUtils } from "../../utils/member.utils.ts";
import { queueMention } from "../../utils/string.utils.ts";

export class LeaveQueueButton extends EveryoneButton {
	static readonly ID = "leave-queue";
	static readonly SEPARATOR = ":";

	customId = LeaveQueueButton.ID;
	label = "Leave Queue";
	style = ButtonStyle.Secondary;
	deferResponse = false;

	/**
	 * Format: "leave-queue:<guildId>:<queueId>:<userId>"
	 */
	static buildCustomId(guildId: string, queueId: bigint, userId: string): string {
		return [LeaveQueueButton.ID, guildId, queueId.toString(), userId].join(LeaveQueueButton.SEPARATOR);
	}

	static parseCustomId(customId: string): { guildId: string; queueId: bigint; userId: string } | null {
		const parts = customId.split(LeaveQueueButton.SEPARATOR);
		if (parts.length !== 4 || parts[0] !== LeaveQueueButton.ID) return null;
		try {
			return { guildId: parts[1], queueId: BigInt(parts[2]), userId: parts[3] };
		}
		catch {
			return null;
		}
	}

	async handle(inter: ButtonInteraction) {
		const parsed = LeaveQueueButton.parseCustomId(inter.customId);
		if (!parsed) {
			await inter.respond({ content: "Invalid button data.", ephemeral: true });
			return;
		}

		const { guildId, queueId, userId } = parsed;

		const guild = await ClientUtils.getGuild(guildId);
		if (!guild) {
			await inter.respond({ content: "Could not find the server.", ephemeral: true });
			return;
		}

		const store = new Store(guild);
		const queue = store.dbQueues().get(queueId);
		if (!queue) {
			await inter.update({
				embeds: [new EmbedBuilder().setDescription("That queue no longer exists.")],
				components: [],
			});
			return;
		}

		// Cancel any pending auto-remove timer since they're leaving voluntarily
		AutoRemoveUtils.cancel(queueId, userId);

		// Remove from queue
		await MemberUtils.deleteMembers({
			store,
			queues: [queue],
			reason: MemberRemovalReason.Left,
			by: { userId },
			force: true,
		}).catch(() => null);

		await inter.update({
			embeds: [
				new EmbedBuilder()
					.setColor(queue.color as any)
					.setDescription(`You have left the ${queueMention(queue)} queue.`),
			],
			components: [],
		});
	}
}
