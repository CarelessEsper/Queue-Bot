import { StringOption } from "../base-option.ts";

export class TagIdOption extends StringOption {
	static readonly ID = "tag_id";
	id = TagIdOption.ID;
}
