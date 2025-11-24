/*
 * Vencord, a modification for Discord's desktop app
 * Copyright (c) 2022 Vendicated and contributors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */

import './styles.css';

import { addMessageAccessory } from "@api/MessageAccessories";
import { Devs } from "@utils/constants";
import definePlugin from "@utils/types";
import { TranscriptionAccessory } from "./TranscriptionAccesory";
import { settings } from './settings';

export default definePlugin({
  name: "Transcriber",
  authors: [Devs.Commandtechno],
  description: Math.random() > 0.5 ? "le transcripteur" : 'der transkribierer',
  settings,
  start() {
    addMessageAccessory("transcribe", props => <TranscriptionAccessory message={props.message} />);
  },
});
