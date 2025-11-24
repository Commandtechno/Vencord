import { OptionType } from '@utils/types';
import { definePluginSettings } from '@api/Settings';

export const settings = definePluginSettings({
  apiKey: {
    type: OptionType.STRING,
    description: "Runpod API Key",
  },
  endpoint: {
    type: OptionType.STRING,
    description: "Runpod API Endpoint",
  },
});