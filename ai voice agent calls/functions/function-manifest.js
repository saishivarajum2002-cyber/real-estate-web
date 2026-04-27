// function-manifest.js
// ─────────────────────────────────────────────────────────────────────────────
// OpenAI tool definitions for Aria — Real Estate Voice Agent
// ─────────────────────────────────────────────────────────────────────────────

const tools = [

  // ── 1. getProperty ─────────────────────────────────────────────────────────
  {
    type: 'function',
    function: {
      name: 'getProperty',

      // This string is spoken aloud by TTS while the function executes
      say: "I'll confirm that for you — give me just a moment.",

      description: `Retrieve property listings that match the user's preferences.
Call this function ONLY when the user asks about price, location, availability,
or specific features. NEVER guess or make up property data.`,

      parameters: {
        type: 'object',
        properties: {
          location: {
            type: 'string',
            description: 'The city or area the user is interested in. E.g. "downtown Mumbai", "Pune suburbs", "Dubai".',
          },
          budget: {
            type: 'string',
            description: "The user's rough budget. Can be a number or natural language like \"1 crore\", \"50 lakhs\", \"AED 2 million\".",
          },
          property_type: {
            type: 'string',
            enum: ['apartment', 'villa', 'studio', 'plot', 'commercial', 'townhouse'],
            description: 'The type of property the user is looking for.',
          },
        },
        required: [],
      },
    },
  },

  // ── 2. bookAppointment ─────────────────────────────────────────────────────
  {
    type: 'function',
    function: {
      name: 'bookAppointment',

      // Spoken aloud while the booking is being saved
      say: "Perfect — give me just a second to lock that in for you.",

      description: `Book a property visit appointment for the lead.
Call this function ONLY when the user has agreed to a visit AND you have confirmed
both the date and time. Always confirm the slot with the user ("Saturday at 11 AM — 
does that work?") before calling this function.`,

      parameters: {
        type: 'object',
        properties: {
          callSid: {
            type: 'string',
            description: 'The unique Twilio Call SID. Auto-injected by GptService.',
          },
          visit_date: {
            type: 'string',
            description: 'ISO date string for the visit. E.g. "2026-05-03". Derive from what the user said.',
          },
          visit_time: {
            type: 'string',
            description: 'Time of the visit, e.g. "11:00 AM" or "14:30".',
          },
          property_interest: {
            type: 'string',
            description: 'The type or name of property the user wants to visit, if known.',
          },
        },
        required: ['visit_date', 'visit_time'],
      },
    },
  },

  // ── 3. transfer_call ───────────────────────────────────────────────────────
  {
    type: 'function',
    function: {
      name: 'transfer_call',

      // Spoken aloud before the transfer happens
      say: "Got it — I'll connect you with one of our agents who can guide you better. One moment.",

      description: `Transfer the active call to a human real estate agent.
Trigger this function ONLY when:
  (a) the user explicitly asks to speak to a human agent,
  (b) the user asks complex legal/financial questions more than once, or
  (c) the user signals very high intent and wants immediate action.`,

      parameters: {
        type: 'object',
        properties: {
          callSid: {
            type: 'string',
            description: 'The unique Twilio Call SID for the active phone call. Auto-injected by GptService.',
          },
          reason: {
            type: 'string',
            enum: ['user_requested', 'complex_question', 'high_intent'],
            description: 'The reason the call is being transferred.',
          },
        },
        required: ['callSid'],
      },
    },
  },

];

module.exports = tools;