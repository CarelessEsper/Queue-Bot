import { QUEUE_TABLE } from "../../db/schema.ts";
import { IntegerOption } from "../base-option.ts";

export class AutoRemovePeriodOption extends IntegerOption {
	static readonly ID = "auto_remove_period";
	id = AutoRemovePeriodOption.ID;
	defaultValue = 0;
	minValue = 0;
}
