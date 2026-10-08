/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Small natural-language time parser for "when to purge from" inputs. Always resolves to a point
// in the past: an ambiguous input like "5pm" or "monday" means the most recent one, not the next.
//
// Understands, roughly:
//   durations       "30m", "2h30m", "2 hours", "1 hour and 30 minutes ago", "half an hour ago"
//   last/past       "last hour", "past 3 days", "last week"
//   day words       "today", "yesterday", "day before yesterday", "this morning", "last night"
//   weekdays        "monday", "last fri", "tuesday at 3pm"
//   times of day    "5pm", "5:30 pm", "17:30", "noon", "midnight" (combinable with any day)
//   dates           "oct 3", "3rd of october 2025", "2026-10-01", "10/3" (locale order)
//   anything else Date.parse understands (ISO strings, etc.)

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

/** Fixed-length units are in ms; months/years are calendar units, handled separately. */
const UNITS: Record<string, { ms?: number; months?: number; }> = {};
function unit(value: { ms?: number; months?: number; }, ...names: string[]) {
    for (const name of names) UNITS[name] = value;
}
unit({ ms: SECOND }, "s", "sec", "secs", "second", "seconds");
unit({ ms: MINUTE }, "m", "min", "mins", "minute", "minutes");
unit({ ms: HOUR }, "h", "hr", "hrs", "hour", "hours");
unit({ ms: DAY }, "d", "day", "days");
unit({ ms: WEEK }, "w", "wk", "wks", "week", "weeks");
unit({ months: 1 }, "mo", "mos", "month", "months");
unit({ months: 12 }, "y", "yr", "yrs", "year", "years");

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

// Discord's epoch — nothing can be older than this.
const MIN_YEAR = 2015;

/** Matches "mon", "tues", "wednesday", "sept"… against a list of full names. */
function matchName(word: string, names: string[]) {
    if (word.length < 3) return -1;
    return names.findIndex(name => name.startsWith(word));
}

function startOfDay(date: Date) {
    const d = new Date(date);
    d.setHours(0, 0, 0, 0);
    return d;
}

function addDays(date: Date, days: number) {
    const d = new Date(date);
    d.setDate(d.getDate() + days);
    return d;
}

function parseDuration(input: string, now: Date): Date | null {
    let s = input
        .replace(/^(?:the\s+)?(?:last|past|previous)\s+/, "")
        .replace(/\s+ago$/, "")
        .replace(/\bhalf\s+(?:an?\s+)?/g, "0.5 ")
        .replace(/\b(?:an?|one)\s+/g, "1 ")
        .replace(/\band\b/g, " ")
        .trim();

    // "last hour" / "past week" (but not a lone abbreviation like "m")
    if (UNITS[s] && s.length > 2) s = `1 ${s}`;

    let ms = 0, months = 0, matched = false;
    const re = /\s*(\d+(?:\.\d+)?)\s*([a-z]+)/y;
    let m: RegExpExecArray | null;
    while ((m = re.exec(s))) {
        const u = UNITS[m[2]];
        if (!u) return null;
        const n = Number(m[1]);
        ms += (u.ms ?? 0) * n;
        months += (u.months ?? 0) * n;
        matched = true;
        if (re.lastIndex === s.length) break;
    }
    if (!matched || re.lastIndex !== s.length) return null;

    const date = new Date(now.getTime() - ms);
    if (months) date.setMonth(date.getMonth() - Math.round(months));
    return date;
}

interface TimeOfDay {
    hours: number;
    minutes: number;
    seconds: number;
}

function extractTimeOfDay(s: string): { time: TimeOfDay | null; rest: string; } {
    const take = (m: RegExpExecArray, time: TimeOfDay | null) => ({
        time,
        rest: (s.slice(0, m.index) + " " + s.slice(m.index + m[0].length)).trim(),
    });

    let m: RegExpExecArray | null;
    if ((m = /\b(?:noon|midday)\b/.exec(s))) return take(m, { hours: 12, minutes: 0, seconds: 0 });
    if ((m = /\bmidnight\b/.exec(s))) return take(m, { hours: 0, minutes: 0, seconds: 0 });

    // 12h: "5pm", "5 pm", "5:30pm", "5 p.m."
    if ((m = /\b(\d{1,2})(?::(\d{2}))?(?::(\d{2}))?\s*([ap])\.?m?\.?(?=\s|$)/.exec(s))) {
        const h = Number(m[1]), min = Number(m[2] ?? 0), sec = Number(m[3] ?? 0);
        if (h < 1 || h > 12 || min > 59 || sec > 59) return take(m, null);
        return take(m, { hours: (h % 12) + (m[4] === "p" ? 12 : 0), minutes: min, seconds: sec });
    }

    // 24h: "17:30", "9:05:10"
    if ((m = /\b(\d{1,2}):(\d{2})(?::(\d{2}))?\b/.exec(s))) {
        const h = Number(m[1]), min = Number(m[2]), sec = Number(m[3] ?? 0);
        if (h > 23 || min > 59 || sec > 59) return take(m, null);
        return take(m, { hours: h, minutes: min, seconds: sec });
    }

    return { time: null, rest: s };
}

/** Whether the user's locale writes numeric dates day-first (10/3 = 10 March) or month-first. */
function isDayFirstLocale() {
    try {
        const parts = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "numeric" }).formatToParts(new Date(2000, 11, 31));
        return parts.findIndex(p => p.type === "day") < parts.findIndex(p => p.type === "month");
    } catch {
        return false;
    }
}

/** A calendar date; if no year is given, the most recent occurrence that isn't in the future. */
function makeDate(year: number | null, month: number, day: number, now: Date): Date | null {
    if (year != null && year < 100) year += 2000;
    let d = new Date(year ?? now.getFullYear(), month, day);
    if (d.getMonth() !== month || d.getDate() !== day) return null;
    if (year == null && d > now) d = new Date(now.getFullYear() - 1, month, day);
    return d;
}

interface DayPart {
    date: Date;
    /** Hour used when no time of day was given, e.g. "this evening" → 18:00. */
    defaultHour?: number;
}

function parseDay(s: string, now: Date): DayPart | null {
    const today = startOfDay(now);

    switch (s) {
        case "":
        case "today":
            return { date: today };
        case "this morning":
            return { date: today, defaultHour: 6 };
        case "this afternoon":
            return { date: today, defaultHour: 12 };
        case "this evening":
        case "tonight":
            return { date: today, defaultHour: 18 };
        case "yesterday":
            return { date: addDays(today, -1) };
        case "last night":
        case "yesterday evening":
            return { date: addDays(today, -1), defaultHour: 18 };
        case "yesterday morning":
            return { date: addDays(today, -1), defaultHour: 6 };
        case "yesterday afternoon":
            return { date: addDays(today, -1), defaultHour: 12 };
        case "day before yesterday":
        case "the day before yesterday":
            return { date: addDays(today, -2) };
    }

    let m: RegExpExecArray | null;

    // "monday", "last friday", "this tue"
    if ((m = /^(?:(last|past|previous|this)\s+)?([a-z]+)$/.exec(s))) {
        const weekday = matchName(m[2], WEEKDAYS);
        if (weekday !== -1) {
            let diff = (today.getDay() - weekday + 7) % 7;
            if (diff === 0 && m[1] && m[1] !== "this") diff = 7;
            return { date: addDays(today, -diff) };
        }
    }

    // "oct 3", "october 3rd 2025"
    if ((m = /^([a-z]+)\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:\s+(\d{4}))?$/.exec(s))) {
        const month = matchName(m[1], MONTHS);
        if (month !== -1) {
            const date = makeDate(m[3] ? Number(m[3]) : null, month, Number(m[2]), now);
            if (date) return { date };
        }
    }

    // "3 oct", "3rd of october 2025"
    if ((m = /^(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?([a-z]+)\.?(?:\s+(\d{4}))?$/.exec(s))) {
        const month = matchName(m[2], MONTHS);
        if (month !== -1) {
            const date = makeDate(m[3] ? Number(m[3]) : null, month, Number(m[1]), now);
            if (date) return { date };
        }
    }

    // "2026-10-03"
    if ((m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s))) {
        const date = makeDate(Number(m[1]), Number(m[2]) - 1, Number(m[3]), now);
        if (date) return { date };
    }

    // "10/3", "10/3/2026", "3.10.26"
    if ((m = /^(\d{1,2})[/.](\d{1,2})(?:[/.](\d{2}|\d{4}))?$/.exec(s))) {
        const [a, b] = [Number(m[1]), Number(m[2])];
        const [day, month] = isDayFirstLocale() ? [a, b] : [b, a];
        const date = makeDate(m[3] ? Number(m[3]) : null, month - 1, day, now);
        if (date) return { date };
    }

    // "2 days ago" (so "2 days ago at 5pm" works)
    const relative = parseDuration(s, now);
    if (relative) return { date: startOfDay(relative) };

    return null;
}

/**
 * Parses a natural-language point in time. Returns null if the input wasn't understood.
 * The result may be in the future (e.g. an explicit future date); callers should validate.
 */
export function parseTime(input: string, now = new Date()): Date | null {
    const original = input.trim();
    const s = original
        .toLowerCase()
        .replace(/,/g, " ")
        .replace(/\s+/g, " ")
        .replace(/^(?:since|from|after|starting)\s+/, "")
        .trim();

    if (!s) return null;
    if (s === "now") return now;

    // Discord timestamp markdown: <t:1700000000:R>
    const m = /^<t:(-?\d+)(?::[a-z])?>$/i.exec(original);
    if (m) return new Date(Number(m[1]) * 1000);

    // Unix timestamps (seconds or milliseconds)
    if (/^\d{10}$/.test(s)) return new Date(Number(s) * 1000);
    if (/^\d{13}$/.test(s)) return new Date(Number(s));

    const duration = parseDuration(s, now);
    if (duration) return duration;

    const { time, rest } = extractTimeOfDay(s);
    const dayText = rest.replace(/(?:^|\s)(?:at|on|the|@)(?=\s|$)/g, " ").replace(/\s+/g, " ").trim();
    // Only bail on an empty day part if there was no time either, otherwise "5pm" alone is fine.
    const day = (time || dayText) ? parseDay(dayText, now) : null;

    if (day) {
        const date = new Date(day.date);
        if (time) date.setHours(time.hours, time.minutes, time.seconds, 0);
        else date.setHours(day.defaultHour ?? 0, 0, 0, 0);

        // A bare time like "5pm" means the most recent 5pm.
        if (time && !dayText && date > now) date.setDate(date.getDate() - 1);
        return date;
    }

    const parsed = Date.parse(original);
    if (!Number.isNaN(parsed)) {
        const date = new Date(parsed);
        if (date.getFullYear() >= MIN_YEAR) return date;
    }

    return null;
}
