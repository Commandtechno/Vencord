import { definePluginSettings } from "@api/Settings";
import { OptionType } from "@utils/types";

export const settings = definePluginSettings({
  apiToken: {
    type: OptionType.STRING,
    description: "Token to access Techno's awesome VCTZDB",
  },
  showInUserProfileModal: {
    type: OptionType.BOOLEAN,
    description:
      "Show a user's Timezone indicator in their profile next to the name",
    default: true,
    restartNeeded: true,
  },
  showInMemberList: {
    type: OptionType.BOOLEAN,
    description:
      "Show a user's Timezone indicator in the member and DMs list",
    default: true,
    restartNeeded: true,
  },
  showInMessages: {
    type: OptionType.BOOLEAN,
    description: "Show a user's Timezone indicator in messages",
    default: true,
    restartNeeded: true,
  },
});
