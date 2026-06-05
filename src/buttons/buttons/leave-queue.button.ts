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

	/**
	 * Format: "leave-queue:<guildId>:all:<userId>"
	 */
	static buildAllQueuesCustomId(guildId: string, userId: string): string {
		return [LeaveQueueButton.ID, guildId, "all", userId].join(LeaveQueueButton.SEPARATOR);
	}

	static parseCustomId(customId: string): { guildId: string; queueId: bigint | null; userId: string } | null {
		const parts = customId.split(LeaveQueueButton.SEPARATOR);
		if (parts.length !== 4 || parts[0] !== LeaveQueueButton.ID) return null;
		try {
			return {
				guildId: parts[1],
				queueId: parts[2] === "all" ? null : BigInt(parts[2]),
				userId: parts[3],
			};
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

		if (queueId === null) {
			// Leave all auto-remove queues
			const queuesLeft: string[] = [];
			for (const queue of store.dbQueues().values()) {
				if (!queue.autoRemovePeriod || queue.autoRemovePeriod <= 0n) continue;
				const member = store.dbMembers().find(m => m.queueId === queue.id && m.userId === userId);
				if (!member) continue;
				AutoRemoveUtils.cancel(queue.id, userId);
				await MemberUtils.deleteMembers({
					store,
					queues: [queue],
					reason: MemberRemovalReason.Left,
					by: { userId },
					force: true,
				}).catch(() => null);
				queuesLeft.push(queueMention(queue));
			}

			await inter.update({
				embeds: [new EmbedBuilder().setDescription(
					queuesLeft.length
						? `You have left: ${queuesLeft.join(", ")}.`
						: "You were no longer in any queues."
				)],
				components: [],
			});
		}
		else {
			const queue = store.dbQueues().get(queueId);
			if (!queue) {
				await inter.update({ embeds: [new EmbedBuilder().setDescription("That queue no longer exists.")], components: [] });
				return;
			}

			AutoRemoveUtils.cancel(queueId, userId);

			await MemberUtils.deleteMembers({
				store,
				queues: [queue],
				reason: MemberRemovalReason.Left,
				by: { userId },
				force: true,
			}).catch(() => null);

			await inter.update({
				embeds: [new EmbedBuilder().setColor(queue.color as any).setDescription(`You have left the ${queueMention(queue)} queue.`)],
				components: [],
			});
		}
	}
}
