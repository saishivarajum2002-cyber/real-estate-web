// bookAppointment.js
// ─────────────────────────────────────────────────────────────────────────────
// Called by Aria when the user agrees to a visit.
// Hits the PropEdge backend to create a confirmed booking and automatically
// fires WhatsApp confirmation + agent dashboard notification.
// ─────────────────────────────────────────────────────────────────────────────
require('dotenv').config();
const fetch = require('node-fetch');

// Pull lead context injected before the call started (set via global store in app.js)
const { getLeadContext } = require('../services/call-context');

/**
 * bookAppointment — called by the AI after the user agrees on a date/time.
 *
 * @param {string} callSid      - Twilio Call SID (auto-injected by GptService)
 * @param {string} visit_date   - ISO date string e.g. "2026-05-03"
 * @param {string} visit_time   - Time string e.g. "11:00 AM"
 * @param {string} property_interest - What the lead wants to see (optional)
 */
const bookAppointment = async function ({ callSid, visit_date, visit_time, property_interest }) {
  console.log(`bookAppointment → callSid: ${callSid}, date: ${visit_date}, time: ${visit_time}`.cyan);

  const lead = getLeadContext(callSid);
  const backendUrl = process.env.PROPEDGE_BACKEND_URL || 'http://localhost:5000';
  const agentEmail = process.env.AGENT_EMAIL;

  if (!visit_date || !visit_time) {
    return {
      success: false,
      message: 'I need both the date and time to book. Which date works for you?',
    };
  }

  const visitPayload = {
    agentEmail,
    is_ai_booking: true, // Bypasses the qualification/agreement gates for AI-confirmed leads
    visit: {
      client_name:       lead?.name        || 'AI Lead',
      client_phone:      lead?.phone       || null,
      client_email:      lead?.email       || null,
      property_name:     lead?.property_interest || property_interest || 'Property Visit',
      visit_date,
      visit_time,
      notes:             'Booked via AI Voice Agent — Aria',
      status:            'confirmed',
    },
  };

  try {
    const response = await fetch(`${backendUrl}/api/visits`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(visitPayload),
    });

    const result = await response.json();

    if (result.success) {
      console.log(`bookAppointment → Booking saved. ID: ${result.id}`.green);
      return {
        success: true,
        booking_id: result.id,
        message: `Perfect — I've confirmed your visit for ${visit_date} at ${visit_time}. I'll send the details to your WhatsApp right away.`,
      };
    } else {
      console.error('bookAppointment → Backend error:', result.error);
      // If slot taken, ask to re-pick
      if (result.error && result.error.toLowerCase().includes('already booked')) {
        return {
          success: false,
          message: 'That slot is already taken — would morning or afternoon on a different day work for you?',
        };
      }
      return {
        success: false,
        message: "I'm having a small issue saving that — let me note it down and our agent will confirm it with you shortly.",
      };
    }
  } catch (err) {
    console.error('bookAppointment → Network error:', err.message);
    return {
      success: false,
      message: 'There was a connection issue on my end. Our agent will follow up to confirm your visit.',
    };
  }
};

module.exports = bookAppointment;
