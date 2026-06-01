import { RoleOption } from "../base-option.ts";

export class RoleToRemoveOnJoinOption extends RoleOption {
	static readonly ID = "role_to_remove_on_join";
	id = RoleToRemoveOnJoinOption.ID;
}
