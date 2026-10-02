const MAX_RESUMES = 4;
const RESET_AFTER_MS = 2 * 60 * 1000;

const RETRY_DELAYS_MS = [
  0,       
  1000,   
  2000,   
  4000,   
  8000   
];

const ALARM_PREFIX = "downlink_resume_";
const store = chrome.storage.local;

const PERMANENT_ERRORS = new Set([
  "USER_CANCELED",
  "SERVER_BAD_CONTENT",
  "SERVER_UNAUTHORIZED",
  "SERVER_FORBIDDEN",
  "SERVER_CERT_PROBLEM"
]);

function isPermanentError(error) {
  return Boolean(
    error &&
    (error.startsWith("FILE_") || PERMANENT_ERRORS.has(error))
  );
}

function stateKey(id) {
  return `download_${id}`;
}

function alarmName(id) {
  return `${ALARM_PREFIX}${id}`;
}

async function clearTracking(id) {
  await chrome.alarms.clear(alarmName(id));
  await store.remove(stateKey(id));
}

async function notifyManualRetry(item) {
  const filename =
    item?.filename?.split(/[\\/]/).pop() || "Your file";

  await chrome.notifications.create({
    type: "basic",
    iconUrl: "icon.png",
    title: "Max limit hit: Download needs attention",
    message:
      `"${filename}" could not be resumed automatically. ` +
      "Please resume it manually from Chrome's Downloads page.",
    priority: 2
  });
}

/**
 * Called whenever Chrome reports an interrupted download.
 */
async function scheduleResume(id) {
  const key = stateKey(id);
  const now = Date.now();

  const result = await store.get(key);
  let state = result[key];

  // Start fresh after a quiet period.
  if (!state || now - state.lastAttempt > RESET_AFTER_MS) {
    state = {
      attempts: 0,
      scheduled: false,
      lastAttempt: 0
    };
  }

  // Prevent duplicate retry scheduling.
  if (state.scheduled) return;

  if (state.attempts >= MAX_RESUMES) {
    const [item] = await chrome.downloads.search({ id });

    await clearTracking(id);

    if (item) {
      await notifyManualRetry(item);
    }

    return;
  }

  const attempt = state.attempts;
  const delay = RETRY_DELAYS_MS[attempt] ?? RETRY_DELAYS_MS.at(-1);

  state.scheduled = true;
  state.lastAttempt = now;

  await store.set({ [key]: state });

  if (delay === 0) {
    await resumeDownload(id);
    return;
  }

  await chrome.alarms.create(alarmName(id), {
    delayInMinutes: delay / 60_000
  });
}

/**
 * Actually attempt to resume the download.
 */
async function resumeDownload(id) {
  const key = stateKey(id);

  const result = await store.get(key);
  const state = result[key];

  if (!state) return;

  const [item] = await chrome.downloads.search({ id });

  if (!item) {
    await clearTracking(id);
    return;
  }

  // It recovered by itself.
  if (item.state === "complete") {
    await clearTracking(id);
    return;
  }

  // Something else already changed the download.
  if (item.state !== "interrupted") {
    await store.remove(key);
    return;
  }

  // Chrome explicitly says it cannot resume.
  if (!item.canResume) {
    await clearTracking(id);
    await notifyManualRetry(item);
    return;
  }

  state.attempts += 1;
  state.scheduled = false;
  state.lastAttempt = Date.now();

  await store.set({ [key]: state });

  chrome.downloads.resume(id, async () => {
    if (chrome.runtime.lastError) {
      await scheduleResume(id);
      return;
    }

  });
}

/**
 * Download state changes.
 */
chrome.downloads.onChanged.addListener(async (delta) => {
  const id = delta.id;

  if (delta.state?.current === "complete") {
    await clearTracking(id);
    return;
  }

  if (delta.state?.current !== "interrupted") {
    return;
  }

  const error = delta.error?.current;

  if (isPermanentError(error)) {
    await clearTracking(id);
    return;
  }

  await scheduleResume(id);
});

/**
 * User deleted the download.
 */
chrome.downloads.onErased.addListener(async (id) => {
  await clearTracking(id);
});

/**
 * Retry alarm.
 */
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (!alarm.name.startsWith(ALARM_PREFIX)) {
    return;
  }

  const id = Number(
    alarm.name.slice(ALARM_PREFIX.length)
  );

  if (!Number.isInteger(id)) {
    return;
  }

  await resumeDownload(id);
});

/**
 * Recover interrupted resumable downloads after Chrome starts.
 */
chrome.runtime.onStartup.addListener(async () => {
  const items = await chrome.downloads.search({
    state: "interrupted"
  });

  for (const item of items) {
    if (item.canResume && !isPermanentError(item.error)) {
      await scheduleResume(item.id);
    }
  }
});