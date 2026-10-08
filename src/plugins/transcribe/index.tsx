/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./styles.css";

import { addMessageAccessory } from "@api/MessageAccessories";
import { Devs } from "@utils/constants";
import definePlugin from "@utils/types";

import { TranscriptionAccessory } from "./TranscriptionAccesory";

export default definePlugin({
  name: "Transcriber",
  authors: [Devs.Commandtechno],
  description: Math.random() > 0.5 ? "le transcripteur" : "der transkribierer",
  start() {
    addMessageAccessory("transcribe", props => <TranscriptionAccessory message={props.message} />);
  },
});
