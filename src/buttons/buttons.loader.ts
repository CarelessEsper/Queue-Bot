import { Collection } from "discord.js";

import type { Button } from "../types/button.types.ts";
import { ExtendStayButton } from "./buttons/extend-stay.button.ts";
import { JoinButton } from "./buttons/join.button.ts";
import { LeaveButton } from "./buttons/leave.button.ts";
import { LeaveQueueButton } from "./buttons/leave-queue.button.ts";
import { MyPositionsButton } from "./buttons/my-positions.button.ts";
import { PullButton } from "./buttons/pull.button.ts";

export const BUTTONS = new Collection<string, Button>([
	[ExtendStayButton.ID, new ExtendStayButton()],
	[JoinButton.ID, new JoinButton()],
	[LeaveButton.ID, new LeaveButton()],
	[LeaveQueueButton.ID, new LeaveQueueButton()],
	[MyPositionsButton.ID, new MyPositionsButton()],
	[PullButton.ID, new PullButton()],
]);
