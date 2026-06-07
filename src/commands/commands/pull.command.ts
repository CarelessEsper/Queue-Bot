import { SlashCommandBuilder } from "discord.js";

import { MembersOption } from "../../options/options/members.option.ts";
import { NumberOption } from "../../options/options/number.option.ts";
import { PullQueuesOption } from "../../options/options/pull-queues.option.ts";
import { AdminCommand } from "../../types/command.types.ts";
import { MemberRemovalReason } from "../../types/db.types.ts";
import type { SlashInteraction } from "../../types/interaction.types.ts";
import { CHOICE_SOME } from "../../types/parsing.types.ts";
import { MemberUtils } from "../../utils/member.utils.ts";
import { QueueTagUtils } from "../../utils/queue-tag.utils.ts";
import { queuesMention } from "../../utils/string.utils.ts";

export class PullCommand extends AdminCommand {
	static readonly ID = "pull";

	pull = PullCommand.pull;

	static readonly PULL_OPTIONS = {
		queues: new PullQueuesOption({ required: true, description: "Queue(s) to pull members from" }),
		count: new NumberOption({ description: "Number of queue members to pull", defaultValue: 1, minValue: 1 }),
		members: new MembersOption({ description: "Pull specific members instead of the next member", extraChoices: [CHOICE_SOME] }),
	};

	data = new SlashCommandBuilder()
		.setName(PullCommand.ID)
		.setDescription("Pull members from queue(s)")
		.addStringOption(PullCommand.PULL_OPTIONS.queues.build)
		.addIntegerOption(PullCommand.PULL_OPTIONS.count.build)
		.addStringOption(PullCommand.PULL_OPTIONS.members.build);

	// ====================================================================
	//                           /pull
	// ====================================================================

	static async pull(inter: SlashInteraction) {
		const queues = await PullCommand.PULL_OPTIONS.queues.get(inter);
		const count = PullCommand.PULL_OPTIONS.count.get(inter) ?? 1;
		const members = await PullCommand.PULL_OPTIONS.members.get(inter);

		// Enforce forum tag restrictions
		QueueTagUtils.verifyForumTagAccess(queues, inter.channel as any);

		// Confirm when pulling more than one member or from multiple queues
		const pullingMultiple = count > 1 || queues.size > 1;
		if (pullingMultiple) {
			const countStr = count > 1 ? `**${count}** members` : "members";
			const confirmed = await inter.promptConfirmOrCancel(
				`You are about to pull ${countStr} from ${queuesMention(queues)}. Are you sure?`
			);
			if (!confirmed) {
				await inter.editReply({ content: "Pull cancelled.", components: [] }).catch(() => null);
				return;
			}
		}

		await MemberUtils.deleteMembers({
			store: inter.store,
			queues,
			reason: MemberRemovalReason.Pulled,
			by: { userIds: members?.map((member) => member.userId), count },
			messageChannelId: inter.channel?.id,
			force: true,
		});
	}
}
