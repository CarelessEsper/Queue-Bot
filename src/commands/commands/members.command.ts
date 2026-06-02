import { type Collection, EmbedBuilder, SlashCommandBuilder, userMention } from "discord.js";
import { compact } from "lodash-es";

import type { DbQueue } from "../../db/schema.ts";
import { UserOption } from "../../options/base-option.ts";
import { MembersOption } from "../../options/options/members.option.ts";
import { MessageOption } from "../../options/options/message.option.ts";
import { QueueOption } from "../../options/options/queue.option.ts";
import { QueuesOption } from "../../options/options/queues.option.ts";
import { AdminCommand } from "../../types/command.types.ts";
import { MemberRemovalReason } from "../../types/db.types.ts";
import type { SlashInteraction } from "../../types/interaction.types.ts";
import { ChoiceType } from "../../types/parsing.types.ts";
import { CustomError } from "../../utils/error.utils.ts";
import { MemberUtils } from "../../utils/member.utils.ts";
import { queueMention, queuesMention, usersMention } from "../../utils/string.utils.ts";
import { ShowCommand } from "./show.command.ts";
export class MembersCommand extends AdminCommand {
	static readonly ID = "members";

	members_get = MembersCommand.members_get;
	members_add = MembersCommand.members_add;
	members_set = MembersCommand.members_set;
	members_delete = MembersCommand.members_delete;
	members_restore = MembersCommand.members_restore;

	data = new SlashCommandBuilder()
		.setName(MembersCommand.ID)
		.setDescription("Manage queue members")
		.addSubcommand(subcommand => {
			subcommand
				.setName("get")
				.setDescription("Alias for /show");
			Object.values(MembersCommand.GET_OPTIONS).forEach(option => option.addToCommand(subcommand));
			return subcommand;
		})
		.addSubcommand(subcommand => {
			subcommand
				.setName("add")
				.setDescription("Add users or roles to a queue");
			Object.values(MembersCommand.ADD_OPTIONS).forEach(option => option.addToCommand(subcommand));
			return subcommand;
		})
		.addSubcommand(subcommand => {
			subcommand
				.setName("set")
				.setDescription("Update a queue member message");
			Object.values(MembersCommand.SET_OPTIONS).forEach(option => option.addToCommand(subcommand));
			return subcommand;
		})
		.addSubcommand(subcommand => {
			subcommand
				.setName("delete")
				.setDescription("Kick members from a queue");
			Object.values(MembersCommand.DELETE_OPTIONS).forEach(option => option.addToCommand(subcommand));
			return subcommand;
		})
		.addSubcommand(subcommand => {
			subcommand
				.setName("restore")
				.setDescription("Restore a recently-pulled member to the front of the queue");
			Object.values(MembersCommand.RESTORE_OPTIONS).forEach(option => option.addToCommand(subcommand));
			return subcommand;
		});

	// ====================================================================
	//                           /members get
	// ====================================================================

	static readonly GET_OPTIONS = {
		queues: new QueuesOption({ required: true, description: "Queue(s) to display" }),
	};

	static async members_get(inter: SlashInteraction, queues?: Collection<bigint, DbQueue>) {
		await ShowCommand.show(inter, queues);
	}

	// ====================================================================
	//                           /members add
	// ====================================================================

	static readonly ADD_OPTIONS = {
		queues: new QueuesOption({ required: true, description: "Queue(s) to add members to" }),
		user1: new UserOption({ id: "user_1", required: true, description: "User to add" }),
		user2: new UserOption({ id: "user_2", description: "User to add" }),
		user3: new UserOption({ id: "user_3", description: "User to add" }),
		user4: new UserOption({ id: "user_4", description: "User to add" }),
		user5: new UserOption({ id: "user_5", description: "User to add" }),
	};

	static async members_add(inter: SlashInteraction) {
		const queues = await MembersCommand.ADD_OPTIONS.queues.get(inter);
		const users = compact([
			MembersCommand.ADD_OPTIONS.user1.get(inter),
			MembersCommand.ADD_OPTIONS.user2.get(inter),
			MembersCommand.ADD_OPTIONS.user3.get(inter),
			MembersCommand.ADD_OPTIONS.user4.get(inter),
			MembersCommand.ADD_OPTIONS.user5.get(inter),
		]);

		await MemberUtils.insertUsers({
			store: inter.store,
			users,
			queues,
			force: true,
		});
	}

	// ====================================================================
	//                           /members set
	// ====================================================================

	static readonly SET_OPTIONS = {
		queues: new QueuesOption({ required: true, description: "Queue(s) of members to update" }),
		members: new MembersOption({ required: true, description: "Members to update" }),
		message: new MessageOption({ description: "New message of the member" }),
	};

	static async members_set(inter: SlashInteraction) {
		const queues = await MembersCommand.SET_OPTIONS.queues.get(inter);
		const members = await MembersCommand.SET_OPTIONS.members.get(inter);
		const message = MembersCommand.SET_OPTIONS.message.get(inter);

		const updatedMembers = MemberUtils.updateMembers({ store: inter.store, members, message });

		await inter.respond(`Updated ${usersMention(updatedMembers)} in ${queuesMention(queues)} queue${queues.size > 1 ? "s" : ""}.`, true);
	}

	// ====================================================================
	//                           /members delete
	// ====================================================================

	static readonly DELETE_OPTIONS = {
		queues: new QueuesOption({ required: true, description: "Queue(s) to kick members from" }),
		members: new MembersOption({ required: true, description: "Members to kick" }),
	};

	static async members_delete(inter: SlashInteraction) {
		const queues = await MembersCommand.DELETE_OPTIONS.queues.get(inter);
		const members = await MembersCommand.DELETE_OPTIONS.members.get(inter);

		if (MembersCommand.DELETE_OPTIONS.members.getRaw(inter) === ChoiceType.ALL) {
			const confirmed = await inter.promptConfirmOrCancel(`Are you sure you want to remove all members from the ${queuesMention(queues)} queue${queues.size > 1 ? "s" : ""}?`);
			if (!confirmed) {
				await inter.respond("Cancelled delete.");
				return;
			}
		}

		await MemberUtils.deleteMembers({
			store: inter.store,
			queues,
			reason: MemberRemovalReason.Kicked,
			by: { userIds: members.map(member => member.userId) },
			messageChannelId: inter.channel.id,
			force: true,
		});
	}

	// ====================================================================
	//                           /members restore
	// ====================================================================

	static readonly RESTORE_OPTIONS = {
		queue: new QueueOption({ required: true, description: "Queue to restore the member into" }),
		user: new UserOption({ id: "user", required: true, description: "User to restore to the front of the queue" }),
	};

	static async members_restore(inter: SlashInteraction) {
		const queue = await MembersCommand.RESTORE_OPTIONS.queue.get(inter);
		const user = MembersCommand.RESTORE_OPTIONS.user.get(inter);

		// Find the archived entry — must have been pulled
		const archived = inter.store.dbArchivedMembers().find(
			m => m.queueId === queue.id && m.userId === user.id && m.reason === MemberRemovalReason.Pulled
		);

		if (!archived) {
			throw new CustomError({
				message: "No recent pull found",
				embeds: [
					new EmbedBuilder().setDescription(
						`${userMention(user.id)} has no recent pull record in the ${queueMention(queue)} queue. ` +
						`Only members who were pulled can be restored.`
					),
				],
			});
		}

		const jsMember = await inter.store.jsMember(user.id);
		if (!jsMember) return;

		// Insert with priorityOrder = 0n so they sort ahead of all other members
		await MemberUtils.restoreMember({
			store: inter.store,
			queue,
			jsMember,
			message: archived.message,
		});

		await inter.respond(
			{ embeds: [new EmbedBuilder().setColor(queue.color).setDescription(`Restored ${userMention(user.id)} to the front of the ${queueMention(queue)} queue.`)] },
			true
		);
	}
}
