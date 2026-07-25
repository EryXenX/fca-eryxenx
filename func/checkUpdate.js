"use strict";
// Auto-update disabled in fca-eryxenx
function checkAndUpdateVersion(callback) {
  if (typeof callback === "function") callback(null);
  return Promise.resolve();
}
module.exports = { checkAndUpdateVersion };
