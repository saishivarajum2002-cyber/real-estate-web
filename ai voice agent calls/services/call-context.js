// call-context.js
// ─────────────────────────────────────────────────────────────────────────────
// Lightweight in-memory store mapping Twilio CallSid → lead context.
// This lets function handlers (bookAppointment, transfer_call, etc.) know
// who they are talking to without embedding personal data in the AI prompt.
//
// Also tracks retry attempt counts per lead phone for the no-answer flow.
// ─────────────────────────────────────────────────────────────────────────────

/** @type {Map<string, object>} callSid → lead object */
const callContextMap = new Map();

/** @type {Map<string, {attempts: number, lead: object}>} phone → retry state */
const retryMap = new Map();

// ── Lead Context (keyed by Twilio CallSid) ────────────────────────────────────

/**
 * Store lead data before a call starts so function handlers can access it.
 * @param {string} callSid - Twilio Call SID
 * @param {object} lead    - { name, phone, email, property_interest }
 */
function setLeadContext(callSid, lead) {
  callContextMap.set(callSid, lead);
}

/**
 * Retrieve lead data for the given callSid.
 * @param {string} callSid
 * @returns {object|null}
 */
function getLeadContext(callSid) {
  return callContextMap.get(callSid) || null;
}

/**
 * Remove lead context after a call ends to free memory.
 * @param {string} callSid
 */
function clearLeadContext(callSid) {
  callContextMap.delete(callSid);
}

// ── Retry State (keyed by lead phone number) ──────────────────────────────────

/**
 * Get current retry attempt count for a lead phone number.
 * Returns 0 if this is the first attempt.
 * @param {string} phone
 * @returns {number}
 */
function getRetryCount(phone) {
  return retryMap.get(phone)?.attempts || 0;
}

/**
 * Increment retry count and store the latest lead object.
 * @param {string} phone
 * @param {object} lead
 */
function incrementRetry(phone, lead) {
  const current = retryMap.get(phone) || { attempts: 0, lead };
  retryMap.set(phone, { attempts: current.attempts + 1, lead });
}

/**
 * Clear retry state after a lead answers or gives up.
 * @param {string} phone
 */
function clearRetry(phone) {
  retryMap.delete(phone);
}

/**
 * Get lead object stored in retry state.
 * @param {string} phone
 * @returns {object|null}
 */
function getRetryLead(phone) {
  return retryMap.get(phone)?.lead || null;
}

module.exports = {
  setLeadContext,
  getLeadContext,
  clearLeadContext,
  getRetryCount,
  incrementRetry,
  clearRetry,
  getRetryLead,
};
