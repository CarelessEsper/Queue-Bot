import {
	bold,
	channelMention,
	Collection,
	EmbedBuilder,
	GuildMember,
	type GuildTextBasedChannel,
	type Message,
	roleMention,
	type Snowflake,
	userMention,
} from "discord.js";
import { compact, isNil, shuffle, upperFirst } from "lodash-es";

import { db } from "../db/db.ts";
import { Queries } from "../db/queries.ts";
import { type DbArchivedMember, type DbMember, type DbQueue } from "../db/schema.ts";
import type { Store } from "../db/store.ts";
import { MemberRemovalReason, PullMessageDisplayType } from "../types/db.types.ts";
import type { MemberDeleteBy } from "../types/member.types.ts";
import type { ArrayOrCollection } from "../types/misc.types.ts";
import { NotificationAction } from "../types/notification.types.ts";
import { BlacklistUtils } from "./blacklist.utils.ts";
import { AutoRemoveUtils } from "./auto-remove.utils.ts";
import { DisplayUtils } from "./display.utils.ts";
import { CustomError, NotOnQueueWhitelistError, OnQueueBlacklistError, QueueFullError, QueueLockedError } from "./error.utils.ts";
import { LoggingUtils } from "./message-utils/logging.utils.ts";
import { map } from "./misc.utils.ts";
import { NotificationUtils } from "./notification.utils.ts";
import { PriorityUtils } from "./priority.utils.ts";
import { membersMention, queueMention, queuesMention, timeMention, usersMention } from "./string.utils.ts";
import { WhitelistUtils } from "./whitelist.utils.ts";

export namespace MemberUtils {
	export async function insertUsers(options: {
		store: Store,
		users: { id: Snowflake }[],
		queues: Collection<bigint, DbQueue>,
		force?: boolean,
	}) {
		const { store, users, queues, force } = options;

		const insertedMembers = compact(
			await db.transaction(async () => {
				const inserted = [];
				for (const user of users) {
					const jsMember = await store.jsMember(user.id);
					if (!jsMember) continue;

					for (const queue of queues.values()) {
						inserted.push(
							await insertMemberInternal({ store, queue, jsMember, force })
						);
					}
				}
				return inserted;
			})
		);

		DisplayUtils.requestDisplaysUpdate({
			store,
			queueIds: queues.map(queue => queue.id),
		});

		if (store.inter) {
			await store.inter.respond(`Added ${usersMention(insertedMembers)} to ${queuesMention(queues)} queue${queues.size > 1 ? "s" : ""}.`, true);
		}
		return insertedMembers;
	}

	export async function insertMember(options: {
		store: Store,
		queue: DbQueue,
		jsMember: GuildMember,
		message?: string,
		force?: boolean,
	}) {
		return await db.transaction(async () => {
			const insertedMember = await insertMemberInternal(options);

			DisplayUtils.requestDisplayUpdate({ store: options.store, queueId: options.queue.id });

			return insertedMember;
		});
	}

	export function updateMembers(options: {
		store: Store,
		members: ArrayOrCollection<bigint, DbMember>,
		message: string,
	}) {
		const { store, members, message } = options;
		const updatedMembers = compact(map(members, member => store.updateMember({ ...member, message })));
		DisplayUtils.requestDisplaysUpdate({
			store,
			queueIds: map(updatedMembers, member => member.queueId),
		});
		return updatedMembers;
	}

	/**
	 * Deletes members from the queue(s) and optionally notifies them.
	 * @param options.store - The store to use.
	 * @param options.queues - The queue(s) to delete members from.
	 * @param options.reason - The reason for deleting the members.
	 * @param options.by - Optionally specify the members to delete.
	 * @param options.messageChannelId - Optionally specify a channel to send a kick/pull message in
	 * @param options.force - Optionally force the deletion of members.
	 */
	export async function deleteMembers(options: {
		store: Store,
		queues: ArrayOrCollection<bigint, DbQueue>,
		reason: MemberRemovalReason,
		by?: MemberDeleteBy,
		messageChannelId?: Snowflake;
		destinationChannelId?: Snowflake;
		force?: boolean,
	}) {
		const { store, reason, by, messageChannelId, force } = options;
		const queues = options.queues instanceof Collection ? [...options.queues.values()] : options.queues;
		const { userId, userIds, roleId, count } = by ?? {} as any;
		const deletedMembers: DbMember[] = [];

		// Track log messages from pulls so we can edit them after cross-queue removals
		const pullLogMessages = new Map<string, Message>(); // userId -> log message

		async function deleteMembersAndNotify(queue: DbQueue, userIds: Snowflake[], reason: MemberRemovalReason) {
			// Capture positions before deletion so leave/pull logs can reference them
			const shouldLogLeave = reason === MemberRemovalReason.Left || reason === MemberRemovalReason.Expired || reason === MemberRemovalReason.SilentExpired || reason === MemberRemovalReason.Kicked;
			const queueMembersBefore = (shouldLogLeave || reason === MemberRemovalReason.Pulled)
				? [...store.dbMembers().filter(m => m.queueId === queue.id).values()]
				: [];
			const positionMap = new Map(queueMembersBefore.map((m, i) => [m.userId, i + 1]));

			const deleted: DbMember[] = compact(userIds.map(userId => store.deleteMember({ queueId: queue.id, userId }, reason)));

			userIds.forEach(userId => modifyMemberRoles(store, userId, queue.roleInQueueId, "remove").catch(() => null));
			// Cancel any pending auto-remove timers for deleted members
			userIds.forEach(userId => AutoRemoveUtils.cancel(queue.id, userId));
			// Pull members to the destination channel if they are in a voice channel
			if (reason === MemberRemovalReason.Pulled) {
				const destinationChannelId = options.destinationChannelId ?? queue.voiceDestinationChannelId;
				if (destinationChannelId) {
					for (const userId of userIds) {
						const jsMember = await store.jsMember(userId);
						if (jsMember.voice && jsMember.voice.channelId !== destinationChannelId) {
							jsMember.voice?.setChannel(destinationChannelId).catch(() => null);
						}
					}
				}
				if (queue.roleOnPullId) {
					userIds.forEach(userId => modifyMemberRoles(store, userId, queue.roleOnPullId, "add").catch(() => null));
				}
			}

			if ([MemberRemovalReason.Pulled, MemberRemovalReason.Kicked].includes(reason)) {
				if (deleted.length === 0) {
					if (reason === MemberRemovalReason.Pulled) {
						await store.inter?.respond({ content: `The **${queue.name}** queue is currently empty.`, ephemeral: true });
					}
				}
				else {
					const messageToSend = await describePulledMembers(store, queue, deleted, reason);
					let sourceMessage: Message | null = null;

					// Build mention content for pings (only for pulls with dmOnPullToggle)
					const mentionContent = (reason === MemberRemovalReason.Pulled && queue.dmOnPullToggle)
						? deleted.map(m => userMention(m.userId)).join(" ") + ` you were pulled from the **${queue.name}** queue.` + (queue.pullMessage ? `\n> ${queue.pullMessage}` : "")
						: undefined;

					if (messageChannelId && queue.pullMessageDisplayType === PullMessageDisplayType.Public) {
						const messageChannel = await store.jsChannel(messageChannelId) as GuildTextBasedChannel;
						if (messageChannel) {
							sourceMessage = await messageChannel.send({
								content: mentionContent,
								...messageToSend,
							}).catch(() => null);
							if (reason !== MemberRemovalReason.Pulled) {
								LoggingUtils.log(store, true, sourceMessage).catch(() => null);
							}
						}
						await store.inter?.deleteReply().catch(() => null);
					}
					else if (queue.pullMessageDisplayType === PullMessageDisplayType.Private) {
						if (store.inter) {
							sourceMessage = await store.inter.respond(messageToSend, true);
							// Send mentions separately in the channel since private display can't carry content
							if (mentionContent && messageChannelId) {
								const messageChannel = await store.jsChannel(messageChannelId) as GuildTextBasedChannel;
								await messageChannel?.send({ content: mentionContent }).catch(() => null);
							}
						}
						else {
							LoggingUtils.log(store, true, messageToSend).catch(() => null);
						}
					}

					if (reason === MemberRemovalReason.Pulled) {
						const logMsg = await LoggingUtils.logPull(store, queue, deleted, sourceMessage, positionMap);
						if (logMsg) {
							deleted.forEach(m => pullLogMessages.set(m.userId, logMsg));
						}
					}
				}
			}

			DisplayUtils.requestDisplayUpdate({ store, queueId: queue.id });

			// Log leave events (voluntary or expired)
			if (shouldLogLeave) {
				for (const m of deleted) {
					const pos = positionMap.get(m.userId) ?? 0;
					LoggingUtils.logLeave(store, queue, m, pos, reason).catch(() => null);
				}
			}

			deletedMembers.push(...deleted);
		}

		await db.transaction(async () => {
			if (!isNil(userId) || !isNil(userIds)) {
				const ids: Snowflake[] = !isNil(userId) ? [userId] : userIds;
				for (const queue of queues) {
					await deleteMembersAndNotify(queue, ids, reason);
				}
			}
			else if (!isNil(roleId)) {
				const jsMembers = (await store.guild.roles.fetch(roleId)).members;
				for (const queue of queues) {
					await deleteMembersAndNotify(queue, jsMembers.map(member => member.id), reason);
				}
			}
			else {
				for (const queue of queues) {
					const numToPull = Number(count ?? queue.pullBatchSize);
					const members = [...store.dbMembers().filter(member => member.queueId === queue.id).values()];
					if (!force && members.length && (members.length < numToPull)) {
						throw new Error("Not enough members to pull");
					}
					const userIdsToPull = members.slice(0, numToPull).map(member => member.userId);
					await deleteMembersAndNotify(queue, userIdsToPull, reason);
				}
			}
		});

		// When members are pulled, silently remove them from all other queues they belong to.
		// This does not apply to manual leaves or auto-remove expiry.
		if (reason === MemberRemovalReason.Pulled && deletedMembers.length > 0) {
			const pulledUserIds = [...new Set(deletedMembers.map(m => m.userId))];
			const pulledQueueIds = new Set(queues.map(q => q.id));

			// secondaryLines collects text for editing the pull log message
			const secondaryLines: string[] = [];

			const allQueues = [...store.dbQueues().values()];
			for (const otherQueue of allQueues) {
				if (pulledQueueIds.has(otherQueue.id)) continue;

				const usersInOtherQueue = pulledUserIds.filter(uid =>
					store.dbMembers().some(m => m.queueId === otherQueue.id && m.userId === uid)
				);
				if (usersInOtherQueue.length === 0) continue;

				const queueMembersBefore = [...store.dbMembers().filter(m => m.queueId === otherQueue.id).values()];
				const positionMap = new Map(queueMembersBefore.map((m, i) => [m.userId, i + 1]));

				usersInOtherQueue.forEach(uid => {
					store.deleteMember({ queueId: otherQueue.id, userId: uid }, MemberRemovalReason.RemovedByPull);
					modifyMemberRoles(store, uid, otherQueue.roleInQueueId, "remove").catch(() => null);
					AutoRemoveUtils.cancel(otherQueue.id, uid);
					const pos = positionMap.get(uid) ?? 0;
					secondaryLines.push(`- ${userMention(uid)} in **${otherQueue.name}** at position \`${pos}\``);
				});

				DisplayUtils.requestDisplayUpdate({ store, queueId: otherQueue.id });
			}

			// Edit each unique pull log message to append the secondary removal field
			if (secondaryLines.length > 0) {
				const uniqueLogMessages = new Set(pullLogMessages.values());
				for (const logMsg of uniqueLogMessages) {
					const existingEmbed = logMsg.embeds[0];
					if (!existingEmbed) continue;
					const updatedEmbed = EmbedBuilder.from(existingEmbed).addFields({
						name: "Automatically removed from queues",
						value: secondaryLines.join("\n"),
					});
					logMsg.edit({ embeds: [updatedEmbed] }).catch(() => null);
				}
			}
		}

		return deletedMembers;
	}

	// Position is 0 indexed
	export function moveMember(store: Store, queue: DbQueue, member: DbMember, position: number) {
		// Validate position
		const members = [...store.dbMembers().filter(member => member.queueId === queue.id).values()];

		if (position < 1 || position > members.length) {
			throw new CustomError({
				message: "Invalid position",
				embeds: [new EmbedBuilder().setDescription(`Position must be between 1 and ${members.length}.`)],
			});
		}

		return db.transaction(() => {
			const positions = members.map(m => m.positionTime);
			const newPosition = position - 1;
			const oldPosition = positions.indexOf(member.positionTime);

			if (oldPosition > newPosition) {
				members.splice(oldPosition, 1);
				members.splice(newPosition, 0, member);
				members.forEach((member, i) =>
					store.updateMember({ ...member, positionTime: positions[i] })
				);
			}
			else if (oldPosition < newPosition) {
				members.splice(oldPosition, 1);
				members.splice(newPosition, 0, member);
				members.forEach((member, i) =>
					store.updateMember({ ...member, positionTime: positions[i] })
				);
			}

			DisplayUtils.requestDisplayUpdate({
				store,
				queueId: queue.id,
			});

			return members;
		});
	}

	export async function shuffleMembers(store: Store, queue: DbQueue, messageChannelId: Snowflake) {
		return db.transaction(async () => {
			const members = store.dbMembers().filter(member => member.queueId === queue.id);
			const shuffledPositionTimes = shuffle(members.map(member => member.positionTime));

			members.forEach((member) => store.updateMember({ ...member, positionTime: shuffledPositionTimes.pop() }));

			DisplayUtils.requestDisplayUpdate({
				store,
				queueId: queue.id,
			});

			if (messageChannelId) {
				const messageChannel = await store.jsChannel(messageChannelId) as GuildTextBasedChannel;
				if (messageChannel) {
					const message = await messageChannel?.send(`Shuffled the ${queueMention(queue)} queue.`).catch(() => null);
					LoggingUtils.log(store, true, message).catch(() => null);
				}
			}

			return members;
		});
	}

	/**
	 * Restores a previously-pulled member to the queue with priority order 0,
	 * placing them ahead of all other members while respecting the normal sort order.
	 */
	export async function restoreMember(options: {
		store: Store,
		queue: DbQueue,
		jsMember: GuildMember,
		message?: string,
		positionTime?: bigint,
		priorityOrder?: bigint,
	}) {
		const { store, queue, jsMember, message, positionTime, priorityOrder } = options;

		return await db.transaction(async () => {
			const insertedMember = store.insertMember({
				guildId: store.guild.id,
				queueId: queue.id,
				userId: jsMember.id,
				message,
				priorityOrder: priorityOrder ?? null,
				positionTime: positionTime ?? BigInt(Date.now()),
			});

			await modifyMemberRoles(store, jsMember.id, queue.roleInQueueId, "add");

			// Schedule auto-remove if configured, synced to earliest expiry across all queues
			if (queue.autoRemovePeriod && queue.autoRemovePeriod > 0n) {
				const now = BigInt(Date.now());
				const thisPeriodMs = Number(queue.autoRemovePeriod) * 1000;

				const otherQueues = store.dbQueues().filter(q =>
					q.id !== queue.id && q.autoRemovePeriod && q.autoRemovePeriod > 0n
				);
				let earliestRemainingMs = thisPeriodMs;
				for (const otherQueue of otherQueues.values()) {
					const otherMember = store.dbMembers().find(m => m.queueId === otherQueue.id && m.userId === jsMember.id);
					if (!otherMember) continue;
					const elapsed = Number(now - otherMember.joinTime);
					const remaining = Number(otherQueue.autoRemovePeriod) * 1000 - elapsed;
					if (remaining > 0 && remaining < earliestRemainingMs) {
						earliestRemainingMs = remaining;
					}
				}

				AutoRemoveUtils.schedule(store.guild.id, queue.id, jsMember.id, earliestRemainingMs);
			}

			DisplayUtils.requestDisplayUpdate({ store, queueId: queue.id });

			return insertedMember;
		});
	}

	export async function getMemberDisplayLine(store: Store, queue: DbQueue, userId: Snowflake) {
		const { position, member } = getMemberPosition(store, queue, userId);
		return new EmbedBuilder()
			.setTitle(queueMention(queue))
			.setColor(queue.color)
			.setDescription(await DisplayUtils.createMemberDisplayLine(store, member, position) ?? "Member not found");
	}

	export async function describePulledMembers(store: Store, queue: DbQueue, pulledMembers: DbMember[], reason: MemberRemovalReason) {
		const pulledMembersOfQueue = pulledMembers.filter(member => member.queueId === queue.id);
		const membersStr = (await membersMention(store, pulledMembersOfQueue))
			.map(mention => `- ${mention}`)
			.join("\n");

		const description = pulledMembersOfQueue.length
			? `${upperFirst(reason)} from queue:\n${membersStr}`
			: `No members were ${reason} from queue.`;

		return { embeds: [new EmbedBuilder().setTitle(queueMention(queue)).setColor(queue.color).setDescription(description)] };
	}

	export async function describeMemberPositions(store: Store, userId: Snowflake) {
		const members = Queries.selectManyMembers({ guildId: store.guild.id, userId });
		const queues = members.map(member => Queries.selectQueue({ guildId: store.guild.id, id: member.queueId }));

		const embeds = await Promise.all(queues.map(queue =>
			MemberUtils.getMemberDisplayLine(store, queue, userId)
		));

		if (!embeds.length) {
			embeds.push(new EmbedBuilder().setDescription(`${userMention(userId)} is not in any queues.`));
		}

		return embeds;
	}

	export async function modifyMemberRoles(store: Store, memberId: Snowflake, roleId: Snowflake, modification: "add" | "remove") {
		if (!roleId) return;
		const member = await store.jsMember(memberId);
		try {
			if (modification === "add") {
				await member.roles.add(roleId);
			}
			else if (modification === "remove") {
				await member.roles.remove(roleId);
			}
		}
		catch (e) {
			const { message } = e as Error;
			if (message.includes("Missing Permissions") || message.includes("Unknown Role")) {
				throw new CustomError({
					message: "Missing Permissions",
					embeds: [
						new EmbedBuilder()
							.setDescription(
								`I can not assign or remove the ${roleMention(roleId)} role. A server owner must:\n` +
								"1. Open the server settings\n" +
								"2. Click 'Roles'\n" +
								"3. Drag the bot role above the role you want to assign/remove\n" +
								"4. Click the Queue Bot role\n" +
								"5. Enable the 'Manage Roles' permission"
							),
					],
				});
			}
			else {
				throw e;
			}
		}
	}

	// ====================================================================
	// 												 Helpers
	// ====================================================================

	async function insertMemberInternal(options: {
		store: Store,
		queue: DbQueue,
		jsMember: GuildMember,
		message?: string,
		force?: boolean,
	}) {
		const { store, queue, jsMember, message, force } = options;

		const archivedMember = store.dbArchivedMembers().find(member =>
			member.queueId === queue.id && member.userId === jsMember.id
		);

		if (!force) {
			verifyMemberEligibility(store, queue, jsMember, archivedMember);
		}

		if (queue.voiceDestinationChannelId && queue.voiceDestinationChannelId === jsMember.voice.channelId) {
			throw new CustomError({
				message: `Failed to join`,
				embeds: [
					new EmbedBuilder()
						.setDescription(`${jsMember} is already in the destination voice channel for the ${queueMention(queue)} queue.`),
				],
			});
		}

		const priorityOrder = PriorityUtils.getMemberPriority(store, queue.id, jsMember);
		let positionTime = BigInt(Date.now());

		if (queue.rejoinGracePeriod && archivedMember?.reason === MemberRemovalReason.Left) {
			if (BigInt(Date.now()) - archivedMember.archivedTime <= (queue.rejoinGracePeriod * 1000n)) {
				// Reuse the positionTime
				positionTime = archivedMember.positionTime;
			}
		}

		const insertedMember = store.insertMember({
			guildId: store.guild.id,
			queueId: queue.id,
			userId: jsMember.id,
			message,
			priorityOrder,
			positionTime,
		});

		await modifyMemberRoles(store, jsMember.id, queue.roleInQueueId, "add");

		// Remove the configured "role to remove on join" if the member has it
		if (queue.roleToRemoveOnJoinId && jsMember.roles.cache.has(queue.roleToRemoveOnJoinId)) {
			await modifyMemberRoles(store, jsMember.id, queue.roleToRemoveOnJoinId, "remove").catch(() => null);
		}

		// Log the join event
		LoggingUtils.logJoin(store, queue, insertedMember).catch(() => null);

		// Schedule auto-remove if configured.
		// If the member is already in other auto-remove queues, sync to the earliest
		// expiry so all their queues expire together and the DM is always bundled.
		if (queue.autoRemovePeriod && queue.autoRemovePeriod > 0n) {
			const now = BigInt(Date.now());
			const thisPeriodMs = Number(queue.autoRemovePeriod) * 1000;

			// Find the earliest remaining time across all other auto-remove queues this user is in
			const otherQueues = store.dbQueues().filter(q =>
				q.id !== queue.id && q.autoRemovePeriod && q.autoRemovePeriod > 0n
			);
			let earliestRemainingMs = thisPeriodMs;
			for (const otherQueue of otherQueues.values()) {
				const otherMember = store.dbMembers().find(m => m.queueId === otherQueue.id && m.userId === jsMember.id);
				if (!otherMember) continue;
				const elapsed = Number(now - otherMember.joinTime);
				const remaining = Number(otherQueue.autoRemovePeriod) * 1000 - elapsed;
				if (remaining > 0 && remaining < earliestRemainingMs) {
					earliestRemainingMs = remaining;
				}
			}

			AutoRemoveUtils.schedule(store.guild.id, queue.id, jsMember.id, earliestRemainingMs);
		}

		return insertedMember;
	}

	function verifyMemberEligibility(store: Store, queue: DbQueue, jsMember: GuildMember, archivedMember: DbArchivedMember) {
		if (queue.lockToggle) {
			throw new QueueLockedError();
		}
		// Check if already in the queue
		const alreadyInQueue = store.dbMembers().some(m => m.queueId === queue.id && m.userId === jsMember.id);
		if (alreadyInQueue) {
			throw new CustomError({
				message: `You are already in the ${queueMention(queue)} queue.`,
			});
		}
		if (queue.size) {
			const members = store.dbMembers().filter(member => member.queueId === queue.id);
			if (members.size >= queue.size) {
				throw new QueueFullError();
			}
		}
		if (WhitelistUtils.isBlockedByWhitelist(store, queue.id, jsMember)) {
			throw new NotOnQueueWhitelistError();
		}
		if (BlacklistUtils.isBlockedByBlacklist(store, queue.id, jsMember)) {
			throw new OnQueueBlacklistError();
		}

		if (queue.voiceOnlyToggle) {
			const voices = store.dbVoices().filter(voice => voice.queueId === queue.id);
			if (!jsMember.voice || !voices.some(voice => voice.sourceChannelId === jsMember.voice.channelId)) {
				let message: string;
				if (voices.size === 0) {
					message = "This queue is voice-only, but no voice channels are linked to it. Please contact a server administrator.";
				}
				else if (voices.size === 1) {
					message = `You must be in the ${channelMention(voices.first().sourceChannelId)} voice channel to join the queue.`;
				}
				else {
					message = "You must be in one of the following voice channels to join the queue:\n" +
						map(voices, voice => `- ${channelMention(voice.sourceChannelId)}`).join("\n");
				}
				throw new CustomError({
					message: "Not in voice channel",
					embeds: [new EmbedBuilder().setDescription(message)],
				});
			}
		}

		if (queue.rejoinCooldownPeriod && archivedMember?.reason === MemberRemovalReason.Pulled) {
			const msSincePulled = BigInt(Date.now()) - archivedMember.archivedTime;
			const msCooldownRemaining = (queue.rejoinCooldownPeriod * 1000n) - msSincePulled;
			if (msCooldownRemaining > 0) {
				throw new CustomError({
					message: "You are currently in a cooldown period and cannot rejoin the queue",
					embeds: [
						new EmbedBuilder()
							.setDescription(`You can rejoin the queue in ${bold(timeMention(msCooldownRemaining / 1000n))}.`),
					],
				});
			}
		}
	}

	function getMemberPosition(store: Store, queue: DbQueue, userId: Snowflake) {
		const members = [...store.dbMembers().filter(member => member.queueId === queue.id).values()];
		const member = members.find(member => member.userId === userId);
		const position = members.indexOf(member) + 1;
		return { position, member };
	}
}
