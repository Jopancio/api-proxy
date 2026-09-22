const fs = require('fs');
const path = require('path');

const configuredSettingsPath = process.env.ADMIN_SETTINGS_PATH;
const settingsPath = configuredSettingsPath
  ? (path.isAbsolute(configuredSettingsPath) ? configuredSettingsPath : path.resolve(__dirname, configuredSettingsPath))
  : path.join(__dirname, 'data', 'settings.json');

function readSettings() {
  try {
    return JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  } catch (_) {
    return { allModelsFree: false, announcement: '' };
  }
}

function writeSettings(settings) {
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf8');
}

function isAllModelsFree() {
  return readSettings().allModelsFree === true;
}

function setAllModelsFree(enabled) {
  const settings = readSettings();
  settings.allModelsFree = Boolean(enabled);
  writeSettings(settings);
  return settings;
}

function setAnnouncement(message) {
  const settings = readSettings();
  settings.announcement = String(message || '');
  settings.announcementAt = new Date().toISOString();
  writeSettings(settings);
  return settings;
}

module.exports = { readSettings, isAllModelsFree, setAllModelsFree, setAnnouncement, settingsPath };
