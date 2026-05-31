import { ChannelType, Collection } from "discord.js";

import type { DbQueue } from "../../db/schema.ts";
import type { UIOption } from "../../types/handler.types.ts";
import type { AutocompleteInteraction, SlashInteraction } from "../../types/interaction.types.ts";
import type { AutoCompleteOptions } from "../base-option.ts";
import { QueuesOption } from "./queues.option.ts";

/**
 * A variant of QueuesOption used by /pull that filters out queues whose
 * tagId requirement is not met by the current forum thread's applied tags.
 *
 * - If the interaction channel is not a forum thread, all queues are shown.
 * - If the channel is a forum thread, only queues with no tagId OR whose
 *   tagId is in the thread's appliedTags are shown.
 */
export class PullQueuesOption extends QueuesOption {
	// Use the same ID as QueuesOption so the Discord option name stays "queues"
	static override ID = "queues";

	/**
	 * Filter a collection of queues to only those accessible in the given channel.
	 */
	static filterByChannel(
		queues: Collection<bigint, DbQueue>,
		inter: AutocompleteInteraction | SlashInteraction,
	): Collection<bigint, DbQueue> {
		const channel = inter.channel as any;
		if (
			!channel ||
			(channel.type !== ChannelType.PublicThread && channel.type !== ChannelType.PrivateThread)
		) {
			return queues;
		}

		const appliedTagIds: string[] = channel.appliedTags ?? [];
		return queues.filter(queue => !queue.tagId || appliedTagIds.includes(queue.tagId));
	}

	getAutocompletions = async (options: AutoCompleteOptions): Promise<UIOption[]> => {
		const { inter } = options;
		const queues = PullQueuesOption.filterByChannel(inter.store.dbQueues(), inter);

		return queues.size > 0
			? queues.map(queue => ({ name: queue.name, value: queue.id.toString() }))
			: [{ name: "No queues available in this forum post", value: "" }];
	};

	protected async getUncached(inter: AutocompleteInteraction | SlashInteraction) {
		const filtered = PullQueuesOption.filterByChannel(inter.store.dbQueues(), inter);
		// Temporarily swap dbQueues so the parent logic operates on the filtered set
		const originalDbQueues = inter.store.dbQueues;
		inter.store.dbQueues = () => filtered;
		const result = await super.getUncached(inter);
		inter.store.dbQueues = originalDbQueues;
		return result;
	}
}
