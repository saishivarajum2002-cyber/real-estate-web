require('dotenv').config();
require('colors');

const express = require('express');
const ExpressWs = require('express-ws');
const fetch = require('node-fetch');

const { GptService }           = require('./services/manual-script-service');
const { StreamService }        = require('./services/stream-service');
const { TranscriptionService } = require('./services/transcription-service');
const { TextToSpeechService }  = require('./services/tts-service');
const { recordingService }     = require('./services/recording-service');
const {
  setLeadContext,
  clearLeadContext,
  getRetryCount,
  incrementRetry,
  clearRetry,
  getRetryLead,
} = require('./services/call-context');

const VoiceResponse = require('twilio').twiml.VoiceResponse;

const app  = express();
ExpressWs(app);
app.use(express.urlencoded({ extended: false })); // Twilio sends form-encoded bodies
app.use(express.json());

const PORT            = process.env.PORT            || 3000;
const BACKEND_URL     = process.env.PROPEDGE_BACKEND_URL || 'http://localhost:5000';
const TWILIO_ACCOUNT  = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_TOKEN    = process.env.TWILIO_AUTH_TOKEN;
const FROM_NUMBER     = process.env.FROM_NUMBER;
const SERVER_URL      = process.env.SERVER; // e.g. your-ngrok.ngrok.io (no https://)

// Delay constants
const RETRY_1_MS  = 5  * 60 * 1000; //  5 minutes
const RETRY_2_MS  = 30 * 60 * 1000; // 30 minutes

// ─────────────────────────────────────────────────────────────────────────────
// HELPER — place an outbound Twilio call
// ─────────────────────────────────────────────────────────────────────────────
async function placeTwilioCall(toNumber, leadPhone) {
  const client = require('twilio')(TWILIO_ACCOUNT, TWILIO_TOKEN);

  const call = await client.calls.create({
    url:            `https://${SERVER_URL}/incoming`,
    to:             toNumber,
    from:           FROM_NUMBER,
    statusCallback: `https://${SERVER_URL}/call-status?leadPhone=${encodeURIComponent(leadPhone)}`,
    statusCallbackEvent:  ['completed', 'no-answer', 'busy', 'failed'],
    statusCallbackMethod: 'POST',
  });

  console.log(`📞 Outbound call placed → SID: ${call.sid}, To: ${toNumber}`.cyan);
  return call;
}

// ─────────────────────────────────────────────────────────────────────────────
// HELPER — send fallback email via PropEdge backend
// ─────────────────────────────────────────────────────────────────────────────
async function sendFallbackEmail(lead) {
  const company   = process.env.COMPANY_NAME || 'PropEdge';
  const agentName = process.env.AGENT_NAME   || 'Our Agent';
  const agentEmail = process.env.AGENT_EMAIL || '';

  console.log(`📧 Sending no-answer fallback email to ${lead.email}`.yellow);

  try {
    await fetch(`${BACKEND_URL}/api/send-email`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        to:      lead.email,
        subject: `${company} — We tried calling you!`,
        message: `Hi ${lead.name || 'there'},\n\nWe saw you checked out a property on our website and tried reaching you by phone a few times, but couldn't connect.\n\nWhenever you're ready, feel free to reply to this email or give us a call — we'd love to help you find the right property.\n\nBest regards,\n${agentName}\n${company}`,
      }),
    });
    console.log(`📧 Fallback email sent to ${lead.email}`.green);
  } catch (err) {
    console.error(`📧 Fallback email failed: ${err.message}`.red);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ROUTE — Twilio connects here when a call is answered
//          Streams audio to /connection via WebSocket
// ─────────────────────────────────────────────────────────────────────────────
app.post('/incoming', (req, res) => {
  try {
    console.log('Twilio → Incoming/Outbound call connected'.blue);
    const response = new VoiceResponse();
    const connect  = response.connect();
    connect.stream({ url: `wss://${SERVER_URL}/connection` });

    res.type('text/xml');
    res.end(response.toString());
  } catch (err) {
    console.error('Error in /incoming:'.red, err);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// ROUTE — WebSocket media stream handler
// ─────────────────────────────────────────────────────────────────────────────
app.ws('/connection', (ws) => {
  try {
    console.log('Twilio → WebSocket opened'.green);
    ws.on('error', (err) => console.error('WebSocket Error:'.red, err));

    let streamSid;
    let callSid;

    const gptService           = new GptService();
    const streamService        = new StreamService(ws);
    const transcriptionService = new TranscriptionService();
    const ttsService           = new TextToSpeechService({});

    let marks            = [];
    let interactionCount = 0;

    ws.on('message', function message(data) {
      const msg = JSON.parse(data);

      if (msg.event === 'start') {
        streamSid = msg.start.streamSid;
        callSid   = msg.start.callSid;

        streamService.setStreamSid(streamSid);
        gptService.setCallSid(callSid);

        // Inject any lead context stored before the call started
        const { getLeadByCallSid } = require('./services/call-context');
        // We store by phone; retrieve by scanning (callSid set in /outbound-call)
        const callMeta = global.__callMeta && global.__callMeta[callSid];
        if (callMeta) {
          gptService.setLeadInfo({
            name:             callMeta.lead?.name,
            propertyInterest: callMeta.lead?.property_interest,
            isReminder:       callMeta.isReminder || false,
          });
          // Also store in call-context keyed by callSid for bookAppointment
          setLeadContext(callSid, callMeta.lead);
        } else {
          gptService.setLeadInfo({});
        }

        recordingService(ttsService, callSid).then(() => {
          console.log(`Twilio → Media stream started: ${streamSid}`.underline.red);

          const callMeta  = global.__callMeta && global.__callMeta[callSid];
          const isReminder = callMeta?.isReminder;
          const lead       = callMeta?.lead;
          const company    = process.env.COMPANY_NAME || 'our agency';

          let openingLine;
          if (callMeta) {
            if (isReminder) {
              openingLine = `Hi${lead?.name ? ` ${lead.name}` : ''}, this is Aria from ${company}. Just a quick reminder about your property visit today. The location has been sent to your WhatsApp. Looking forward to seeing you there!`;
            } else {
              openingLine = `Hey — is this${lead?.name ? ` ${lead.name}` : ' there'}? You just checked out a property on our site, so I wanted to reach out quickly. Is now a good time for a quick chat?`;
            }
          } else {
            openingLine = `Hi! Thank you for calling ${company}. This is Aria, your AI real estate assistant. I'd love to help you find the right property. Who do I have the pleasure of speaking with today?`;
          }

          // Log the first message in transcript
          gptService.history.push({ role: 'Aria', text: openingLine });

          ttsService.generate({ partialResponseIndex: null, partialResponse: openingLine }, 0);
        });

      } else if (msg.event === 'media') {
        transcriptionService.send(msg.media.payload);
      } else if (msg.event === 'mark') {
        console.log(`Twilio → Mark (${msg.sequenceNumber}): ${msg.mark.name}`.red);
        marks = marks.filter(m => m !== msg.mark.name);
      } else if (msg.event === 'stop') {
        console.log(`Twilio → Stream ended: ${streamSid}`.underline.red);
        
        // ── SYNC CALL LOG to Dashboard
        if (callSid) {
          const transcript = gptService.getTranscript();
          const outcome    = gptService.getOutcome();
          const lead       = (global.__callMeta && global.__callMeta[callSid])?.lead || { name: 'Unknown Caller', phone: 'N/A' };

          const callLog = {
            leadName:   lead.name,
            leadPhone:  lead.phone,
            outcome:    outcome,
            urgency:    gptService.getUrgencyScore ? gptService.getUrgencyScore() : 3,
            transcript: transcript,
            duration:   interactionCount > 1 ? interactionCount * 15 : 0 // rough estimate
          };

          fetch(`${BACKEND_URL}/api/calls`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              agentEmail: process.env.AGENT_EMAIL || 'saishivaraju.m2002@gmail.com',
              call: callLog
            })
          }).catch(e => console.error('Call Log Sync Failed:', e.message));

          clearLeadContext(callSid);
          if (global.__callMeta) delete global.__callMeta[callSid];
        }
      }
    });

    transcriptionService.on('utterance', async (text) => {
      if (marks.length > 0 && text?.length > 5) {
        console.log('Twilio → Interruption detected, clearing stream'.red);
        ws.send(JSON.stringify({ streamSid, event: 'clear' }));
      }
    });

    transcriptionService.on('transcription', async (text) => {
      if (!text) return;
      console.log(`Interaction ${interactionCount} – STT → GPT: ${text}`.yellow);
      gptService.completion(text, interactionCount);
      interactionCount += 1;
    });

    gptService.on('gptreply', async (gptReply, icount) => {
      console.log(`Interaction ${icount}: GPT → TTS: ${gptReply.partialResponse}`.green);
      ttsService.generate(gptReply, icount);
    });

    ttsService.on('speech', (responseIndex, audio, label, icount) => {
      console.log(`Interaction ${icount}: TTS → Twilio: ${label}`.blue);
      streamService.buffer(responseIndex, audio);
    });

    streamService.on('audiosent', (markLabel) => {
      marks.push(markLabel);
    });

  } catch (err) {
    console.error('WebSocket handler error:'.red, err);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// ROUTE — POST /outbound-call
//   Called by PropEdge backend immediately after a lead submits the form.
//   Body: { lead: { name, phone, email, property_interest } }
// ─────────────────────────────────────────────────────────────────────────────
app.post('/outbound-call', async (req, res) => {
  const { lead } = req.body;

  if (!lead || !lead.phone) {
    return res.status(400).json({ error: 'lead.phone is required' });
  }

  try {
    const call = await placeTwilioCall(lead.phone, lead.phone);

    // Temporarily store lead data keyed by callSid so the WS handler can pick it up
    if (!global.__callMeta) global.__callMeta = {};
    global.__callMeta[call.sid] = { lead, isReminder: false };

    // Also initialise retry tracking (attempt 1 just placed)
    incrementRetry(lead.phone, lead);

    console.log(`⚡ Lead call placed immediately → ${lead.name} (${lead.phone})`.cyan);
    res.json({ success: true, callSid: call.sid });
  } catch (err) {
    console.error('Outbound call failed:'.red, err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// ROUTE — POST /outbound-reminder
//   Called by the PropEdge CRON before a confirmed visit.
//   Body: { visit: { client_name, client_phone, property_name, visit_time } }
// ─────────────────────────────────────────────────────────────────────────────
app.post('/outbound-reminder', async (req, res) => {
  const { visit } = req.body;

  if (!visit || !visit.client_phone) {
    return res.status(400).json({ error: 'visit.client_phone is required' });
  }

  try {
    const lead = {
      name:              visit.client_name,
      phone:             visit.client_phone,
      email:             visit.client_email || null,
      property_interest: visit.property_name,
    };

    const call = await placeTwilioCall(lead.phone, lead.phone);

    if (!global.__callMeta) global.__callMeta = {};
    global.__callMeta[call.sid] = { lead, isReminder: true, visit };

    console.log(`⏰ Reminder call placed → ${lead.name} (${lead.phone})`.cyan);
    res.json({ success: true, callSid: call.sid });
  } catch (err) {
    console.error('Reminder call failed:'.red, err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// ROUTE — POST /call-status  (Twilio statusCallback)
//
//   Implements the no-answer retry chain:
//     Attempt 1 fails → wait 5 min  → Attempt 2
//     Attempt 2 fails → wait 30 min → Attempt 3
//     Attempt 3 fails → send email  → give up
//
//   Twilio sends: CallStatus, CallSid, To, From, etc.
// ─────────────────────────────────────────────────────────────────────────────
app.post('/call-status', async (req, res) => {
  // Always acknowledge immediately so Twilio doesn't retry the webhook
  res.sendStatus(200);

  const status    = req.body.CallStatus;   // completed | no-answer | busy | failed
  const leadPhone = req.query.leadPhone || req.body.To;

  console.log(`📊 Call status: ${status} for ${leadPhone}`.cyan);

  // If the lead picked up (completed) → clear retry tracking
  if (status === 'completed') {
    clearRetry(leadPhone);
    console.log(`✅ Lead answered — retry tracking cleared for ${leadPhone}`.green);
    return;
  }

  // Only retry on no-answer, busy, or failed
  if (!['no-answer', 'busy', 'failed'].includes(status)) return;

  const attempts = getRetryCount(leadPhone);
  const lead     = getRetryLead(leadPhone);

  if (!lead) {
    console.log(`⚠️ No retry data found for ${leadPhone}`.yellow);
    return;
  }

  console.log(`🔄 No answer for ${lead.name} — attempt #${attempts}`.yellow);

  if (attempts < 2) {
    // ── Attempt 1 failed → retry after 5 min
    const delay = attempts === 1 ? RETRY_1_MS : RETRY_2_MS;
    const label = attempts === 1 ? '5 minutes' : '30 minutes';

    console.log(`⏳ Scheduling retry #${attempts + 1} for ${lead.name} in ${label}...`.yellow);

    setTimeout(async () => {
      try {
        console.log(`📞 Retry #${attempts + 1} calling ${lead.name} (${lead.phone})...`.cyan);
        const call = await placeTwilioCall(lead.phone, lead.phone);

        if (!global.__callMeta) global.__callMeta = {};
        global.__callMeta[call.sid] = { lead, isReminder: false };

        incrementRetry(lead.phone, lead);
        console.log(`📞 Retry #${attempts + 1} placed → SID: ${call.sid}`.green);
      } catch (err) {
        console.error(`📞 Retry #${attempts + 1} failed: ${err.message}`.red);
      }
    }, delay);

  } else {
    // ── All 3 attempts failed → send final internal email notification
    console.log(`✉️ All ${attempts} call attempts failed for ${lead.name}. Sending fallback notification...`.magenta);
    if (lead.email) {
      await sendFallbackEmail(lead);
    } else {
      console.log(`⚠️ No email on file for ${lead.name} — cannot send fallback email.`.yellow);
    }
    clearRetry(lead.phone);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// SERVER START
// ─────────────────────────────────────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n${'━'.repeat(50)}`.cyan);
  console.log(`  🚀 AI Voice Agent Server running on port ${PORT}`.cyan.bold);
  console.log(`  📞 Outbound call endpoint: POST /outbound-call`.cyan);
  console.log(`  📊 Call status webhook:    POST /call-status`.cyan);
  console.log(`  ⏰ Reminder endpoint:      POST /outbound-reminder`.cyan);
  console.log(`  🔄 Retry Flow: 5min → 30min → Email fallback`.cyan);
  console.log(`${'━'.repeat(50)}\n`.cyan);
});
