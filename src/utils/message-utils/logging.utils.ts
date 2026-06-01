import { channelMention, EmbedBuilder, type GuildTextBasedChannel, Message, roleMention, userMention } from "discord.js";

import type { DbMember, DbQueue } from "../../db/schema.ts";
import type { Store } from "../../db/store.ts";
import { Scope } from "../../types/db.types.ts";
import { memberNameMention } from "../string.utils.ts";

export namespace LoggingUtils {
	export type Loggable = Message | string | { embeds?: EmbedBuilder[], content?: string };

	export async function log(store: Store, isAdmin: boolean, originalMessage: Loggable) {
		const { logChannelId, logScope } = store.dbGuild();
		// required fields check
		if (!(logChannelId && logScope && originalMessage)) return;
		// scope check
		if (![Scope.Admin, Scope.All].includes(logScope) && isAdmin) return;
		if (![Scope.NonAdmin, Scope.All].includes(logScope) && !isAdmin) return;

		const logChannel = await store.jsChannel(logChannelId) as GuildTextBasedChannel;
		if (!logChannel) return;

		let embeds: EmbedBuilder[] = [];

		if (typeof originalMessage === "string") {
			embeds.push(new EmbedBuilder().setDescription(originalMessage));
		}
		else {
			if (originalMessage.content) {
				embeds.push(new EmbedBuilder().setDescription(originalMessage.content));
			}
			if (originalMessage.embeds) {
				embeds.push(...originalMessage.embeds as any);
			}
		}

		if (store.inter) {
			embeds = embeds.map(embed => {
				const jsMember = store.inter.member;
				return new EmbedBuilder({ ...embed.data }).setAuthor({
					name: memberNameMention(jsMember),
					iconURL: store.inter.user.displayAvatarURL(),
					url: (originalMessage as any)?.url,
				});
			});
		}

		return await logChannel.send({ embeds }).catch(null);
	}

	/**
	 * Logs a member joining a queue as a clean single embed:
	 * - Title: queue name
	 * - Description: @mention + display name
	 * - Footer: user ID + timestamp
	 */
	export async function logJoin(store: Store, queue: DbQueue, member: DbMember) {
		const { logChannelId, logScope } = store.dbGuild();
		if (!(logChannelId && logScope)) return;
		// joins are non-admin actions
		if (![Scope.NonAdmin, Scope.All].includes(logScope)) return;

		const logChannel = await store.jsChannel(logChannelId) as GuildTextBasedChannel;
		if (!logChannel) return;

		const jsMember = await store.jsMember(member.userId);
		const displayName = jsMember ? memberNameMention(jsMember) : member.userId;
		const joinedAt = new Date(Number(member.joinTime));

		const embed = new EmbedBuilder()
			.setColor(queue.color)
			.setTitle(`Joined ${queue.name}`)
			.setDescription(`${userMention(member.userId)} (${displayName}) joined the **${queue.name}** queue.`)
			.setFooter({ text: `User ID: ${member.userId}` })
			.setTimestamp(joinedAt);

		if (jsMember) {
			embed.setThumbnail(jsMember.user.displayAvatarURL());
		}

		return await logChannel.send({ embeds: [embed] }).catch(() => null);
	}

	/**
	 * Logs queue setting changes with before/after values for each changed property.
	 */
	export async function logQueueUpdate(store: Store, before: DbQueue, after: DbQueue) {
		const { logChannelId, logScope } = store.dbGuild();
		if (!(logChannelId && logScope)) return;
		if (![Scope.Admin, Scope.All].includes(logScope)) return;

		const logChannel = await store.jsChannel(logChannelId) as GuildTextBasedChannel;
		if (!logChannel) return;

		// Properties to skip in the diff (internal/non-configurable)
		const skip = new Set(["id", "guildId"]);

		// Formatters for values that need special display
		const format = (key: string, value: unknown): string => {
			if (value === null || value === undefined) return "_none_";
			if (key.endsWith("Id") && typeof value === "string") {
				if (key.toLowerCase().includes("role")) return roleMention(value);
				if (key.toLowerCase().includes("channel")) return channelMention(value);
			}
			return `\`${value}\``;
		};

		const changes = Object.keys(after)
			.filter(key => !skip.has(key) && JSON.stringify((before as any)[key]) !== JSON.stringify((after as any)[key]))
			.map(key => {
				const label = key.replace(/([A-Z])/g, " $1").toLowerCase().replace(/^./, s => s.toUpperCase());
				const oldVal = format(key, (before as any)[key]);
				const newVal = format(key, (after as any)[key]);
				return `**${label}:** ${oldVal} → ${newVal}`;
			});

		if (changes.length === 0) return;

		const adminId = store.inter?.user?.id;
		const adminStr = adminId ? `${userMention(adminId)} updated` : "Updated";

		const embed = new EmbedBuilder()
			.setColor(after.color)
			.setTitle(`${adminStr} **${after.name}** queue settings`)
			.setDescription(changes.join("\n"))
			.setTimestamp();

		if (store.inter?.user) {
			embed.setAuthor({
				name: memberNameMention(store.inter.member),
				iconURL: store.inter.user.displayAvatarURL(),
			});
		}

		return await logChannel.send({ embeds: [embed] }).catch(() => null);
	}

	/**
	 * Logs a pull action as an embed:
	 * - Author: admin mention + avatar
	 * - Title: "Pulled from <QueueName>"
	 * - Description: each pulled member as @mention (display name) — User ID: <id>
	 * - Footer: total count pulled
	 */
	export async function logPull(
		store: Store,
		queue: DbQueue,
		pulledMembers: DbMember[],
		sourceMessage: Message | null,
	) {
		const { logChannelId, logScope } = store.dbGuild();
		if (!(logChannelId && logScope)) return;
		if (![Scope.Admin, Scope.All].includes(logScope)) return;

		const logChannel = await store.jsChannel(logChannelId) as GuildTextBasedChannel;
		if (!logChannel) return;

		const count = pulledMembers.length;

		const memberLines = await Promise.all(
			pulledMembers.map(async m => {
				const jsMember = await store.jsMember(m.userId).catch(() => null);
				const displayName = jsMember ? memberNameMention(jsMember) : m.userId;
				return `${userMention(m.userId)} (${displayName}) — User ID: ${m.userId}`;
			})
		);

		const embed = new EmbedBuilder()
			.setColor(queue.color)
			.setTitle(`Pulled from ${queue.name}`)
			.setDescription(memberLines.join("\n"))
			.setFooter({ text: `${count} user${count === 1 ? "" : "s"} pulled from the waitlist` })
			.setTimestamp();

		if (store.inter?.user) {
			embed.setAuthor({
				name: memberNameMention(store.inter.member),
				iconURL: store.inter.user.displayAvatarURL(),
				url: sourceMessage?.url ?? undefined,
			});
		}

		return await logChannel.send({ embeds: [embed] }).catch(() => null);
	}
}
