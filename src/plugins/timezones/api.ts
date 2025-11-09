import { settings } from "./settings";

const API = "https://commandtechno.com/vctz";

export const userTimezones = new Map();

export const setTimezone = async (userId: string, tz: string) => {
  userTimezones.set(userId, tz);
  const res = await fetch(
    `https://commandtechno.com/vctz/store?token=${settings.store.apiToken
    }&id=${userId}&tz=${encodeURIComponent(tz)}`
  );

  return res.ok;
};

export const refreshTimezones = async () => {
  const latestTimezones = (await fetch(
    `${API}/list?token=${settings.store.apiToken}`
  ).then((res) => res.json())) as Record<string, string>;

  userTimezones.clear();
  for (const [id, tz] of Object.entries(latestTimezones))
    userTimezones.set(id, tz);
};
