import type { Snowflake } from "discord.js";
import { and, eq, lt, sql } from "drizzle-orm";

import { db } from "./db.ts";
import {
	ADMIN_TABLE,
	ARCHIVED_MEMBER_TABLE,
	BLACKLISTED_TABLE,
	DISPLAY_TABLE,
	GUILD_TABLE,
	MEMBER_TABLE,
	type NewPatchNote,
	PATCH_NOTE_TABLE,
	PRIORITIZED_TABLE,
	PULL_EVENT_TABLE,
	QUEUE_TABLE,
	SCHEDULE_TABLE,
	VOICE_TABLE,
	WHITELISTED_TABLE,
} from "./schema.ts";

/**
 * `Queries` is responsible for handling all database read operations, including select queries.
 * These operations do not modify the database but are used to retrieve data.
 * All database write operations (insert, update, delete) are handled in `store.ts` to ensure they update the cache.
 *
 * ⚠️ IMPORTANT ⚠️: Queries must be written to include guildId!
 *
 * Prepared statements are built lazily (on first use) so that this module can be
 * imported before migrations have run without causing "no such table" errors.
 */
export namespace Queries {

	// ====================================================================
	//                       Lazy prepared statement cache
	// ====================================================================

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const cache = new Map<string, any>();

	function prepared<T>(key: string, build: () => T): T {
		if (!cache.has(key)) {
			cache.set(key, build());
		}
		return cache.get(key) as T;
	}

	// ====================================================================
	//                           Queries
	// ====================================================================

	// Guilds

	export function selectGuild(by: { guildId: Snowflake }) {
		return prepared("selectGuildById", () =>
			db.select().from(GUILD_TABLE)
				.where(eq(GUILD_TABLE.guildId, sql.placeholder("guildId")))
				.prepare()
		).get(by);
	}

	export function deleteGuild(by: { guildId: Snowflake }) {
		return db.delete(GUILD_TABLE).where(eq(GUILD_TABLE.guildId, by.guildId)).returning().get();
	}

	// Queues

	export function selectQueue(by: { guildId: Snowflake, id: bigint }) {
		return prepared("selectQueueByGuildIdAndId", () =>
			db.select().from(QUEUE_TABLE)
				.where(and(
					eq(QUEUE_TABLE.guildId, sql.placeholder("guildId")),
					eq(QUEUE_TABLE.id, sql.placeholder("id"))
				))
				.prepare()
		).get(by);
	}

	export function selectManyQueues(by: { guildId: Snowflake }) {
		return prepared("selectManyQueuesByGuildId", () =>
			db.select().from(QUEUE_TABLE)
				.where(eq(QUEUE_TABLE.guildId, sql.placeholder("guildId")))
				.prepare()
		).all(by);
	}

	export function selectAllQueues() {
		return db.select().from(QUEUE_TABLE).all();
	}

	// Voice

	export function selectVoice(by: { guildId: Snowflake, id: bigint }) {
		return prepared("selectVoiceByGuildIdAndId", () =>
			db.select().from(VOICE_TABLE)
				.where(and(
					eq(VOICE_TABLE.guildId, sql.placeholder("guildId")),
					eq(VOICE_TABLE.id, sql.placeholder("id"))
				))
				.prepare()
		).get(by);
	}

	export function selectManyVoices(by: { guildId: Snowflake }) {
		return prepared("selectManyVoicesByGuildId", () =>
			db.select().from(VOICE_TABLE)
				.where(eq(VOICE_TABLE.guildId, sql.placeholder("guildId")))
				.prepare()
		).all(by);
	}

	export function selectAllVoices() {
		return db.select().from(VOICE_TABLE).all();
	}

	// Displays

	export function selectDisplay(by:
		{ guildId: Snowflake, id: bigint } |
		{ guildId: Snowflake, lastMessageId: Snowflake } |
		{ guildId: Snowflake, queueId: bigint, displayChannelId: Snowflake }
	) {
		if ("id" in by) {
			return prepared("selectDisplayById", () =>
				db.select().from(DISPLAY_TABLE)
					.where(and(
						eq(DISPLAY_TABLE.guildId, sql.placeholder("guildId")),
						eq(DISPLAY_TABLE.id, sql.placeholder("id"))
					))
					.prepare()
			).get(by);
		}
		else if ("lastMessageId" in by) {
			return prepared("selectDisplayByLastMessageId", () =>
				db.select().from(DISPLAY_TABLE)
					.where(and(
						eq(DISPLAY_TABLE.guildId, sql.placeholder("guildId")),
						eq(DISPLAY_TABLE.lastMessageId, sql.placeholder("lastMessageId"))
					))
					.prepare()
			).get(by);
		}
		else if ("queueId" in by && "displayChannelId" in by) {
			return prepared("selectDisplayByQueueIdAndDisplayChannelId", () =>
				db.select().from(DISPLAY_TABLE)
					.where(and(
						eq(DISPLAY_TABLE.guildId, sql.placeholder("guildId")),
						eq(DISPLAY_TABLE.queueId, sql.placeholder("queueId")),
						eq(DISPLAY_TABLE.displayChannelId, sql.placeholder("displayChannelId"))
					))
					.prepare()
			).get(by);
		}
	}

	export function selectManyDisplays(by:
		{ guildId: Snowflake, queueId?: bigint } |
		{ guildId: Snowflake, displayChannelId?: Snowflake }
	) {
		if ("queueId" in by) {
			return prepared("selectManyDisplaysByGuildIdAndQueueId", () =>
				db.select().from(DISPLAY_TABLE)
					.where(and(
						eq(DISPLAY_TABLE.guildId, sql.placeholder("guildId")),
						eq(DISPLAY_TABLE.queueId, sql.placeholder("queueId"))
					))
					.prepare()
			).all(by);
		}
		else if ("displayChannelId" in by) {
			return prepared("selectManyDisplaysByGuildIdAndDisplayChannelId", () =>
				db.select().from(DISPLAY_TABLE)
					.where(and(
						eq(DISPLAY_TABLE.guildId, sql.placeholder("guildId")),
						eq(DISPLAY_TABLE.displayChannelId, sql.placeholder("displayChannelId"))
					))
					.prepare()
			).all(by);
		}
		else {
			return prepared("selectManyDisplaysByGuildId", () =>
				db.select().from(DISPLAY_TABLE)
					.where(eq(DISPLAY_TABLE.guildId, sql.placeholder("guildId")))
					.prepare()
			).all(by);
		}
	}

	// Members

	const MEMBER_ORDER = () => [
		sql`CASE WHEN ${MEMBER_TABLE.priorityOrder} IS NULL THEN 1 ELSE 0 END`,
		MEMBER_TABLE.priorityOrder,
		MEMBER_TABLE.positionTime,
	];

	export function selectMember(by:
		{ guildId: Snowflake, id: bigint } |
		{ guildId: Snowflake, queueId: bigint, userId?: Snowflake }
	) {
		if ("id" in by) {
			return prepared("selectMemberByGuildIdAndId", () =>
				db.select().from(MEMBER_TABLE)
					.where(and(
						eq(MEMBER_TABLE.guildId, sql.placeholder("guildId")),
						eq(MEMBER_TABLE.id, sql.placeholder("id"))
					))
					.prepare()
			).get(by);
		}
		else if ("queueId" in by && "userId" in by) {
			return prepared("selectMemberByGuildIdAndQueueIdAndUserId", () =>
				db.select().from(MEMBER_TABLE)
					.where(and(
						eq(MEMBER_TABLE.guildId, sql.placeholder("guildId")),
						eq(MEMBER_TABLE.queueId, sql.placeholder("queueId")),
						eq(MEMBER_TABLE.userId, sql.placeholder("userId"))
					))
					.prepare()
			).get(by);
		}
		else if ("queueId" in by) {
			return prepared("selectNextMemberByGuildIdAndQueueId", () =>
				db.select().from(MEMBER_TABLE)
					.where(and(
						eq(MEMBER_TABLE.guildId, sql.placeholder("guildId")),
						eq(MEMBER_TABLE.queueId, sql.placeholder("queueId"))
					))
					.orderBy(...MEMBER_ORDER())
					.prepare()
			).get(by);
		}
	}

	export function selectManyMembers(by:
		{ guildId: Snowflake, userId?: Snowflake } |
		{ guildId: Snowflake, queueId: bigint, count?: number }
	) {
		if ("userId" in by) {
			return prepared("selectManyMembersByGuildIdAndUserId", () =>
				db.select().from(MEMBER_TABLE)
					.where(and(
						eq(MEMBER_TABLE.guildId, sql.placeholder("guildId")),
						eq(MEMBER_TABLE.userId, sql.placeholder("userId"))
					))
					.orderBy(...MEMBER_ORDER())
					.prepare()
			).all(by);
		}
		else if ("queueId" in by && "count" in by) {
			return prepared("selectManyMembersByGuildIdAndQueueIdAndCount", () =>
				db.select().from(MEMBER_TABLE)
					.where(and(
						eq(MEMBER_TABLE.guildId, sql.placeholder("guildId")),
						eq(MEMBER_TABLE.queueId, sql.placeholder("queueId"))
					))
					.orderBy(...MEMBER_ORDER())
					.limit(sql.placeholder("count"))
					.prepare()
			).all(by);
		}
		else if ("queueId" in by) {
			return prepared("selectManyMembersByGuildIdAndQueueId", () =>
				db.select().from(MEMBER_TABLE)
					.where(and(
						eq(MEMBER_TABLE.guildId, sql.placeholder("guildId")),
						eq(MEMBER_TABLE.queueId, sql.placeholder("queueId"))
					))
					.orderBy(...MEMBER_ORDER())
					.prepare()
			).all(by);
		}
		else {
			return prepared("selectManyMembersByGuildId", () =>
				db.select().from(MEMBER_TABLE)
					.where(eq(MEMBER_TABLE.guildId, sql.placeholder("guildId")))
					.orderBy(...MEMBER_ORDER())
					.prepare()
			).all(by);
		}
	}

	// Schedules

	export function selectSchedule(by: { id: bigint }) {
		return prepared("selectScheduleById", () =>
			db.select().from(SCHEDULE_TABLE)
				.where(eq(SCHEDULE_TABLE.id, sql.placeholder("id")))
				.prepare()
		).get(by);
	}

	export function selectManySchedules(by: { guildId: Snowflake, queueId?: bigint }) {
		if ("queueId" in by) {
			return prepared("selectManySchedulesByGuildIdAndQueueId", () =>
				db.select().from(SCHEDULE_TABLE)
					.where(and(
						eq(SCHEDULE_TABLE.guildId, sql.placeholder("guildId")),
						eq(SCHEDULE_TABLE.queueId, sql.placeholder("queueId"))
					))
					.prepare()
			).all(by);
		}
		else {
			return prepared("selectManySchedulesByGuildId", () =>
				db.select().from(SCHEDULE_TABLE)
					.where(eq(SCHEDULE_TABLE.guildId, sql.placeholder("guildId")))
					.prepare()
			).all(by);
		}
	}

	export function selectAllSchedules() {
		return db.select().from(SCHEDULE_TABLE).all();
	}

	export function deleteSchedule(by: { guildId: Snowflake, id: bigint }) {
		return db.delete(SCHEDULE_TABLE)
			.where(and(
				eq(SCHEDULE_TABLE.guildId, by.guildId),
				eq(SCHEDULE_TABLE.id, by.id)
			))
			.returning().get();
	}

	// Whitelisted

	export function selectWhitelisted(by:
		{ guildId: Snowflake, id: bigint } |
		{ guildId: Snowflake, queueId: bigint, subjectId: Snowflake }
	) {
		if ("id" in by) {
			return prepared("selectWhitelistedByGuildIdAndId", () =>
				db.select().from(WHITELISTED_TABLE)
					.where(and(
						eq(WHITELISTED_TABLE.guildId, sql.placeholder("guildId")),
						eq(WHITELISTED_TABLE.id, sql.placeholder("id"))
					))
					.prepare()
			).get(by);
		}
		else if ("queueId" in by && "subjectId" in by) {
			return prepared("selectWhitelistedByGuildIdAndQueueIdAndSubjectId", () =>
				db.select().from(WHITELISTED_TABLE)
					.where(and(
						eq(WHITELISTED_TABLE.guildId, sql.placeholder("guildId")),
						eq(WHITELISTED_TABLE.queueId, sql.placeholder("queueId")),
						eq(WHITELISTED_TABLE.subjectId, sql.placeholder("subjectId"))
					))
					.prepare()
			).get(by);
		}
	}

	export function selectManyWhitelisted(by:
		{ guildId: Snowflake, subjectId?: Snowflake } |
		{ guildId: Snowflake, queueId?: bigint }
	) {
		if ("subjectId" in by) {
			return prepared("selectManyWhitelistedByGuildIdAndSubjectId", () =>
				db.select().from(WHITELISTED_TABLE)
					.where(and(
						eq(WHITELISTED_TABLE.guildId, sql.placeholder("guildId")),
						eq(WHITELISTED_TABLE.subjectId, sql.placeholder("subjectId"))
					))
					.prepare()
			).all(by);
		}
		else if ("queueId" in by) {
			return prepared("selectManyWhitelistedByGuildIdAndQueueId", () =>
				db.select().from(WHITELISTED_TABLE)
					.where(and(
						eq(WHITELISTED_TABLE.guildId, sql.placeholder("guildId")),
						eq(WHITELISTED_TABLE.queueId, sql.placeholder("queueId"))
					))
					.prepare()
			).all(by);
		}
		else if ("guildId" in by) {
			return prepared("selectManyWhitelistedByGuildId", () =>
				db.select().from(WHITELISTED_TABLE)
					.where(eq(WHITELISTED_TABLE.guildId, sql.placeholder("guildId")))
					.prepare()
			).all(by);
		}
	}

	// Blacklisted

	export function selectBlacklisted(by:
		{ guildId: Snowflake, id: bigint } |
		{ guildId: Snowflake, queueId: bigint, subjectId: Snowflake }
	) {
		if ("id" in by) {
			return prepared("selectBlacklistedByGuildIdAndId", () =>
				db.select().from(BLACKLISTED_TABLE)
					.where(and(
						eq(BLACKLISTED_TABLE.guildId, sql.placeholder("guildId")),
						eq(BLACKLISTED_TABLE.id, sql.placeholder("id"))
					))
					.prepare()
			).get(by);
		}
		else if ("queueId" in by && "subjectId" in by) {
			return prepared("selectBlacklistedByGuildIdAndQueueIdAndSubjectId", () =>
				db.select().from(BLACKLISTED_TABLE)
					.where(and(
						eq(BLACKLISTED_TABLE.guildId, sql.placeholder("guildId")),
						eq(BLACKLISTED_TABLE.queueId, sql.placeholder("queueId")),
						eq(BLACKLISTED_TABLE.subjectId, sql.placeholder("subjectId"))
					))
					.prepare()
			).get(by);
		}
	}

	export function selectManyBlacklisted(by:
		{ guildId: Snowflake, subjectId?: Snowflake } |
		{ guildId: Snowflake, queueId?: bigint }
	) {
		if ("subjectId" in by) {
			return prepared("selectManyBlacklistedByGuildIdAndSubjectId", () =>
				db.select().from(BLACKLISTED_TABLE)
					.where(and(
						eq(BLACKLISTED_TABLE.guildId, sql.placeholder("guildId")),
						eq(BLACKLISTED_TABLE.subjectId, sql.placeholder("subjectId"))
					))
					.prepare()
			).all(by);
		}
		else if ("queueId" in by) {
			return prepared("selectManyBlacklistedByGuildIdAndQueueId", () =>
				db.select().from(BLACKLISTED_TABLE)
					.where(and(
						eq(BLACKLISTED_TABLE.guildId, sql.placeholder("guildId")),
						eq(BLACKLISTED_TABLE.queueId, sql.placeholder("queueId"))
					))
					.prepare()
			).all(by);
		}
		else if ("guildId" in by) {
			return prepared("selectManyBlacklistedByGuildId", () =>
				db.select().from(BLACKLISTED_TABLE)
					.where(eq(BLACKLISTED_TABLE.guildId, sql.placeholder("guildId")))
					.prepare()
			).all(by);
		}
	}

	// Prioritized

	export function selectPrioritized(by:
		{ guildId: Snowflake, id: bigint } |
		{ guildId: Snowflake, queueId: bigint, subjectId: Snowflake }
	) {
		if ("id" in by) {
			return prepared("selectPrioritizedByGuildIdAndId", () =>
				db.select().from(PRIORITIZED_TABLE)
					.where(and(
						eq(PRIORITIZED_TABLE.guildId, sql.placeholder("guildId")),
						eq(PRIORITIZED_TABLE.id, sql.placeholder("id"))
					))
					.prepare()
			).get(by);
		}
		else if ("queueId" in by && "subjectId" in by) {
			return prepared("selectPrioritizedByGuildIdAndQueueIdAndSubjectId", () =>
				db.select().from(PRIORITIZED_TABLE)
					.where(and(
						eq(PRIORITIZED_TABLE.guildId, sql.placeholder("guildId")),
						eq(PRIORITIZED_TABLE.queueId, sql.placeholder("queueId")),
						eq(PRIORITIZED_TABLE.subjectId, sql.placeholder("subjectId"))
					))
					.prepare()
			).get(by);
		}
	}

	export function selectManyPrioritized(by:
		{ guildId: Snowflake, subjectId?: Snowflake } |
		{ guildId: Snowflake, queueId?: bigint }
	) {
		if ("subjectId" in by) {
			return prepared("selectManyPrioritizedByGuildIdAndSubjectId", () =>
				db.select().from(PRIORITIZED_TABLE)
					.where(and(
						eq(PRIORITIZED_TABLE.guildId, sql.placeholder("guildId")),
						eq(PRIORITIZED_TABLE.subjectId, sql.placeholder("subjectId"))
					))
					.prepare()
			).all(by);
		}
		else if ("queueId" in by) {
			return prepared("selectManyPrioritizedByGuildIdAndQueueId", () =>
				db.select().from(PRIORITIZED_TABLE)
					.where(and(
						eq(PRIORITIZED_TABLE.guildId, sql.placeholder("guildId")),
						eq(PRIORITIZED_TABLE.queueId, sql.placeholder("queueId"))
					))
					.prepare()
			).all(by);
		}
		else if ("guildId" in by) {
			return prepared("selectManyPrioritizedByGuildId", () =>
				db.select().from(PRIORITIZED_TABLE)
					.where(eq(PRIORITIZED_TABLE.guildId, sql.placeholder("guildId")))
					.prepare()
			).all(by);
		}
	}

	// Admins

	export function selectAdmin(by:
		{ guildId: Snowflake, id: bigint } |
		{ guildId: Snowflake, subjectId: Snowflake }
	) {
		if ("id" in by) {
			return prepared("selectAdminById", () =>
				db.select().from(ADMIN_TABLE)
					.where(and(
						eq(ADMIN_TABLE.guildId, sql.placeholder("guildId")),
						eq(ADMIN_TABLE.id, sql.placeholder("id"))
					))
					.prepare()
			).get(by);
		}
		else if ("subjectId" in by) {
			return prepared("selectAdminByGuildIdAndSubjectId", () =>
				db.select().from(ADMIN_TABLE)
					.where(and(
						eq(ADMIN_TABLE.guildId, sql.placeholder("guildId")),
						eq(ADMIN_TABLE.subjectId, sql.placeholder("subjectId"))
					))
					.prepare()
			).get(by);
		}
	}

	export function selectManyAdmins(by: { guildId: Snowflake, subjectId?: Snowflake }) {
		if ("subjectId" in by) {
			return prepared("selectManyAdminsByGuildIdAndSubjectId", () =>
				db.select().from(ADMIN_TABLE)
					.where(and(
						eq(ADMIN_TABLE.guildId, sql.placeholder("guildId")),
						eq(ADMIN_TABLE.subjectId, sql.placeholder("subjectId"))
					))
					.prepare()
			).all(by);
		}
		else {
			return prepared("selectManyAdminsByGuildId", () =>
				db.select().from(ADMIN_TABLE)
					.where(eq(ADMIN_TABLE.guildId, sql.placeholder("guildId")))
					.prepare()
			).all(by);
		}
	}

	// Archived Members

	export function selectArchivedMember(by:
		{ guildId: Snowflake, id: bigint } |
		{ guildId: Snowflake, queueId: bigint, userId: Snowflake }
	) {
		if ("id" in by) {
			return prepared("selectArchivedMemberByGuildIdAndId", () =>
				db.select().from(ARCHIVED_MEMBER_TABLE)
					.where(and(
						eq(ARCHIVED_MEMBER_TABLE.guildId, sql.placeholder("guildId")),
						eq(ARCHIVED_MEMBER_TABLE.id, sql.placeholder("id"))
					))
					.prepare()
			).get(by);
		}
		else if ("queueId" in by && "userId" in by) {
			return prepared("selectArchivedMemberByGuildIdAndQueueIdAndUserId", () =>
				db.select().from(ARCHIVED_MEMBER_TABLE)
					.where(and(
						eq(ARCHIVED_MEMBER_TABLE.guildId, sql.placeholder("guildId")),
						eq(ARCHIVED_MEMBER_TABLE.queueId, sql.placeholder("queueId")),
						eq(ARCHIVED_MEMBER_TABLE.userId, sql.placeholder("userId"))
					))
					.prepare()
			).get(by);
		}
	}

	export function selectManyArchivedMembers(by:
		{ guildId: Snowflake, userId?: Snowflake } |
		{ guildId: Snowflake, queueId?: bigint }
	) {
		if ("userId" in by) {
			return prepared("selectManyArchivedMembersByGuildIdAndUserId", () =>
				db.select().from(ARCHIVED_MEMBER_TABLE)
					.where(and(
						eq(ARCHIVED_MEMBER_TABLE.guildId, sql.placeholder("guildId")),
						eq(ARCHIVED_MEMBER_TABLE.userId, sql.placeholder("userId"))
					))
					.prepare()
			).all(by);
		}
		else if ("queueId" in by) {
			return prepared("selectManyArchivedMembersByGuildIdAndQueueId", () =>
				db.select().from(ARCHIVED_MEMBER_TABLE)
					.where(and(
						eq(ARCHIVED_MEMBER_TABLE.guildId, sql.placeholder("guildId")),
						eq(ARCHIVED_MEMBER_TABLE.queueId, sql.placeholder("queueId"))
					))
					.prepare()
			).all(by);
		}
		else {
			return prepared("selectManyArchivedMembersByGuildId", () =>
				db.select().from(ARCHIVED_MEMBER_TABLE)
					.where(eq(ARCHIVED_MEMBER_TABLE.guildId, sql.placeholder("guildId")))
					.prepare()
			).all(by);
		}
	}

	// Patch Notes

	export function selectAllPatchNotes() {
		return db.select().from(PATCH_NOTE_TABLE).all();
	}

	export function insertPatchNotes(patchNote: NewPatchNote) {
		return db.insert(PATCH_NOTE_TABLE).values(patchNote).returning().get();
	}

	export function selectPullEvent(by: { guildId: Snowflake, id: bigint }) {
		return db.select().from(PULL_EVENT_TABLE)
			.where(and(
				eq(PULL_EVENT_TABLE.guildId, by.guildId),
				eq(PULL_EVENT_TABLE.id, by.id),
			))
			.get();
	}

	export function deleteOldPullEvents() {
		const oneDayAgo = BigInt(Date.now() - 24 * 60 * 60 * 1000);
		return db.delete(PULL_EVENT_TABLE).where(lt(PULL_EVENT_TABLE.pulledAt, oneDayAgo)).run();
	}
}
