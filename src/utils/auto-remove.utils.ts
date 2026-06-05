import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from "discord.js";
import type { Snowflake } from "discord.js";

import { Queries } from "../db/queries.ts";
import { Store } from "../db/store.ts";
import { MemberRemovalReason } from "../types/db.types.ts";
import { ExtendStayButton } from "../buttons/buttons/extend-stay.button.ts";
import { LeaveQueueButton } from "../buttons/buttons/leave-queue.button.ts";
import { ClientUtils } from "./client.utils.ts";
import { MemberUtils } from "./member.utils.ts";
import { queueMention, timeMention } from "./string.utils.ts";

/**
 * Manages in-memory timers that auto-remove members from queues after a configured period.
 * Key format: `${queueId}:${userId}`
 */
const autoRemoveTimers = new Map<string, ReturnType<typeof setTimeout>>();

/** Tracks pending "extend stay" prompts so we can cancel them if the member leaves early. */
const pendingExtendPrompts = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * Bundles expiry notifications for the same user across multiple queues.
 * Key: userId, Value: list of pending { guildId, queueId } entries and a debounce timer.
 */
const pendingBundles = new Map<Snowflake, {
	entries: { guildId: Snowflake, queueId: bigint }[],
	timer: ReturnType<typeof setTimeout>,
}>();

/** How long to wait for additional queues to expire before sending the bundled DM. */
const BUNDLE_DEBOUNCE_MS = 3_000;

function timerKey(queueId: bigint, userId: Snowflake): string {
	return `${queueId}:${userId}`;
}

export namespace AutoRemoveUtils {
	/**
	 * Schedule an auto-remove timer for a member.
	 * When the timer fires, the member is queued for a bundled DM prompt.
	 * If they don't respond within 2 minutes, they are removed from the queue.
	 */
	export function schedule(guildId: Snowflake, queueId: bigint, userId: Snowflake, delayMs: number): void {
		cancel(queueId, userId);

		const key = timerKey(queueId, userId);
		const timer = setTimeout(() => {
			autoRemoveTimers.delete(key);
			enqueueBundle(guildId, queueId, userId);
		}, delayMs);

		autoRemoveTimers.set(key, timer);
	}

	/**
	 * Cancel a pending auto-remove timer and any pending extend prompt for a member.
	 */
	export function cancel(queueId: bigint, userId: Snowflake): void {
		const key = timerKey(queueId, userId);

		const existing = autoRemoveTimers.get(key);
		if (existing) {
			clearTimeout(existing);
			autoRemoveTimers.delete(key);
		}

		const pendingPrompt = pendingExtendPrompts.get(key);
		if (pendingPrompt) {
			clearTimeout(pendingPrompt);
			pendingExtendPrompts.delete(key);
		}

		// Also remove from any pending bundle for this user
		const bundle = pendingBundles.get(userId);
		if (bundle) {
			bundle.entries = bundle.entries.filter(e => e.queueId !== queueId);
			if (bundle.entries.length === 0) {
				clearTimeout(bundle.timer);
				pendingBundles.delete(userId);
			}
		}
	}

	/**
	 * On bot startup, re-schedule auto-remove timers for all existing members
	 * whose queues have autoRemovePeriod > 0.
	 */
	export function loadAll(): void {
		const allQueues = Queries.selectAllQueues();
		const now = BigInt(Date.now());

		// Threshold: if a timer expired more than 3 minutes ago (the extend window),
		// the user couldn't have responded anyway — remove silently without DMing.
		const SILENT_REMOVAL_THRESHOLD_MS = 3 * 60 * 1000;

		// Stagger the ones that are still within the window to avoid a burst on restart.
		const STAGGER_INTERVAL_MS = 500;
		let expiredStaggerMs = 0;

		// Collect silent removals to process async after the sync loop
		const silentRemovals: { guildId: Snowflake, queueId: bigint, userId: Snowflake }[] = [];

		for (const queue of allQueues) {
			if (!queue.autoRemovePeriod || queue.autoRemovePeriod <= 0n) continue;

			const members = Queries.selectManyMembers({ guildId: queue.guildId, queueId: queue.id });
			for (const member of members) {
				const periodMs = Number(queue.autoRemovePeriod) * 1000;
				const elapsed = Number(now - member.joinTime);
				const remaining = periodMs - elapsed;

				if (remaining <= 0) {
					const overdueMs = -remaining;
					if (overdueMs > SILENT_REMOVAL_THRESHOLD_MS) {
						// Expired too long ago — collect for silent removal with logging
						silentRemovals.push({ guildId: queue.guildId, queueId: queue.id, userId: member.userId });
					}
					else {
						// Expired recently — still within the window, prompt normally with stagger
						schedule(queue.guildId, queue.id, member.userId, expiredStaggerMs);
						expiredStaggerMs += STAGGER_INTERVAL_MS;
					}
				}
				else {
					schedule(queue.guildId, queue.id, member.userId, remaining);
				}
			}
		}

		// Process silent removals sequentially with a delay between each to avoid
		// hitting Discord's rate limits on startup. Each removal makes multiple API
		// calls (role removal, display update, log message), so we pace them at
		// ~5/second to stay well under Discord's 50 req/s global limit.
		if (silentRemovals.length > 0) {
			(async () => {
				for (const { guildId, queueId, userId } of silentRemovals) {
					try {
						const guild = await ClientUtils.getGuild(guildId);
						if (!guild) continue;
						const store = new Store(guild);
						const queue = store.dbQueues().get(queueId);
						if (!queue) continue;
						await MemberUtils.deleteMembers({
							store,
							queues: [queue],
							reason: MemberRemovalReason.SilentExpired,
							by: { userId },
							force: true,
						});
					}
					catch (e) {
						console.error(`[AutoRemove] Silent removal failed for ${userId}:`, e);
					}
					// Pace to ~5 removals/second to respect Discord rate limits
					await new Promise(resolve => setTimeout(resolve, 200));
				}
			})();
		}
	}

	// ====================================================================
	//                           Helpers
	// ====================================================================

	/**
	 * Add a queue expiry to the user's pending bundle. If this is the first
	 * entry for this user, start the debounce timer. When the timer fires,
	 * all collected queues are sent in a single DM.
	 */
	function enqueueBundle(guildId: Snowflake, queueId: bigint, userId: Snowflake): void {
		const existing = pendingBundles.get(userId);

		if (existing) {
			// Another queue for the same user — add to bundle and reset timer
			existing.entries.push({ guildId, queueId });
			clearTimeout(existing.timer);
			existing.timer = setTimeout(() => flushBundle(userId), BUNDLE_DEBOUNCE_MS);
		}
		else {
			// First queue for this user — start the debounce window
			const timer = setTimeout(() => flushBundle(userId), BUNDLE_DEBOUNCE_MS);
			pendingBundles.set(userId, { entries: [{ guildId, queueId }], timer });
		}
	}

	/**
	 * Fire the bundled prompt for all queues that expired for this user.
	 */
	async function flushBundle(userId: Snowflake): Promise<void> {
		const bundle = pendingBundles.get(userId);
		if (!bundle) return;
		pendingBundles.delete(userId);

		// Resolve all queue/store pairs
		type QueueEntry = { store: Store, queue: ReturnType<Store["dbQueues"]> extends Map<any, infer V> ? V : never };
		const queueEntries: QueueEntry[] = [];

		for (const { guildId, queueId } of bundle.entries) {
			const guild = await ClientUtils.getGuild(guildId);
			if (!guild) continue;
			const store = new Store(guild);
			const queue = store.dbQueues().get(queueId);
			if (!queue) continue;
			const member = store.dbMembers().find(m => m.queueId === queueId && m.userId === userId);
			if (!member) continue;
			queueEntries.push({ store, queue });
		}

		if (queueEntries.length === 0) return;

		await promptExtendOrRemove(userId, queueEntries);
	}

	/**
	 * Send the member a single DM covering all expiring queues.
	 * One "Extend All Queues" button extends every queue at once.
	 * Individual "Leave" buttons are provided per queue.
	 * If DMs are closed, remove them from all queues immediately.
	 */
	async function promptExtendOrRemove(
		userId: Snowflake,
		queueEntries: { store: Store, queue: any }[],
	): Promise<void> {
		try {
			const { store } = queueEntries[0];
			const guildId = store.guild.id;
			const jsMember = await store.jsMember(userId);
			if (!jsMember) return;

			const queueNames = queueEntries.map(({ queue }) => queueMention(queue)).join(", ");
			const period = queueEntries[0].queue.autoRemovePeriod;

			const embed = new EmbedBuilder()
				.setTitle("Your queue time will expire soon")
				.setDescription(
					`Your time in ${queueNames} will expire in 3 minutes.\n\n` +
					`Click **Extend Time** to stay in the queue for another **${timeMention(period)}**, ` +
					`or you will be automatically removed.`
				);

			const extendAllButton = new ButtonBuilder()
				.setCustomId(ExtendStayButton.buildAllQueuesCustomId(guildId, userId))
				.setLabel("Extend Time")
				.setStyle(ButtonStyle.Success);

			const leaveAllButton = new ButtonBuilder()
				.setCustomId(LeaveQueueButton.buildAllQueuesCustomId(guildId, userId))
				.setLabel("Leave Queues")
				.setStyle(ButtonStyle.Danger);

			const row = new ActionRowBuilder<ButtonBuilder>().addComponents(extendAllButton, leaveAllButton);

			const dm = await jsMember.user.send({ embeds: [embed], components: [row] }).catch(() => null);

			if (!dm) {
				for (const { store: s, queue } of queueEntries) {
					await removeMember(s, queue, userId);
				}
				return;
			}

			// Schedule removal for each queue after 2 minutes
			for (const { store: s, queue } of queueEntries) {
				const key = timerKey(queue.id, userId);

				const removalTimer = setTimeout(async () => {
					pendingExtendPrompts.delete(key);

					dm.edit({
						embeds: [
							new EmbedBuilder()
								.setDescription(`Time's up — you didn't click **Extend Time** within 3 minutes, so you have been removed from the ${queueNames} queues. You will need to rejoin to continue.`),
						],
						components: [
							new ActionRowBuilder<ButtonBuilder>().addComponents(
								new ButtonBuilder()
									.setCustomId(ExtendStayButton.buildAllQueuesCustomId(guildId, userId))
									.setLabel("Extend Time")
									.setStyle(ButtonStyle.Success)
									.setDisabled(true),
								new ButtonBuilder()
									.setCustomId(LeaveQueueButton.buildAllQueuesCustomId(guildId, userId))
									.setLabel("Leave Queue(s)")
									.setStyle(ButtonStyle.Danger)
									.setDisabled(true),
							),
						],
					}).catch(() => null);

					const freshGuild = await ClientUtils.getGuild(s.guild.id);
					if (!freshGuild) return;
					const freshStore = new Store(freshGuild);
					const freshQueue = freshStore.dbQueues().get(queue.id);
					if (!freshQueue) return;

					await removeMember(freshStore, freshQueue, userId);
				}, 3 * 60 * 1000);

				pendingExtendPrompts.set(key, removalTimer);
			}
		}
		catch (e) {
			console.error(`[AutoRemove] Failed to prompt ${userId}:`, e);
			for (const { store: s, queue } of queueEntries) {
				try {
					await removeMember(s, queue, userId);
				}
				catch (fallbackErr) {
					console.error(`[AutoRemove] Fallback removal also failed for ${userId} in queue ${queue.id}:`, fallbackErr);
				}
			}
		}
	}

	async function removeMember(store: Store, queue: ReturnType<Store["dbQueues"]> extends Map<any, infer V> ? V : never, userId: Snowflake): Promise<void> {
		const stillInQueue = store.dbMembers().find(m => m.queueId === queue.id && m.userId === userId);
		if (!stillInQueue) return;

		await MemberUtils.deleteMembers({
			store,
			queues: [queue],
			reason: MemberRemovalReason.Expired,
			by: { userId },
			force: true,
		}).catch(e => console.error(`[AutoRemove] Failed to remove ${userId} from queue ${queue.id}:`, e));
	}
}
