// ─────────────────────────────────────────────────────────────
//  Socket.IO Registry
//  Holds the single Socket.IO server instance so any service
//  can emit real-time events without importing index.js
//  (which would create a circular dependency).
// ─────────────────────────────────────────────────────────────

let ioInstance = null;

function setIO(io) {
  ioInstance = io;
}

function getIO() {
  return ioInstance;
}

module.exports = { setIO, getIO };
