import { ButtonStyle, EmbedBuilder } from "discord.js";

import { EveryoneButton } from "../../types/button.types.ts";
import type { ButtonInteraction } from "../../types/interaction.types.ts";
import { AutoRemoveUtils } from "../../utils/auto-remove.utils.ts";
import { ClientUtils } from "../../utils/client.utils.ts";
import { queueMention, timeMention } from "../../utils/string.utils.ts";

export class ExtendStayButton extends EveryoneButton {
	static readonly ID = "extend-stay";
	static readonly SEPARATOR = ":";

	customId = ExtendStayButton.ID;
	label = "Extend Stay";
	style = ButtonStyle.Success;
	deferResponse = false;

	/**
	 * Build a customId encoding the context needed to extend a member's stay.
	 * Format: "extend-stay:<guildId>:<queueId>:<userId>"
	 */
	static buildCustomId(guildId: string, queueId: bigint, userId: string): string {
		return [ExtendStayButton.ID, guildId, queueId.toString(), userId].join(ExtendStayButton.SEPARATOR);
	}

	/**
	 * Parse a customId back into its components.
	 */
	static parseCustomId(customId: string): { guildId: string; queueId: bigint; userId: string } | null {
		const parts = customId.split(ExtendStayButton.SEPARATOR);
		if (parts.length !== 4 || parts[0] !== ExtendStayButton.ID) return null;
		try {
			return { guildId: parts[1], queueId: BigInt(parts[2]), userId: parts[3] };
		}
		catch {
			return null;
		}
	}

	async handle(inter: ButtonInteraction) {
		const parsed = ExtendStayButton.parseCustomId(inter.customId);
		if (!parsed) {
			await inter.reply({ content: "Invalid button data.", ephemeral: true });
			return;
		}

		const { guildId, queueId, userId } = parsed;

		const guild = await ClientUtils.getGuild(guildId);
		if (!guild) {
			await inter.reply({ content: "Could not find the server.", ephemeral: true });
			return;
		}

		const { Store } = await import("../../db/store.ts");
		const store = new Store(guild);

		const queue = store.dbQueues().get(queueId);
		if (!queue) {
			await inter.reply({ content: "That queue no longer exists.", ephemeral: true });
			return;
		}

		// Confirm the member is still in the queue
		const member = store.dbMembers().find(m => m.queueId === queueId && m.userId === userId);
		if (!member) {
			await inter.reply({ content: `You are no longer in the ${queueMention(queue)} queue.`, ephemeral: true });
			return;
		}

		// Re-schedule for another full period
		const periodMs = Number(queue.autoRemovePeriod) * 1000;
		AutoRemoveUtils.schedule(guildId, queueId, userId, periodMs);

		await inter.update({
			embeds: [
				new EmbedBuilder()
					.setColor(queue.color as any)
					.setDescription(`✅ Your stay in the ${queueMention(queue)} queue has been extended by ${timeMention(queue.autoRemovePeriod)}.`),
			],
			components: [],
		});
	}
}
