/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./style.css";

import {
  ApplicationCommandInputType,
  ApplicationCommandOptionType,
  findOption,
  sendBotMessage,
} from "@api/Commands";
import {
  addMemberListDecorator,
  removeMemberListDecorator,
} from "@api/MemberListDecorators";
import {
  addMessageDecoration,
  removeMessageDecoration,
} from "@api/MessageDecorations";
import { Devs } from "@utils/constants";
import definePlugin from "@utils/types";

import { refreshTimezones, setTimezone, userTimezones } from "./api";
import { TimezoneIndicator } from "./components";
import { settings } from "./settings";

export default definePlugin({
  name: "Timezones",
  description: "Show user's timezones next to their names",
  authors: [Devs.Commandtechno],
  dependencies: ["MemberListDecoratorsAPI", "MessageDecorationsAPI"],
  settings,

  patches: [
    // User Popout, User Profile Modal, Direct Messages Side Profile
    {
      find: "#{intl::USER_PROFILE_LOAD_ERROR}",
      replacement: {
        match: /(\.fetchError.+?\?)null/,
        replace: (_, rest) =>
          `${rest}$self.TimezoneIndicator({userId:arguments[0]?.userId,isProfile:true})`,
      },
      predicate: () => settings.store.showInUserProfileModal,
    },
    // To use without the MemberList decorator API
    /* // Guild Members List
{
    find: ".lostPermission)",
    replacement: {
        match: /\.lostPermission\).+?(?=avatar:)/,
        replace: "$&children:[$self.TimezoneIndicator({userId:arguments[0]?.user?.id})],"
    },
    predicate: () => settings.store.showVoiceChannelIndicator
},
// Direct Messages List
{
    find: "PrivateChannel.renderAvatar",
    replacement: {
        match: /#{intl::CLOSE_DM}.+?}\)(?=])/,
        replace: "$&,$self.TimezoneIndicator({userId:arguments[0]?.user?.id})"
    },
    predicate: () => settings.store.showVoiceChannelIndicator
}, */
    // Friends List
    {
      find: "null!=this.peopleListItemRef.current",
      replacement: {
        match: /\.actions,children:\[(?<=isFocused:(\i).+?)/,
        replace:
          "$&$self.TimezoneIndicator({userId:this?.props?.user?.id,isActionButton:true,shouldHighlight:$1}),",
      },
      predicate: () => settings.store.showInMemberList,
    },
  ],

  start() {
    if (settings.store.showInMemberList) {
      addMemberListDecorator("Timezone", ({ user }) =>
        user == null ? null : <TimezoneIndicator userId={user.id} />
      );
    }
    if (settings.store.showInMessages) {
      addMessageDecoration("Timezone", ({ message }) =>
        message?.author == null ? null : (
          <TimezoneIndicator userId={message.author.id} />
        )
      );
    }

    refreshTimezones();
  },

  stop() {
    removeMemberListDecorator("Timezone");
    removeMessageDecoration("Timezone");
  },

  commands: [
    {
      name: "set-tz",
      description: "Sets a user timezone",
      inputType: ApplicationCommandInputType.BUILT_IN,
      options: [
        {
          name: "user",
          description: "The user whose timezone you are setting",
          type: ApplicationCommandOptionType.USER,
          required: true,
        },
        {
          name: "tz",
          description: "The timezone of the user",
          type: ApplicationCommandOptionType.STRING,
          required: true,
          choices: Intl.supportedValuesOf("timeZone").map(tz => ({
            label: tz,
            name: tz,
            value: tz,
          })),
        },
      ],
      async execute(args, ctx) {
        const user: string | undefined = findOption(args, "user");
        const tz: string | undefined = findOption(args, "tz");
        if (!user || !tz) return;


        await setTimezone(user, tz);
        sendBotMessage(ctx.channel.id, {
          content: `set <@${user}> to ${tz}`,
        });
      },
    },
    {
      name: "refresh-tz",
      description: "Pull the latest timezones",
      inputType: ApplicationCommandInputType.BUILT_IN,
      async execute(args, ctx) {
        await refreshTimezones();
        sendBotMessage(ctx.channel.id, {
          content: `loaded ${userTimezones.size} timezones`,
        });
      },
    },
  ],

  TimezoneIndicator,
});
