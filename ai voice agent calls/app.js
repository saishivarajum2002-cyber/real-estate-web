require('dotenv').config();
require('colors');

const express = require('express');
const ExpressWs = require('express-ws');
const fetch = require('node-fetch');

const { GptService }           = require('./services/manual-script-service');
const { StreamService }        = require('./services/stream-service');
const { TranscriptionService } = require('./services/transcription-service');
const { TextToSpeechService }  = require('./services/tts-service');

const app  = express();
const wsInstance = ExpressWs(app);
app.use(express.json());

const PORT        = process.env.PORT || 3000;
const BACKEND_URL = process.env.PROPEDGE_BACKEND_URL || 'https://real-estate-web-liard-rho.vercel.app';

// ─────────────────────────────────────────────────────────────────────────────
// MOBILE CONNECTION STORAGE
// ─────────────────────────────────────────────────────────────────────────────
let mobileClient = null; 

// ─────────────────────────────────────────────────────────────────────────────
// HELPER — Notify the App through local WebSocket
// ─────────────────────────────────────────────────────────────────────────────
function notifyMobileLead(lead) {
  if (mobileClient && mobileClient.readyState === 1) {
    mobileClient.send(JSON.stringify({ event: 'incoming-lead', lead }));
    console.log(`📱 Notified Mobile App of lead: ${lead.name}`.green);
    return true;
  }
  console.log(`⚠️ No Mobile App connected to receive lead: ${lead.name}`.yellow);
  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// ROUTE — Mobile App connects here for Audio & Signals
// ─────────────────────────────────────────────────────────────────────────────
app.ws('/connection', (ws) => {
  console.log('📱 Mobile App connected to Aria Voice Bridge'.green);
  mobileClient = ws;

  const gptService           = new GptService();
  const streamService        = new StreamService(ws);
  const transcriptionService = new TranscriptionService();
  const ttsService           = new TextToSpeechService({});

  let interactionCount = 0;

  ws.on('message', function message(data) {
    const msg = JSON.parse(data);

    // Initial setup from Mobile App
    if (msg.event === 'start') {
      console.log('🎙️ AI Voice Stream Active'.red);
      const lead = msg.lead || { name: 'Valued Buyer' };
      
      gptService.setLeadInfo({
        name:             lead.name,
        propertyInterest: lead.property_interest
      });

      const openingLine = `Hi${lead.name ? ` ${lead.name}` : ''}! You just checked out a property on our site, so I wanted to reach out quickly. Is now a good time for a quick chat?`;
      
      gptService.history.push({ role: 'Aria', text: openingLine });
      ttsService.generate({ partialResponseIndex: null, partialResponse: openingLine }, 0);

    } else if (msg.event === 'media') {
      // Audio from phone mic -> GPT
      transcriptionService.send(msg.payload);
    }
  });

  // GPT -> TTS -> Phone Speaker
  transcriptionService.on('transcription', async (text) => {
    if (!text) return;
    console.log(`STT → GPT: ${text}`.yellow);
    gptService.completion(text, interactionCount);
    interactionCount += 1;
  });

  gptService.on('gptreply', async (gptReply, icount) => {
    ttsService.generate(gptReply, icount);
  });

  ttsService.on('speech', (responseIndex, audio, label, icount) => {
    streamService.buffer(responseIndex, audio);
  });

  ws.on('close', () => {
    console.log('📱 Mobile App disconnected'.yellow);
    mobileClient = null;
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ROUTE — POST /outbound-call (Called by Vercel)
// ─────────────────────────────────────────────────────────────────────────────
app.post('/outbound-call', async (req, res) => {
  const { lead } = req.body;
  if (!lead) return res.status(400).json({ error: 'lead is required' });
  
  const sent = notifyMobileLead(lead);
  res.json({ success: sent, message: sent ? 'Lead sent to app' : 'App not connected' });
});

// ─────────────────────────────────────────────────────────────────────────────
// SERVER START
// ─────────────────────────────────────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n${'━'.repeat(50)}`.cyan);
  console.log(`  🚀 PURE MOBILE AI SERVER READY (NO TWILIO)`.cyan.bold);
  console.log(`  📱 Listening for Phone App on port ${PORT}`.cyan);
  console.log(`  📡 Waiting for Vercel signals...`.cyan);
  console.log(`${'━'.repeat(50)}\n`.cyan);
});
