// @ts-nocheck
const RECENT_LOCAL_PARTS = new Set();

function randomPick(items) {
    return items[Math.floor(Math.random() * items.length)];
}

function randomInt(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

function maybe(value, probability = 0.5) {
    return Math.random() < probability ? value : "";
}

function normalizeLocalPart(value) {
    return String(value)
        .toLowerCase()
        .replace(/[^a-z0-9._-]+/g, "")
        .replace(/[._-]{2,}/g, (match) => match[0])
        .replace(/^[._-]+|[._-]+$/g, "");
}

function pad2(value) {
    return String(value).padStart(2, "0");
}

function randomYearSuffix() {
    const now = new Date();
    const currentYear = now.getFullYear();
    const year = randomInt(currentYear - 16, currentYear - 2);
    return String(year).slice(-2);
}

function randomMonthDay() {
    return `${pad2(randomInt(1, 12))}${pad2(randomInt(1, 28))}`;
}

function randomNaturalNumber() {
    const pool = [
        randomYearSuffix(),
        randomMonthDay(),
        `${randomInt(12, 99)}`,
        `${randomInt(100, 999)}`,
    ];
    return randomPick(pool);
}

function randomShortWord() {
    const words = [
        "blue", "bright", "clear", "cozy", "daily", "green", "happy", "mellow",
        "mint", "north", "quiet", "river", "solar", "sunny", "urban", "west",
    ];
    return randomPick(words);
}

function applyNaturalSuffix(base) {
    const normalizedBase = normalizeLocalPart(base);
    if (!normalizedBase) {
        return "";
    }

    if (/\d{2,}$/.test(normalizedBase)) {
        return normalizedBase;
    }

    const shouldAddNumber = normalizedBase.length < 8 || Math.random() < 0.72;
    if (!shouldAddNumber) {
        return normalizedBase;
    }

    const separator = Math.random() < 0.35 ? randomPick(["", ".", "_"]) : "";
    return normalizeLocalPart(`${normalizedBase}${separator}${randomNaturalNumber()}`);
}

function finalizeLocalPart(baseValue) {
    const normalizedBase = normalizeLocalPart(baseValue).slice(0, 28);
    let candidate = applyNaturalSuffix(normalizedBase) || normalizedBase;
    candidate = normalizeLocalPart(candidate).slice(0, 30).replace(/[._-]+$/g, "");

    let attempt = 0;
    while (!candidate || RECENT_LOCAL_PARTS.has(candidate)) {
        attempt += 1;
        const fallbackNumber =
            attempt <= 2
                ? randomNaturalNumber()
                : `${randomNaturalNumber()}${randomInt(0, 9)}`;
        const separator = randomPick(["", ".", "_"]);
        candidate = normalizeLocalPart(`${normalizedBase}${separator}${fallbackNumber}`)
            .slice(0, 30)
            .replace(/[._-]+$/g, "");
    }

    RECENT_LOCAL_PARTS.add(candidate);
    if (RECENT_LOCAL_PARTS.size > 20000) {
        const oldest = RECENT_LOCAL_PARTS.values().next().value;
        RECENT_LOCAL_PARTS.delete(oldest);
    }
    return candidate;
}

export function generateEmailName() {
    const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
    let candidate = "";
    let attempt = 0;

    while (!candidate || RECENT_LOCAL_PARTS.has(candidate)) {
        attempt += 1;
        const length = randomInt(6, 12);
        let nextValue = "";
        for (let index = 0; index < length; index += 1) {
            nextValue += chars[randomInt(0, chars.length - 1)];
        }
        candidate = nextValue;

        if (attempt > 20) {
            candidate = `${candidate}${randomInt(0, 9)}`;
        }
    }

    RECENT_LOCAL_PARTS.add(candidate);
    if (RECENT_LOCAL_PARTS.size > 20000) {
        const oldest = RECENT_LOCAL_PARTS.values().next().value;
        RECENT_LOCAL_PARTS.delete(oldest);
    }

    return candidate;
}

export function generateRealEmailName() {
    const firstNames = [
        "alex", "andrew", "anna", "ava", "bella", "brandon", "caleb", "chloe",
        "claire", "daniel", "david", "dylan", "ella", "emily", "emma", "ethan",
        "eva", "grace", "hannah", "harry", "isabella", "jack", "jacob", "james",
        "jason", "julia", "karen", "kevin", "lauren", "leo", "lily", "lucas",
        "lucy", "madison", "mark", "mason", "mia", "michael", "natalie", "nathan",
        "nicholas", "nicole", "noah", "olivia", "owen", "ryan", "sam", "sarah",
        "sophia", "stella", "thomas", "victoria", "william", "zoe",
    ];
    const lastNames = [
        "adams", "allen", "anderson", "bailey", "baker", "bell", "bennett", "brooks",
        "brown", "carter", "clark", "cole", "cooper", "davis", "edwards", "evans",
        "fisher", "garcia", "gray", "green", "griffin", "hall", "harris", "hayes",
        "hill", "howard", "hughes", "jackson", "johnson", "kennedy", "king", "lee",
        "lewis", "martin", "miller", "mitchell", "moore", "morgan", "nelson", "parker",
        "perry", "reed", "richardson", "rivera", "roberts", "robinson", "ross", "scott",
        "smith", "stone", "taylor", "turner", "walker", "ward", "watson", "white",
        "wilson", "wood", "wright", "young",
    ];
    const commonWords = [
        "amber", "autumn", "brook", "cindy", "daisy", "ella", "garden", "harbor",
        "isla", "jenny", "kelly", "linda", "marina", "megan", "nina", "olive",
        "pearl", "rachel", "ruby", "sandy", "tina", "violet", "wendy",
    ];
    const separators = ["", "", ".", "_"];
    const first = randomPick(firstNames);
    const last = randomPick(lastNames);
    const secondLast = randomPick(lastNames.filter((item) => item !== last));
    const middleInitial = maybe(String.fromCharCode(randomInt(97, 122)), 0.18);
    const separator = randomPick(separators);
    const alternateSeparator = randomPick(["", ".", "_"]);
    const firstInitial = first[0];
    const lastInitial = last[0];
    const yearSuffix = randomYearSuffix();
    const monthDay = randomMonthDay();

    const builders = [
        () => `${first}${separator}${last}`,
        () => `${first}${separator}${last}${maybe(yearSuffix, 0.62)}`,
        () => `${first}${separator}${last}${maybe(monthDay, 0.28)}`,
        () => `${firstInitial}${separator}${last}`,
        () => `${first}${separator}${lastInitial}`,
        () => `${last}${separator}${first}`,
        () => `${first}${alternateSeparator}${middleInitial}${middleInitial ? alternateSeparator : ""}${last}`,
        () => `${first}${maybe(alternateSeparator + randomPick(commonWords), 0.35)}`,
        () => `${randomPick(commonWords)}${separator}${last}${maybe(randomYearSuffix(), 0.55)}`,
        () => `${first}${separator}${last}${alternateSeparator}${randomInt(12, 99)}`,
        () => `${first}.${lastInitial}${maybe(yearSuffix, 0.45)}`,
        () => `${firstInitial}${last}${maybe(yearSuffix, 0.48)}`,
        () => `${first}${separator}${secondLast}${maybe(yearSuffix, 0.35)}`,
        () => `${first}${alternateSeparator}${randomShortWord()}`,
        () => `${randomPick(commonWords)}${separator}${first}${maybe(yearSuffix, 0.42)}`,
    ];

    return finalizeLocalPart(randomPick(builders)());
}
