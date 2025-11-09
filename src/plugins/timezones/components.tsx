/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { classNameFactory } from "@api/Styles";
import ErrorBoundary from "@components/ErrorBoundary";
import { classes } from "@utils/misc";
import { findByPropsLazy } from "@webpack";
import { Text, Tooltip } from "@webpack/common";
import { PropsWithChildren } from "react";
import { userTimezones } from "./api";

const cl = classNameFactory("tz-");


const ActionButtonClasses = findByPropsLazy("actionButton", "highlight");

type IconProps = Omit<React.ComponentPropsWithoutRef<"div">, "children"> & {
  size?: number;
  iconClassName?: string;
};

function Icon(props: PropsWithChildren<IconProps>) {
  const {
    size = 16,
    className,
    iconClassName,
    ...restProps
  } = props;

  return (
    <div
      {...restProps}
      className={classes(cl("clock"), className)}
    >
      <svg
        className={iconClassName}
        width={size}
        height={size}
        viewBox="0 -960 960 960"
        fill="currentColor"
      >
        {props.children}
      </svg>
    </div>
  );
}

function ClockIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="m612-292 56-56-148-148v-184h-80v216l172 172ZM480-80q-83 0-156-31.5T197-197q-54-54-85.5-127T80-480q0-83 31.5-156T197-763q54-54 127-85.5T480-880q83 0 156 31.5T763-763q54 54 85.5 127T880-480q0 83-31.5 156T763-197q-54 54-127 85.5T480-80Z" />
    </Icon>
  );
}



function TimezoneTooltip({ tz }: { tz: string; }) {
  return (
    <Text variant="text-sm/bold">{Intl.DateTimeFormat(undefined, { timeZone: tz, timeStyle: 'short' }).format()}</Text>
  );
}

export interface TimezoneIndicatorProps {
  userId: string;
  isProfile?: boolean;
  isActionButton?: boolean;
  shouldHighlight?: boolean;
}


export const TimezoneIndicator = ErrorBoundary.wrap(({ userId, isProfile, isActionButton, shouldHighlight }: TimezoneIndicatorProps) => {
  const tz = userTimezones.get(userId);
  if (!tz) return null;


  return (
    <Tooltip
      text={<TimezoneTooltip tz={tz} />}
      tooltipClassName={cl("tooltip-container")}
      tooltipContentClassName={cl("tooltip-content")}
    >
      {props => (
        <ClockIcon
          {...props}
          role="button"
          className={classes(cl("clickable"), isActionButton && ActionButtonClasses.actionButton, isActionButton && shouldHighlight && ActionButtonClasses.highlight)}
          iconClassName={classes(cl(isProfile && "profile-speaker"))}
          size={isActionButton ? 20 : 16}
        />
      )}
    </Tooltip>
  );
}, { noop: true });
