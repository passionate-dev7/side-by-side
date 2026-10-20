import type { ToolModule } from "./shared.js";
import { register as registerFamilyTools } from "./family-tools.js";

/** Product tools drop in here: each module registers its tools and UI resources on the server. */
export const toolModules: ToolModule[] = [registerFamilyTools];
