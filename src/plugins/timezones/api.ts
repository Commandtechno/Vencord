import * as DataStore from '@api/DataStore';

const DATASTORE_KEY = "vencord-tzdb";

export const userTimezones = new Map<string, string>();

export const setTimezone = async (userId: string, tz: string) => {
  userTimezones.set(userId, tz);
  await DataStore.set(DATASTORE_KEY, userTimezones);
};

export const refreshTimezones = async () => {
  const tzdb = await DataStore.get<Map<string, string>>(DATASTORE_KEY);
  if (!tzdb) return;


  for (const [userId, tz] of tzdb) {
    userTimezones.set(userId, tz);
  }
};
