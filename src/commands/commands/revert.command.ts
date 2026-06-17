import { EmbedBuilder, SlashCommandBuilder, userMention } from "discord.js";

import { Queries } from "../../db/queries.ts";
import { AdminCommand } from "../../types/command.types.ts";
import type { SlashInteraction } from "../../types/interaction.types.ts";
import { MemberUtils } from "../../utils/member.utils.ts";
import { queueMention } from "../../utils/string.utils.ts";

export class RevertCommand extends AdminCommand {
	static readonly ID = "revert";

	revert = RevertCommand.revert;

	data = new SlashCommandBuilder()
		.setName(RevertCommand.ID)
		.setDescription("Revert a pull and restore members to their original positions")
		.addIntegerOption(option =>
			option
				.setName("pull_id")
				.setDescription("The pull ID shown in the footer of the pull message")
				.setRequired(true)
				.setMinValue(1)
		);

	// ====================================================================
	//                           /revert
	// ====================================================================

	static async revert(inter: SlashInteraction) {
		const pullId = BigInt(inter.options.getInteger("pull_id", true));

		const pullEvent = Queries.selectPullEvent({ guildId: inter.guildId, id: pullId });
		if (!pullEvent) {
			await inter.respond({
				embeds: [new EmbedBuilder().setDescription(`No pull event found with ID \`${pullId}\`. Pull events are only kept for 24 hours.`)],
			});
			return;
		}

		type PullMember = { userId: string, queueId: string, positionTime: string, joinTime: string, message: string | null, reason: string };
		const members: PullMember[] = JSON.parse(pullEvent.members);

		const restored: string[] = [];
		const skipped: string[] = [];

		for (const entry of members) {
			const queueId = BigInt(entry.queueId);
			const queue = inter.store.dbQueues().get(queueId);
			if (!queue) {
				skipped.push(`${userMention(entry.userId)} (queue no longer exists)`);
				continue;
			}

			// Skip if already in the queue
			const alreadyInQueue = inter.store.dbMembers().some(m => m.queueId === queueId && m.userId === entry.userId);
			if (alreadyInQueue) {
				skipped.push(`${userMention(entry.userId)} in ${queueMention(queue)} (already in queue)`);
				continue;
			}

			const jsMember = await inter.store.jsMember(entry.userId);
			if (!jsMember) {
				skipped.push(`${userMention(entry.userId)} in ${queueMention(queue)} (no longer in server)`);
				continue;
			}

			await MemberUtils.restoreMember({
				store: inter.store,
				queue,
				jsMember,
				message: entry.message,
				positionTime: BigInt(entry.positionTime),
				joinTime: BigInt(entry.joinTime),
			});

			restored.push(`${userMention(entry.userId)} → ${queueMention(queue)}`);
		}

		const lines: string[] = [];
		if (restored.length) {
			lines.push(`**Restored (${restored.length}):**\n${restored.map(r => `- ${r}`).join("\n")}`);
		}
		if (skipped.length) {
			lines.push(`**Skipped (${skipped.length}):**\n${skipped.map(s => `- ${s}`).join("\n")}`);
		}
		if (!lines.length) {
			lines.push("No members were restored.");
		}

		await inter.respond({
			embeds: [new EmbedBuilder().setTitle(`Revert Pull #${pullId}`).setDescription(lines.join("\n\n"))],
		}, true);
	}
}
