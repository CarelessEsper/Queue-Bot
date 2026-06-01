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

function timerKey(queueId: bigint, userId: Snowflake): string {
	return `${queueId}:${userId}`;
}

export namespace AutoRemoveUtils {
	/**
	 * Schedule an auto-remove timer for a member.
	 * When the timer fires, the member is sent a DM with an "Extend Stay" button.
	 * If they don't respond within 2 minutes, they are removed from the queue.
	 */
	export function schedule(guildId: Snowflake, queueId: bigint, userId: Snowflake, delayMs: number): void {
		cancel(queueId, userId);

		const key = timerKey(queueId, userId);
		const timer = setTimeout(async () => {
			autoRemoveTimers.delete(key);
			await promptExtendOrRemove(guildId, queueId, userId);
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
	}

	/**
	 * On bot startup, re-schedule auto-remove timers for all existing members
	 * whose queues have autoRemovePeriod > 0.
	 */
	export function loadAll(): void {
		const allQueues = Queries.selectAllQueues();
		const now = BigInt(Date.now());

		// Stagger expired members so they don't all fire at once on restart,
		// which would cause a burst of DM sends and hit Discord rate-limits.
		const STAGGER_INTERVAL_MS = 500;
		let expiredStaggerMs = 0;

		for (const queue of allQueues) {
			if (!queue.autoRemovePeriod || queue.autoRemovePeriod <= 0n) continue;

			const members = Queries.selectManyMembers({ guildId: queue.guildId, queueId: queue.id });
			for (const member of members) {
				const periodMs = Number(queue.autoRemovePeriod) * 1000;
				const elapsed = Number(now - member.joinTime);
				const remaining = periodMs - elapsed;

				if (remaining <= 0) {
					// Already expired — spread these out to avoid a thundering herd
					schedule(queue.guildId, queue.id, member.userId, expiredStaggerMs);
					expiredStaggerMs += STAGGER_INTERVAL_MS;
				}
				else {
					schedule(queue.guildId, queue.id, member.userId, remaining);
				}
			}
		}
	}

	// ====================================================================
	//                           Helpers
	// ====================================================================

	/**
	 * Send the member a DM with an "Extend Stay" button.
	 * If they don't click it within 2 minutes, remove them from the queue.
	 */
	async function promptExtendOrRemove(guildId: Snowflake, queueId: bigint, userId: Snowflake): Promise<void> {
		const key = timerKey(queueId, userId);

		try {
			const guild = await ClientUtils.getGuild(guildId);
			if (!guild) return;

			const store = new Store(guild);
			const queue = store.dbQueues().get(queueId);
			if (!queue) return;

			// Confirm member is still in the queue
			const member = store.dbMembers().find(m => m.queueId === queueId && m.userId === userId);
			if (!member) return;

			const jsMember = await store.jsMember(userId);
			if (!jsMember) return;

			// Build the extend button
			const customId = ExtendStayButton.buildCustomId(guildId, queueId, userId);
			const extendButton = new ButtonBuilder()
				.setCustomId(customId)
				.setLabel("Extend Stay")
				.setStyle(ButtonStyle.Success);

			const leaveButton = new ButtonBuilder()
				.setCustomId(LeaveQueueButton.buildCustomId(guildId, queueId, userId))
				.setLabel("Leave Queue")
				.setStyle(ButtonStyle.Secondary);

			const row = new ActionRowBuilder<ButtonBuilder>().addComponents(extendButton, leaveButton);

			const embed = new EmbedBuilder()
				.setColor(queue.color as any)
				.setTitle("Your queue time will expire soon")
				.setDescription(
					`Your time in the ${queueMention(queue)} queue will expire in 2 minutes.\n\n` +
					`Click **Extend Stay** to stay in the queue for another **${timeMention(queue.autoRemovePeriod)}**, ` +
					`or you will be automatically removed.`
				);

			// Send DM — if it fails (DMs closed), remove immediately
			const dm = await jsMember.user.send({ embeds: [embed], components: [row] }).catch(() => null);
			if (!dm) {
				await removeMember(store, queue, userId);
				return;
			}

			// Schedule removal after 2 minutes if they don't respond
			const removalTimer = setTimeout(async () => {
				pendingExtendPrompts.delete(key);

				// Edit the DM to show it expired
				dm.edit({
					embeds: [
						new EmbedBuilder()
							.setColor(queue.color as any)
							.setDescription(`Time's up — you have been removed from the ${queueMention(queue)} queue. You will need to rejoin the queue to continue.`),
					],
					components: [],
				}).catch(() => null);

				// Re-fetch store in case state changed
				const freshGuild = await ClientUtils.getGuild(guildId);
				if (!freshGuild) return;
				const freshStore = new Store(freshGuild);
				const freshQueue = freshStore.dbQueues().get(queueId);
				if (!freshQueue) return;

				await removeMember(freshStore, freshQueue, userId);
			}, 2 * 60 * 1000);

			pendingExtendPrompts.set(key, removalTimer);
		}
		catch (e) {
			console.error(`[AutoRemove] Failed to prompt ${userId} in queue ${queueId}:`, e);
			// Fall back to immediate removal
			try {
				const guild = await ClientUtils.getGuild(guildId);
				if (!guild) return;
				const store = new Store(guild);
				const queue = store.dbQueues().get(queueId);
				if (queue) await removeMember(store, queue, userId);
			}
			catch (fallbackErr) {
				console.error(`[AutoRemove] Fallback removal also failed for ${userId}:`, fallbackErr);
			}
		}
	}

	async function removeMember(store: Store, queue: ReturnType<Store["dbQueues"]> extends Map<any, infer V> ? V : never, userId: Snowflake): Promise<void> {
		// Confirm still in queue before removing
		const stillInQueue = store.dbMembers().find(m => m.queueId === queue.id && m.userId === userId);
		if (!stillInQueue) return;

		await MemberUtils.deleteMembers({
			store,
			queues: [queue],
			reason: MemberRemovalReason.Kicked,
			by: { userId },
			force: true,
		}).catch(e => console.error(`[AutoRemove] Failed to remove ${userId} from queue ${queue.id}:`, e));
	}
}
