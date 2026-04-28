const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, '..')));

require('dotenv').config({ path: path.join(__dirname, '../.env') });
const { sendEmail } = require('../services/email');
const {
  saveLeadToSupabase, saveVisitToSupabase,
  updateVisitInSupabase, deleteVisitFromSupabase, getVisitFromSupabase,
  getVisitsByDate, saveQualification, getQualification, saveAgreement,
  getAgreement, saveDocument, getDocumentsByLead, getAllDocuments, getAllAgreements
} = require('../services/supabase');
const { generateDescription, generateSocialMarketingKit } = require('../services/ai');
const {
  sendBookingCreatedMsg, sendBookingConfirmedMsg, sendVisitReminderMsg, sendNewLeadNotification, sendAICallLink
} = require('../services/whatsapp');

// ── AI Voice Agent
const AI_VOICE_URL = process.env.AI_VOICE_URL || 'http://localhost:3000';

async function triggerAICall(lead) {
  try {
    const { default: fetch } = await import('node-fetch');
    const resp = await fetch(`${AI_VOICE_URL}/outbound-call`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lead }),
    });
    const data = await resp.json();
    console.log(`📞 AI Call triggered → SID: ${data.callSid || 'N/A'}`);
    return data;
  } catch (err) {
    console.error('❌ AI Call trigger failed (non-blocking):', err.message);
    return { success: false };
  }
}

async function triggerReminderCall(visit) {
  try {
    const { default: fetch } = await import('node-fetch');
    const resp = await fetch(`${AI_VOICE_URL}/outbound-reminder`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ visit }),
    });
    const data = await resp.json();
    console.log(`⏰ Reminder call triggered → SID: ${data.callSid || 'N/A'}`);
    return data;
  } catch (err) {
    console.error('❌ Reminder call trigger failed (non-blocking):', err.message);
    return { success: false };
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// AGENT CONFIG
// ──────────────────────────────────────────────────────────────────────────────
const AGENT_EMAIL = process.env.AGENT_EMAIL || 'saishivaraju.m2002@gmail.com';
const AGENT_NAME = process.env.AGENT_NAME || 'Sarah Al-Rashid';
const API_SECRET = process.env.API_SECRET;

// Middleware to protect sensitive routes
const protect = (req, res, next) => {
  if (!API_SECRET) return next(); // If no secret set, allow (for easy setup)
  const secret = req.headers['x-api-secret'];
  if (secret === API_SECRET) return next();
  res.status(401).json({ error: 'Unauthorized: Invalid or missing API Secret' });
};

// ──────────────────────────────────────────────────────────────────────────────
// MONGODB CONNECTION
// ──────────────────────────────────────────────────────────────────────────────
const MONGODB_URI = process.env.MONGODB_URI;
let cachedConnection = null;

const connectDB = async () => {
  if (cachedConnection) return cachedConnection;
  if (!MONGODB_URI) throw new Error('MONGODB_URI is missing in environment variables!');
  try {
    const options = { serverSelectionTimeoutMS: 5000, socketTimeoutMS: 45000 };
    console.log('⏳ Connecting to MongoDB Atlas...');
    cachedConnection = await mongoose.connect(MONGODB_URI, options);
    console.log('✅ MongoDB Connected to Atlas');
    return cachedConnection;
  } catch (err) {
    cachedConnection = null;
    console.error('❌ MongoDB Connection Error:', err.message);
    throw err;
  }
};

app.use(async (req, res, next) => {
  try { await connectDB(); next(); }
  catch (err) {
    res.status(500).json({
      error: 'Database Connection Failed', details: err.message,
      suggestion: err.message.includes('IP not whitelisted')
        ? 'Update MongoDB Atlas Network Access to allow all IPs (0.0.0.0/0)'
        : 'Check environment variables and Atlas status'
    });
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// SCHEMAS & MODELS
// ──────────────────────────────────────────────────────────────────────────────
const DataSnapshotSchema = new mongoose.Schema({
  email: { type: String, required: true, unique: true },
  data: { type: Object, default: {} }
}, { timestamps: true });

const PeTokenSchema = new mongoose.Schema({
  email: { type: String, required: true },
  platform: { type: String, enum: ['zoom', 'google'], required: true },
  access_token: String,
  refresh_token: String,
  expiry: Date
}, { timestamps: true });
PeTokenSchema.index({ email: 1, platform: 1 }, { unique: true });

const PeToken = mongoose.models.PeToken || mongoose.model('PeToken', PeTokenSchema);
const DataSnapshot = mongoose.models.DataSnapshot || mongoose.model('DataSnapshot', DataSnapshotSchema);

// ──────────────────────────────────────────────────────────────────────────────
// HELPERS
// ──────────────────────────────────────────────────────────────────────────────
function genToken() {
  return crypto.randomBytes(24).toString('hex');
}

function calcQualificationScore(budget, bhkPref, preApproval) {
  let score = 0;
  // Budget
  const budgetMap = { 'Under $500K': 50, '$500K - $1M': 65, '$1M - $3M': 80, '$3M - $10M': 90, '$10M+': 95 };
  score += budgetMap[budget] || 40;
  // Pre-approval
  if (preApproval === 'yes') score += 30;
  else if (preApproval === 'working') score += 15;
  // Score is out of 125 → normalize to 100
  return Math.min(100, Math.round(score * 0.8));
}

async function notifyAgent(agentEmail, { title, description, type, icon, emailSubject }) {
  console.log(`🔔 Notifying Agent [${agentEmail}]: ${title}`);

  // 1. Dashboard Notification (MongoDB Snapshot)
  try {
    let snapshot = await DataSnapshot.findOne({ email: agentEmail });
    if (!snapshot) snapshot = new DataSnapshot({ email: agentEmail, data: {} });
    if (!snapshot.data) snapshot.data = {};

    let notifs = snapshot.data.pe_notifications || [];
    const wasString = typeof notifs === 'string';
    if (wasString) {
      try { notifs = JSON.parse(notifs); } catch (e) { notifs = []; }
    }

    notifs.unshift({
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
      title,
      description: description || '',
      type: type || 'info',
      icon: icon || '🔔',
      is_read: false,
      created_at: new Date().toISOString()
    });

    // Cap at 50
    if (notifs.length > 50) notifs = notifs.slice(0, 50);

    snapshot.data.pe_notifications = wasString ? JSON.stringify(notifs) : notifs;
    snapshot.markModified('data');
    await snapshot.save();
  } catch (e) {
    console.error('❌ Dashboard Notification Error:', e.message);
  }

  // 2. Email Notification (Resend)
  if (emailSubject) {
    try {
      await sendEmail({
        to: agentEmail,
        subject: emailSubject,
        message: `${title}\n\n${description}\n\nView details in your dashboard: http://localhost:5000/propedge_dashboard.html`,
        html: `<div style="font-family:sans-serif;max-width:600px;margin:0 auto;background:#f9f9f9;border-radius:8px;overflow:hidden;border:1px solid #ddd"><div style="background:#1a1a18;padding:24px;text-align:center"><h2 style="color:#d4b483;margin:0">${title}</h2></div><div style="background:#fff;padding:24px"><p style="color:#333;font-size:16px">${description.replace(/\n/g, '<br>')}</p><div style="text-align:center;margin-top:24px"><a href="http://localhost:5000/propedge_dashboard.html" style="background:#b8965a;color:#fff;padding:12px 28px;text-decoration:none;border-radius:6px;font-weight:bold;display:inline-block">Open Agent Dashboard →</a></div></div><div style="background:#1a1a18;padding:14px;text-align:center"><p style="color:#888;font-size:12px;margin:0">PropEdge Real Estate</p></div></div>`
      });
    } catch (e) {
      console.error('❌ Email Notification Error:', e.message);
    }
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// INTEGRATION STATUS
// ──────────────────────────────────────────────────────────────────────────────
app.get('/api/integration-status', async (req, res) => {
  const { email } = req.query;
  const tokens = await PeToken.find({ email });
  const status = {
    google: tokens.some(t => t.platform === 'google'),
    whatsapp: !!(process.env.WHATSAPP_ACCESS_TOKEN && process.env.WHATSAPP_PHONE_NUMBER_ID)
  };
  res.json(status);
});

// ──────────────────────────────────────────────────────────────────────────────
// AVAILABILITY CHECK
// ──────────────────────────────────────────────────────────────────────────────
app.get('/api/availability', async (req, res) => {
  const { date } = req.query;
  if (!date) return res.status(400).json({ error: 'Date is required' });
  try {
    const visits = await getVisitsByDate(date);
    if (visits.success) {
      const busyTimes = visits.data.map(v => v.visit_time.substring(0, 5));
      return res.json({ success: true, busyTimes });
    }
    throw new Error(visits.error);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch availability: ' + error.message });
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// AI PRE-QUALIFICATION — POST /api/qualify
// ──────────────────────────────────────────────────────────────────────────────
app.post('/api/qualify', async (req, res) => {
  try {
    const { name, email, phone, budget, bhk_preference, pre_approval_status } = req.body;
    if (!budget || !bhk_preference || !pre_approval_status) {
      return res.status(400).json({ error: 'budget, bhk_preference, and pre_approval_status are required' });
    }

    const score = calcQualificationScore(budget, bhk_preference, pre_approval_status);
    const isQualified = score >= 50; // Threshold for booking eligibility
    const sessionToken = genToken();

    const qualification = {
      session_token: sessionToken,
      name: name || null,
      email: email || null,
      phone: phone || null,
      budget,
      bhk_preference,
      pre_approval_status,
      qualification_score: score,
      is_qualified: isQualified,
      answers: { budget, bhk_preference, pre_approval_status }
    };

    // Save to Supabase
    const result = await saveQualification(qualification);

    // Save to MongoDB as well
    try {
      const agentEmail = AGENT_EMAIL;
      let snapshot = await DataSnapshot.findOne({ email: agentEmail });
      if (!snapshot) snapshot = new DataSnapshot({ email: agentEmail, data: {} });
      if (!snapshot.data) snapshot.data = {};

      let quals = snapshot.data.pe_qualifications || [];
      const wasString = typeof quals === 'string';
      if (wasString) {
        try { quals = JSON.parse(quals); } catch (e) { quals = []; }
      }

      quals.unshift({ ...qualification, id: sessionToken, created_at: new Date().toISOString() });
      snapshot.data.pe_qualifications = wasString ? JSON.stringify(quals) : quals;
      snapshot.markModified('data');
      await snapshot.save();
    } catch (e) { console.error('MongoDB Qualification Save Error:', e.message); }

    console.log(`🤖 AI Qualification: ${name || 'Anonymous'} — Score: ${score} — Qualified: ${isQualified}`);

    if (isQualified) {
      await notifyAgent(AGENT_EMAIL, {
        title: '🤖 New AI Qualification: ' + (name || 'Anonymous'),
        description: `Score: ${score}/100\nBudget: ${budget}\nEmail: ${email || 'N/A'}\nPhone: ${phone || 'N/A'}\n\nClient has been pre-qualified for on-site visits.`,
        type: 'lead',
        icon: '🤖',
        emailSubject: `🤖 NEW QUALIFIED LEAD: ${name || 'Anonymous'} (${score}/100)`
      });
    }

    res.json({
      success: true,
      session_token: sessionToken,
      qualification_score: score,
      is_qualified: isQualified,
      message: isQualified
        ? 'Great! You qualify to schedule a property visit.'
        : 'Thank you for your interest. Based on your responses, please contact our agent directly for the best options.'
    });
  } catch (error) {
    console.error('Qualification Error:', error.message);
    res.status(500).json({ error: 'Failed to process qualification: ' + error.message });
  }
});

// GET /api/qualify/:session — check qualification
app.get('/api/qualify/:session', async (req, res) => {
  try {
    const result = await getQualification(req.params.session);
    if (result.success) return res.json({ success: true, data: result.data });
    res.status(404).json({ error: 'Qualification not found' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// BUYER AGREEMENTS — POST /api/agreements
// ──────────────────────────────────────────────────────────────────────────────
app.post('/api/agreements', async (req, res) => {
  try {
    const { signer_name, signer_email, signer_phone, qualification_token, property_name, agreement_text } = req.body;
    if (!signer_name) return res.status(400).json({ error: 'signer_name is required' });
    if (!qualification_token) return res.status(400).json({ error: 'qualification_token is required — complete AI pre-qualification first' });

    // Verify qualification exists and is qualified
    const qualResult = await getQualification(qualification_token);
    if (!qualResult.success) {
      return res.status(400).json({ error: 'Invalid qualification token. Please complete AI pre-qualification first.' });
    }
    if (!qualResult.data.is_qualified) {
      return res.status(403).json({ error: 'Qualification score too low. Please contact the agent directly.' });
    }

    const agreementToken = genToken();
    const agreement = {
      session_token: agreementToken,
      signer_name,
      signer_email: signer_email || qualResult.data.email,
      signer_phone: signer_phone || qualResult.data.phone,
      ip_address: req.headers['x-forwarded-for'] || req.socket.remoteAddress,
      signed_at: new Date().toISOString(),
      agreement_text: agreement_text || 'Buyer Representation Agreement v1.0',
      property_name: property_name || null,
      qualification_id: qualification_token
    };

    const result = await saveAgreement(agreement);

    // Auto-create Agreement document in document vault
    if (result.success && result.data) {
      const docText = `BUYER REPRESENTATION AGREEMENT\n\nSigned by: ${signer_name}\nEmail: ${agreement.signer_email || 'N/A'}\nPhone: ${agreement.signer_phone || 'N/A'}\nProperty: ${property_name || 'N/A'}\nDate: ${new Date().toISOString()}\nAgreement Version: v1.0\n\nI, ${signer_name}, acknowledge and agree to the Buyer Representation Agreement with PropEdge Real Estate.`;
      await saveDocument({
        agreement_id: result.data.id,
        doc_type: 'agreement',
        file_name: `BRA_${signer_name.replace(/\s+/g, '_')}_${new Date().toISOString().split('T')[0]}.txt`,
        file_data: Buffer.from(docText).toString('base64'),
        file_mime: 'text/plain',
        file_size_kb: Math.round(docText.length / 1024) || 1,
        uploader: 'buyer',
        notes: `Auto-generated Buyer Representation Agreement for ${signer_name}`
      });
    }

    // ── Notify Agent (Dashboard & Email)
    await notifyAgent(AGENT_EMAIL, {
      title: '📝 Agreement Signed: ' + signer_name,
      description: `Property: ${property_name || 'N/A'}\nEmail: ${signer_email || 'N/A'}\nPhone: ${signer_phone || 'N/A'}\n\nA formal Buyer Representation Agreement has been electronically signed.`,
      type: 'lead',
      icon: '📝',
      emailSubject: `📝 Buyer Agreement Signed: ${signer_name}`
    });

    console.log(`📝 Agreement Signed: ${signer_name} — Token: ${agreementToken}`);
    res.json({ success: true, agreement_token: agreementToken, message: 'Agreement signed successfully. You may now book your visit.' });
  } catch (error) {
    console.error('Agreement Error:', error.message);
    res.status(500).json({ error: 'Failed to save agreement: ' + error.message });
  }
});

// GET /api/agreements/:session — retrieve agreement
app.get('/api/agreements/:session', async (req, res) => {
  try {
    const result = await getAgreement(req.params.session);
    if (result.success) return res.json({ success: true, data: result.data });
    res.status(404).json({ error: 'Agreement not found' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// DOCUMENTS — POST /api/documents
// ──────────────────────────────────────────────────────────────────────────────
app.post('/api/documents', async (req, res) => {
  try {
    const { lead_id, visit_id, agreement_id, doc_type, file_name, file_data, file_mime, file_size_kb, notes, uploader } = req.body;
    if (!file_name || !doc_type) return res.status(400).json({ error: 'file_name and doc_type are required' });

    const result = await saveDocument({ lead_id, visit_id, agreement_id, doc_type, file_name, file_data, file_mime, file_size_kb, notes, uploader });
    if (result.success) {
      console.log(`📄 Document saved: ${file_name} (${doc_type})`);
      return res.json({ success: true, id: result.data.id, message: 'Document stored securely.' });
    }
    res.status(500).json({ error: result.error });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/documents/:leadId — documents for a lead
app.get('/api/documents/:leadId', async (req, res) => {
  try {
    const result = await getDocumentsByLead(req.params.leadId);
    if (result.success) return res.json({ success: true, data: result.data });
    res.status(500).json({ error: result.error });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/documents — all documents (agent dashboard)
app.get('/api/documents', protect, async (req, res) => {
  try {
    const result = await getAllDocuments();
    if (result.success) return res.json({ success: true, data: result.data });
    res.status(500).json({ error: result.error });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/all-agreements — all agreements (agent dashboard)
app.get('/api/all-agreements', protect, async (req, res) => {
  try {
    const result = await getAllAgreements();
    if (result.success) return res.json({ success: true, data: result.data });
    res.status(500).json({ error: result.error });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// WHATSAPP — POST /api/whatsapp
// ──────────────────────────────────────────────────────────────────────────────
app.post('/api/whatsapp', async (req, res) => {
  try {
    const { to, message, type, visit } = req.body;
    if (!to) return res.status(400).json({ error: 'Recipient phone number (to) is required' });

    let result;
    if (type === 'booking_created' && visit) result = await sendBookingCreatedMsg(to, visit);
    else if (type === 'booking_confirmed' && visit) result = await sendBookingConfirmedMsg(to, visit);
    else if (type === 'reminder' && visit) result = await sendVisitReminderMsg(to, visit);
    else if (message) {
      const { sendWhatsAppText } = require('../services/whatsapp');
      result = await sendWhatsAppText(to, message);
    } else {
      return res.status(400).json({ error: 'Provide either "message" or "type" + "visit"' });
    }

    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// PROPERTY VISITS — POST /api/visits (gated by qualification + agreement)
// ──────────────────────────────────────────────────────────────────────────────
app.post('/api/visits', async (req, res) => {
  const { agentEmail, visit, is_ai_booking } = req.body;
  try {
    if (!agentEmail || !visit) return res.status(400).json({ error: 'agentEmail and visit required' });

    // ── AI Booking Bypass: When Aria books via voice call, skip digital gates
    if (!is_ai_booking) {
      // ── GATE 1: Qualification Check
      if (visit.qualification_token) {
        const qualRes = await getQualification(visit.qualification_token);
        if (!qualRes.success) {
          return res.status(403).json({ error: 'Invalid qualification. Please complete AI pre-qualification first.', code: 'QUAL_REQUIRED' });
        }
        if (!qualRes.data.is_qualified) {
          return res.status(403).json({ error: 'Qualification score too low to book online. Please contact agent.', code: 'QUAL_FAILED' });
        }
      }

      // ── GATE 2: Agreement Check
      if (visit.agreement_token) {
        const agreeRes = await getAgreement(visit.agreement_token);
        if (!agreeRes.success) {
          return res.status(403).json({ error: 'Buyer Agreement not found. Please sign the agreement first.', code: 'AGREE_REQUIRED' });
        }
      }
    } else {
      console.log('🤖 AI booking bypass — skipping qualification/agreement gates');
    }

    // ── Double Booking Check
    try {
      const availability = await getVisitsByDate(visit.visit_date);
      if (availability.success) {
        const isBooked = availability.data.some(v => {
          // Normalize time strings to HH:MM for reliable comparison
          const vTime = String(v.visit_time).trim().substring(0, 5);
          const reqTime = String(visit.visit_time).trim().substring(0, 5);
          return vTime === reqTime;
        });
        if (isBooked) {
          console.warn(`🕒 Attempted double booking: ${visit.visit_date} at ${visit.visit_time}`);
          return res.status(409).json({ error: 'This time slot is already booked. Please choose another time.' });
        }
      }
    } catch (e) {
      console.error('❌ Double Booking Check Error (Non-blocking):', e.message);
      // We continue even if the check fails to avoid blocking the user if Supabase is slow responding to the query
    }

    // ── Save to Supabase
    const { success: supabaseSaved, data: savedVisit, error: supabaseError } = await saveVisitToSupabase({
      ...visit,
      agreement_id: visit.agreement_token || null,
      qualification_id: visit.qualification_token || null,
      status: 'confirmed',
      created_at: new Date().toISOString()
    });

    if (!supabaseSaved) {
      console.error('❌ Supabase Save Failure:', supabaseError);
      return res.status(500).json({ error: 'Database Save Failed: ' + supabaseError });
    }

    const realId = savedVisit.id;
    console.log(`📌 Generated Supabase Visit ID: ${realId}`);

    // ── Save to MongoDB
    let mongodbSaved = false;
    try {
      let snapshot = await DataSnapshot.findOne({ email: agentEmail });
      if (!snapshot) snapshot = new DataSnapshot({ email: agentEmail, data: { pe_bookings: [] } });

      let bookings = snapshot.data.pe_bookings || [];
      // Handle the case where the frontend stored this as a stringified JSON in MongoDB
      if (typeof bookings === 'string') {
        try { bookings = JSON.parse(bookings); } catch (e) { bookings = []; }
      }

      const newVisit = { ...visit, id: realId, status: 'confirmed', created_at: new Date().toISOString() };
      bookings.unshift(newVisit);

      // Keep it consistent with dashboard's preference if it was a string
      snapshot.data.pe_bookings = typeof snapshot.data.pe_bookings === 'string'
        ? JSON.stringify(bookings)
        : bookings;

      snapshot.markModified('data');
      await snapshot.save();
      mongodbSaved = true;
    } catch (e) { console.error('MongoDB Visit Error:', e.message); }

    // ── Agent Email Alert
    try {
      console.log(`📧 API: Sending Agent Alert to [${agentEmail}]`);
      const agentAlertResult = await sendEmail({
        to: agentEmail,
        subject: `🛎️ AGENT ALERT: New Visit Request - ${visit.client_name}`,
        message: `A new property visit has been automatically confirmed!\n\n📌 Property: ${visit.property_name}\n👤 Client: ${visit.client_name}\n📧 Email: ${visit.client_email || 'N/A'}\n📞 Phone: ${visit.client_phone || 'N/A'}\n📅 Date: ${visit.visit_date}\n🕒 Time: ${visit.visit_time}`,
        html: `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;background:#f9f9f9;border-radius:8px;overflow:hidden"><div style="background:#1a1a18;padding:24px;text-align:center"><h2 style="color:#d4b483;margin:0;font-size:22px">🛎️ Agent Alert: New Booking</h2></div><div style="background:#fff;padding:24px"><p style="color:#333;margin-top:0">Hi Admin,</p><p style="color:#555">A new property visit has been <strong>automatically confirmed</strong> for you.</p><table style="width:100%;border-collapse:collapse;margin:16px 0"><tr style="background:#f5f5f5"><td style="padding:10px;border:1px solid #ddd;font-weight:bold;color:#333;width:35%">🏠 Property</td><td style="padding:10px;border:1px solid #ddd;color:#555">${visit.property_name}</td></tr><tr><td style="padding:10px;border:1px solid #ddd;font-weight:bold;color:#333">👤 Lead</td><td style="padding:10px;border:1px solid #ddd;color:#555">${visit.client_name}</td></tr><tr style="background:#f5f5f5"><td style="padding:10px;border:1px solid #ddd;font-weight:bold;color:#333">📧 Email</td><td style="padding:10px;border:1px solid #ddd;color:#555">${visit.client_email || 'N/A'}</td></tr><tr><td style="padding:10px;border:1px solid #ddd;font-weight:bold;color:#333">📞 Phone</td><td style="padding:10px;border:1px solid #ddd;color:#555">${visit.client_phone || 'N/A'}</td></tr><tr style="background:#f5f5f5"><td style="padding:10px;border:1px solid #ddd;font-weight:bold;color:#333">📅 Date</td><td style="padding:10px;border:1px solid #ddd;color:#555">${visit.visit_date}</td></tr><tr><td style="padding:10px;border:1px solid #ddd;font-weight:bold;color:#333">🕒 Time</td><td style="padding:10px;border:1px solid #ddd;color:#555">${visit.visit_time}</td></tr></table><div style="text-align:center;margin-top:20px"><a href="http://localhost:5000/propedge_dashboard.html" style="background:#b8965a;color:#fff;padding:12px 28px;text-decoration:none;border-radius:6px;font-weight:bold;display:inline-block">Open Agent Dashboard →</a></div></div></div>`
      });
      console.log(`📧 Agent Alert: ${agentAlertResult.success ? 'SUCCESS' : 'FAILED'}`);
    } catch (e) {
      console.error('📧 Agent Alert Error (Non-blocking):', e.message);
    }

    // ── Client Confirmation Email
    try {
      if (visit.client_email) {
        console.log(`📧 Sending Client Confirmation to [${visit.client_email}]`);
        const clientEmailResult = await sendEmail({
          to: visit.client_email,
          subject: `🏡 CONFIRMED: Your visit to ${visit.property_name}`,
          message: `Hi ${visit.client_name},\n\nYour property visit is CONFIRMED!\n\n📌 Property: ${visit.property_name}\n📅 Date: ${visit.visit_date}\n🕒 Time: ${visit.visit_time}\n\nWe look forward to seeing you at the property!`,
          html: `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;background:#f9f9f9;border-radius:8px;overflow:hidden"><div style="background:#1a1a18;padding:24px;text-align:center"><h2 style="color:#2ecc8a;margin:0">🏡 Visit Confirmed!</h2></div><div style="background:#fff;padding:24px"><p style="color:#333;margin-top:0">Hi ${visit.client_name},</p><p style="color:#555">Your property visit has been <strong>successfully confirmed</strong>. We look forward to seeing you!</p><div style="background:#f0fdf8;border:1px solid #2ecc8a;border-radius:6px;padding:16px;margin:16px 0"><p style="margin:0 0 8px;font-weight:bold;color:#333">📋 Your Booking Details</p><p style="margin:4px 0;color:#555"><strong>Property:</strong> ${visit.property_name}</p><p style="margin:4px 0;color:#555"><strong>Date:</strong> ${visit.visit_date}</p><p style="margin:4px 0;color:#555"><strong>Time:</strong> ${visit.visit_time}</p><p style="margin:4px 0;color:#2ecc8a"><strong>Status:</strong> ✅ Confirmed</p></div><p style="color:#333;font-weight:bold">Agent Contact:</p><p style="color:#555;margin:4px 0">👤 ${AGENT_NAME}</p><p style="color:#555;margin:4px 0">📧 ${AGENT_EMAIL}</p></div></div>`
        });
        console.log(`📧 Client Confirmation: ${clientEmailResult.success ? 'SUCCESS' : 'FAILED'}`);
      }
    } catch (e) {
      console.error('📧 Client Confirmation Error (Non-blocking):', e.message);
    }

    // ── WhatsApp Notification to Client
    if (visit.client_phone) {
      try {
        const waResult = await sendBookingCreatedMsg(visit.client_phone, { ...visit, id: realId });
        if (waResult.success) {
          await updateVisitInSupabase(realId, { whatsapp_sent: true });
        }
      } catch (e) { console.error('WhatsApp Error:', e.message); }
    }

    // ── Notify Agent (Dashboard Only - avoids duplicate email)
    await notifyAgent(agentEmail, {
      title: 'Tour Confirmed: ' + visit.client_name,
      description: `Property: ${visit.property_name}\nDate: ${visit.visit_date} at ${visit.visit_time}\nClient: ${visit.client_name} (${visit.client_phone || 'N/A'})`,
      type: 'booking',
      icon: '✅'
      // emailSubject removed here because we sent a detailed HTML alert above
    });

    return res.json({ success: true, supabaseSaved: true, mongodbSaved, id: realId });
  } catch (error) {
    res.status(500).json({ error: 'Failed to create visit: ' + error.message });
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// UPDATE VISIT — PATCH /api/visits/:id
// ──────────────────────────────────────────────────────────────────────────────
app.patch('/api/visits/:id', async (req, res) => {
  const { id } = req.params;
  const { agentEmail, updates } = req.body;
  if (updates && updates.status) updates.status = updates.status.toLowerCase();

  try {
    const supabaseResult = await updateVisitInSupabase(id, updates);

    if (agentEmail) {
      const snapshot = await DataSnapshot.findOne({ email: agentEmail });
      if (snapshot && snapshot.data.pe_bookings) {
        const idx = snapshot.data.pe_bookings.findIndex(v => v.id === id);
        if (idx !== -1) {
          snapshot.data.pe_bookings[idx] = { ...snapshot.data.pe_bookings[idx], ...updates };
          snapshot.markModified('data');
          await snapshot.save();
        }
      }
    }

    try {
      const visitRes = await getVisitFromSupabase(id);
      if (visitRes.success) {
        const v = visitRes.data;
        const isConfirmed = String(updates.status || '').toLowerCase() === 'confirmed';
        const isRejected = String(updates.status || '').toLowerCase() === 'rejected';

        if ((isConfirmed || isRejected) && v.client_email) {
          const confirmSubject = isConfirmed
            ? `✅ Your visit is CONFIRMED: ${v.property_name}`
            : `❌ Visit Not Available: ${v.property_name}`;
          const confirmHtml = isConfirmed
            ? `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;background:#f9f9f9;border-radius:8px;overflow:hidden"><div style="background:#1a1a18;padding:24px;text-align:center"><h2 style="color:#2ecc8a;margin:0">✅ Visit Confirmed!</h2></div><div style="background:#fff;padding:24px"><p style="color:#333;margin-top:0">Hi ${v.client_name},</p><p style="color:#555">Your property visit has been <strong style="color:#2ecc8a">confirmed</strong>. We look forward to seeing you!</p><div style="background:#f0fdf8;border:1px solid #2ecc8a;border-radius:6px;padding:16px;margin:16px 0"><p style="margin:0 0 8px;font-weight:bold;color:#333">📋 Booking Confirmation</p><p style="margin:4px 0;color:#555"><strong>Property:</strong> ${v.property_name}</p><p style="margin:4px 0;color:#555"><strong>Date:</strong> ${v.visit_date}</p><p style="margin:4px 0;color:#555"><strong>Time:</strong> ${v.visit_time}</p><p style="margin:4px 0;color:#2ecc8a"><strong>Status:</strong> ✅ Confirmed</p></div><p style="color:#333;font-weight:bold">Your Agent:</p><p style="color:#555;margin:4px 0">👤 ${AGENT_NAME}</p><p style="color:#555;margin:4px 0">📧 ${AGENT_EMAIL}</p><p style="color:#555;margin:4px 0">📞 ${process.env.AGENT_PHONE || '+971 50 123 4567'}</p></div><div style="background:#1a1a18;padding:14px;text-align:center"><p style="color:#888;font-size:12px;margin:0">PropEdge Real Estate</p></div></div>`
            : `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto"><div style="background:#1a1a18;padding:24px;text-align:center"><h2 style="color:#e05060;margin:0">Visit Not Available</h2></div><div style="background:#fff;padding:24px"><p>Hi ${v.client_name},</p><p>Unfortunately the visit slot for <strong>${v.property_name}</strong> (${v.visit_date} at ${v.visit_time}) is not available.</p><p>Please visit our website to request a new date and time.</p></div></div>`;

          console.log(`📧 Sending ${isConfirmed ? 'CONFIRMED' : 'REJECTED'} email to [${v.client_email}]`);
          await sendEmail({ to: v.client_email, subject: confirmSubject, html: confirmHtml, message: confirmSubject });

          // WhatsApp follow-up on confirmation
          if (isConfirmed && v.client_phone) {
            try { await sendBookingConfirmedMsg(v.client_phone, v); } catch (e) { }
          }
        }

        // Dashboard notification
        if (agentEmail && (isConfirmed || isRejected)) {
          try {
            let snapshot = await DataSnapshot.findOne({ email: agentEmail });
            if (snapshot) {
              let notifs = snapshot.data.pe_notifications || [];
              const wasString = typeof notifs === 'string';
              if (wasString) {
                try { notifs = JSON.parse(notifs); } catch (e) { notifs = []; }
              }

              notifs.unshift({
                id: Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
                title: `Visit ${isConfirmed ? 'Confirmed' : 'Rejected'}: ${v.client_name}`,
                description: `${v.property_name} · ${v.visit_date} ${v.visit_time}`,
                type: 'booking', icon: isConfirmed ? '✅' : '❌', is_read: false,
                created_at: new Date().toISOString()
              });

              snapshot.data.pe_notifications = wasString ? JSON.stringify(notifs) : notifs;
              snapshot.markModified('data');
              await snapshot.save();
            }
          } catch (e) { }
        }
      }
    } catch (e) { console.error('Notification Error in PATCH:', e.message); }

    res.json({ success: true, supabaseUpdated: supabaseResult.success });
  } catch (error) {
    res.status(500).json({ error: 'Failed to update visit: ' + error.message });
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// AUTOMATED REMINDERS — GET /api/cron/reminders
// ──────────────────────────────────────────────────────────────────────────────
app.get('/api/cron/reminders', async (req, res) => {
  try {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const dateStr = tomorrow.toISOString().split('T')[0];

    console.log(`⏰ Running Reminders Cron for: ${dateStr}`);

    const visits = await getVisitsByDate(dateStr);
    if (!visits.success || !visits.data.length) {
      return res.json({ success: true, message: 'No visits scheduled for tomorrow.' });
    }

    let sentCount = 0;
    for (const v of visits.data) {
      if (v.status === 'confirmed' && v.client_email) {
        const reminderHtml = `
          <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;background:#f9f9f9;border-radius:8px;overflow:hidden">
            <div style="background:#1a1a18;padding:24px;text-align:center"><h2 style="color:#d4b483;margin:0">⏰ Visit Reminder: Tomorrow</h2></div>
            <div style="background:#fff;padding:24px">
              <p style="color:#333;margin-top:0">Hi ${v.client_name},</p>
              <p style="color:#555">This is a reminder for your property visit scheduled for <strong>tomorrow</strong>.</p>
              <div style="background:#fffbf0;border:1px solid #d4b483;border-radius:6px;padding:16px;margin:16px 0">
                <p style="margin:4px 0;color:#555"><strong>Property:</strong> ${v.property_name}</p>
                <p style="margin:4px 0;color:#555"><strong>Date:</strong> ${v.visit_date}</p>
                <p style="margin:4px 0;color:#555"><strong>Time:</strong> ${v.visit_time}</p>
                <p style="margin:4px 0;color:#2ecc8a"><strong>Status:</strong> Confirmed</p>
              </div>
              <p style="color:#333;font-weight:bold">Contact Details:</p>
              <p style="color:#555;margin:4px 0">👤 Agent: ${AGENT_NAME}</p>
              <p style="color:#555;margin:4px 0">📞 ${process.env.AGENT_PHONE || '+971 50 123 4567'}</p>
              <p style="color:#555;margin:4px 0">📧 ${AGENT_EMAIL}</p>
              <div style="text-align:center;margin-top:20px">
                <a href="https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(v.property_name + ' Dubai')}" style="background:#b8965a;color:#fff;padding:12px 28px;text-decoration:none;border-radius:6px;font-weight:bold;display:inline-block">View Location on Maps →</a>
              </div>
            </div>
            <div style="background:#1a1a18;padding:14px;text-align:center"><p style="color:#888;font-size:12px;margin:0">PropEdge Real Estate</p></div>
          </div>`;

        await sendEmail({
          to: v.client_email,
          subject: `⏰ Reminder: Your visit to ${v.property_name} is tomorrow`,
          html: reminderHtml,
          message: `Reminder: Your visit to ${v.property_name} is tomorrow at ${v.visit_time}. Location: Dubai.`
        });
        sentCount++;
      }
    }

    res.json({ success: true, sentCount });
  } catch (error) {
    console.error('Cron Error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// AI REMINDER CALLS — GET /api/cron/reminder-calls
// Finds visits happening 2 hours from now and places a Twilio reminder call.
// Run this every 15 minutes via an external cron or Vercel cron job.
// ──────────────────────────────────────────────────────────────────────────────
app.get('/api/cron/reminder-calls', async (req, res) => {
  try {
    const now = new Date();
    const targetTime = new Date(now.getTime() + 2 * 60 * 60 * 1000); // +2 hours
    const dateStr = targetTime.toISOString().split('T')[0];
    const hourStr = String(targetTime.getHours()).padStart(2, '0');
    const minStr = String(targetTime.getMinutes()).padStart(2, '0');
    const timePrefix = `${hourStr}:${minStr}`;

    console.log(`⏰ Reminder Calls Cron → looking for visits on ${dateStr} around ${timePrefix}`);

    const visits = await getVisitsByDate(dateStr);
    if (!visits.success || !visits.data.length) {
      return res.json({ success: true, message: 'No visits found for the reminder window.' });
    }

    let calledCount = 0;
    for (const v of visits.data) {
      if (v.status !== 'confirmed') continue;
      const visitTimeStr = String(v.visit_time).trim().substring(0, 5); // HH:MM
      // Only call if within ±10 minutes of target
      const [vh, vm] = visitTimeStr.split(':').map(Number);
      const [th, tm] = [targetTime.getHours(), targetTime.getMinutes()];
      const diffMins = Math.abs((vh * 60 + vm) - (th * 60 + tm));
      if (diffMins > 10) continue;

      if (v.client_phone) {
        await triggerReminderCall(v);
        calledCount++;
      }
    }

    res.json({ success: true, calledCount, dateStr, timePrefix });
  } catch (error) {
    console.error('Reminder Calls Cron Error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// DELETE VISIT — DELETE /api/visits/:id
// ──────────────────────────────────────────────────────────────────────────────
app.delete('/api/visits/:id', async (req, res) => {
  const { id } = req.params;
  const { agentEmail } = req.query;
  try {
    const supabaseResult = await deleteVisitFromSupabase(id);
    if (agentEmail) {
      await connectDB();
      let snapshot = await DataSnapshot.findOne({ email: agentEmail });
      if (snapshot && snapshot.data.pe_bookings) {
        let bookings = snapshot.data.pe_bookings;
        let wasString = typeof bookings === 'string';
        if (wasString) {
          try { bookings = JSON.parse(bookings); } catch (e) { bookings = []; }
        }

        if (Array.isArray(bookings)) {
          snapshot.data.pe_bookings = bookings.filter(v => v.id !== id);
          if (wasString) snapshot.data.pe_bookings = JSON.stringify(snapshot.data.pe_bookings);
          snapshot.markModified('data');
          await snapshot.save();
        }
      }
    }
    res.json({ success: true, supabaseDeleted: supabaseResult.success });
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete visit: ' + error.message });
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// EMAIL
// ──────────────────────────────────────────────────────────────────────────────
app.get('/api/send-email', (req, res) => res.json({ message: 'Email service ready' }));

app.post('/api/send-email', async (req, res) => {
  try {
    const { to, subject, message } = req.body;
    if (!to || !subject || !message) return res.status(400).json({ error: 'to, subject, and message are required' });
    const result = await sendEmail({ to, subject, message });
    if (result.success) res.json({ success: true, data: result.data });
    else res.status(500).json({ error: result.error });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// AI — Property Description
// ──────────────────────────────────────────────────────────────────────────────
app.post('/api/ai/description', async (req, res) => {
  try {
    const { details } = req.body;
    if (!details) return res.status(400).json({ error: 'Property details required' });
    const result = await generateDescription(details);
    if (result.success) res.json({ text: result.text });
    else res.status(500).json({ error: result.error });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// AI — Pitch Generator & Smart Matcher
// ──────────────────────────────────────────────────────────────────────────────
app.post('/api/ai/pitch', async (req, res) => {
  try {
    const { lead, properties } = req.body;
    if (!lead || !properties) return res.status(400).json({ error: 'lead and properties required' });
    const { generatePitchScript } = require('../services/ai');
    const result = await generatePitchScript(lead, properties);
    if (result.success) res.json({ script: result.script, matches: result.matches });
    else res.status(500).json({ error: result.error });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// AI — Live Property Sync
// Exposes the flattened property list to Aria Voice Agent
// ──────────────────────────────────────────────────────────────────────────────
app.get('/api/ai/properties', async (req, res) => {
  try {
    const agentEmail = AGENT_EMAIL;
    const snapshot = await DataSnapshot.findOne({ email: agentEmail });

    if (!snapshot || !snapshot.data || !snapshot.data.pe_properties) {
      return res.json({ success: true, count: 0, properties: [] });
    }

    let properties = snapshot.data.pe_properties;
    if (typeof properties === 'string') {
      try { properties = JSON.parse(properties); } catch (e) { properties = []; }
    }

    // Map to a cleaner format Aria likes
    const formatted = properties.map(p => ({
      id: p.id,
      name: p.name || p.title || 'Property',
      location: p.location || 'N/A',
      price: p.price_label || p.price || 'Contact Agent',
      property_type: p.property_type || 'apartment',
      features: p.features || '',
      available: p.status === 'available' || true
    }));

    res.json({ success: true, count: formatted.length, properties: formatted });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// LEADS — POST /api/leads
// ──────────────────────────────────────────────────────────────────────────────
app.post('/api/leads', async (req, res) => {
  try {
    const { agentEmail, lead } = req.body;
    if (!agentEmail || !lead) return res.status(400).json({ error: 'agentEmail and lead required' });
    console.log(`📩 Processing lead for ${agentEmail}: ${lead.name}`);

    let supabaseResult = { success: false, error: 'Not attempted' };
    try { supabaseResult = await saveLeadToSupabase(lead); }
    catch (e) { console.error('Supabase Error:', e.message); }

    let mongodbSaved = false;
    try {
      let snapshot = await DataSnapshot.findOne({ email: agentEmail });
      if (!snapshot) snapshot = new DataSnapshot({ email: agentEmail, data: {} });
      if (!snapshot.data) snapshot.data = {};

      let leads = snapshot.data.pe_leads || [];
      const wasString = typeof leads === 'string';
      if (wasString) {
        try { leads = JSON.parse(leads); } catch (e) { leads = []; }
      }

      lead.created_at = lead.created_at || new Date().toISOString();
      lead.id = lead.id || (Date.now().toString(36) + Math.random().toString(36).slice(2, 6));
      leads.unshift(lead);

      snapshot.data.pe_leads = wasString ? JSON.stringify(leads) : leads;
      snapshot.markModified('data');
      await snapshot.save();
      mongodbSaved = true;
    } catch (e) { console.error('MongoDB Error:', e.message); }

    let emailResult = { success: false, error: 'Not attempted' };
    try {
      emailResult = await sendEmail({
        to: agentEmail,
        subject: `🔔 New Lead: ${lead.name}`,
        message: `Hi,\n\nYou have a new lead!\n\n👤 Name: ${lead.name}\n📞 Phone: ${lead.phone || 'N/A'}\n📧 Email: ${lead.email || 'N/A'}\n🏠 Interest: ${lead.property_interest || 'N/A'}\n💰 Budget: ${lead.budget || 'N/A'}\n🛏️ BHK: ${lead.bhk_preference || 'N/A'}\n✅ Pre-Approved: ${lead.pre_approval_status || 'N/A'}\n📝 Notes: ${lead.notes || 'N/A'}\n\nLog in to your dashboard to take action.`
      });
    } catch (e) { emailResult.error = e.message; }

    // WhatsApp to agent if phone configured
    try { await sendNewLeadNotification('+919999999999', lead); } catch (e) { }

    // ── Speed-to-Lead Auto Responder for the LEAD
    if (req.body.autoRespond === true) {
      if (lead.email) {
        try {
          await sendEmail({
            to: lead.email,
            subject: 'Thank you for your interest - PropEdge',
            message: `Hi ${lead.name},\n\nThank you for reaching out regarding your interest in ${lead.property_interest || 'premium real estate'}. I have received your request and will be in touch shortly to assist you.\n\nBest regards,\n${AGENT_NAME}`
          });
          console.log(`🚀 Auto-Responder Email sent to ${lead.email}`);
        } catch (e) {
          console.error('Auto-Responder Email failed:', e.message);
        }
      }
      if (lead.phone) {
        try {
          const { sendWhatsAppText } = require('../services/whatsapp');
          await sendWhatsAppText(lead.phone, `Hi ${lead.name}, thank you for your interest in ${lead.property_interest || 'our properties'}! I am reviewing your request and will contact you shortly. - ${AGENT_NAME}`);
          console.log(`🚀 Auto-Responder WA sent to ${lead.phone}`);
        } catch (e) {
          console.error('Auto-Responder WA failed:', e.message);
        }
      }
      // 🚀 NEW: Send AI Voice Call Link to the Lead via WhatsApp
      try { await sendAICallLink(lead.phone, lead); } catch (e) { console.error('WA AI Link Error:', e.message); }
    }

    // ── ⚡ INSTANT AI CALL — triggered within seconds of lead arrival
    if (lead.phone) {
      triggerAICall(lead).then(result => {
        if (result.success || result.callSid) {
          console.log(`⚡ Instant AI call fired for ${lead.name} (${lead.phone})`);
        }
      });

      // 📱 NEW: Cloud Mailbox for Laptop-Free AI
      pendingLeads.push(lead);
    }

    // ── Notify Agent (Dashboard & Email)
    await notifyAgent(agentEmail, {
      title: '🔥 New Lead: ' + lead.name,
      description: `Interest: ${lead.property_interest || 'General'}\nEmail: ${lead.email || 'N/A'}\nPhone: ${lead.phone || 'N/A'}\nBudget: ${lead.budget || 'N/A'}`,
      type: 'lead',
      icon: '👤',
      emailSubject: `🔔 New Lead: ${lead.name}`
    });

    const finalSuccess = mongodbSaved || supabaseResult.success || emailResult.success;

    res.json({
      success: finalSuccess,
      supabaseSaved: supabaseResult.success,
      mongodbSaved,
      emailSent: emailResult.success,
      details: {
        supabase: supabaseResult.error || (supabaseResult.success ? 'OK' : 'Failed'),
        mongodb: mongodbSaved ? 'OK' : 'Failed',
        email: emailResult.error || (emailResult.success ? 'OK' : 'Failed')
      }
    });
  } catch (error) {
    console.error('Lead Submission Critical Error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// LEGACY — notify-lead
// ──────────────────────────────────────────────────────────────────────────────
app.post('/api/notify-lead', async (req, res) => {
  try {
    const { agentEmail, lead } = req.body;
    if (!agentEmail || !lead) return res.status(400).json({ error: 'agentEmail and lead required' });
    const emailResult = await sendEmail({
      to: agentEmail,
      subject: `🔔 New Lead: ${lead.name}`,
      message: `New lead!\n\n👤 Name: ${lead.name}\n📞 Phone: ${lead.phone || 'N/A'}\n🏠 Property Interest: ${lead.property_interest || 'N/A'}`
    });
    try {
      let snapshot = await DataSnapshot.findOne({ email: agentEmail });
      if (snapshot) {
        if (!snapshot.data.pe_leads) snapshot.data.pe_leads = [];
        let leads = snapshot.data.pe_leads;
        let wasString = typeof leads === 'string';
        if (wasString) {
          try { leads = JSON.parse(leads); } catch (e) { leads = []; }
        }

        if (Array.isArray(leads)) {
          leads.unshift(lead);
          snapshot.data.pe_leads = wasString ? JSON.stringify(leads) : leads;
          snapshot.markModified('data');
          await snapshot.save();
        }
      }
    } catch (e) { }
    await pushNotification(agentEmail, 'new_lead', `New lead: ${lead.name}`);
    res.json({ success: true, emailSent: emailResult.success });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// CALLS — POST /api/calls
// ──────────────────────────────────────────────────────────────────────────────
app.post('/api/calls', async (req, res) => {
  try {
    const agentEmail = req.body.agentEmail || req.body.email;
    const { call } = req.body;
    if (!agentEmail || !call) return res.status(400).json({ error: 'agentEmail and call data required' });

    console.log(`📞 Saving call log for ${agentEmail} (Lead: ${call.leadName || 'Unknown'})`);

    let snapshot = await DataSnapshot.findOne({ email: agentEmail });
    if (!snapshot) snapshot = new DataSnapshot({ email: agentEmail, data: {} });
    if (!snapshot.data) snapshot.data = {};

    let calls = snapshot.data.pe_calls || [];
    const wasString = typeof calls === 'string';
    if (wasString) {
      try { calls = JSON.parse(calls); } catch (e) { calls = []; }
    }

    const newCall = {
      ...call,
      id: call.id || ('call_' + Date.now() + Math.random().toString(36).slice(2, 5)),
      urgency: call.urgency || 3,
      created_at: call.created_at || new Date().toISOString()
    };

    calls.unshift(newCall);

    // Keep only last 100 calls to save space
    if (calls.length > 100) calls = calls.slice(0, 100);

    snapshot.data.pe_calls = wasString ? JSON.stringify(calls) : calls;
    snapshot.markModified('data');
    await snapshot.save();

    res.json({ success: true, urgency: newCall.urgency });
  } catch (error) {
    console.error('Call Log Error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// SYNC
// ──────────────────────────────────────────────────────────────────────────────
// ──────────────────────────────────────────────────────────────────────────────
// MOBILE APP SIGNALS
// ──────────────────────────────────────────────────────────────────────────────
app.post('/api/mobile/notify', async (req, res) => {
  try {
    const { lead, type } = req.body;
    console.log(`📱 Notifying Mobile App: New ${type || 'Action'} for ${lead.name}`);

    // In a production app, you would send a FCM (Firebase Cloud Messaging) 
    // or OneSignal push notification here to wake up the phone.

    res.json({ success: true, message: 'Mobile notification dispatched' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/mobile/version', (req, res) => {
  res.json({ version: 1.2, last_update: new Date().toISOString() });
});

// 🧠 $0-COST CLOUD BRAIN (Manual Script on Vercel)
let pendingLeads = []; // Global mailbox for laptop-free operation

app.get('/api/mobile/poll-leads', (req, res) => {
  if (pendingLeads.length > 0) {
    return res.json({ lead: pendingLeads.shift() });
  }
  res.json({ lead: null });
});

app.post('/api/ai/chat', (req, res) => {
  const { input, state, lead } = req.body;
  const text = (input || "").toLowerCase();

  let reply = "";
  let nextState = state;

  // Simple State Machine Logic (Free)
  if (state === 'INITIAL') {
    reply = `Great! To get things started, are you looking to buy for yourself or is this more of an investment?`;
    nextState = 'DISCOVERY';
  } else if (state === 'DISCOVERY') {
    reply = `Got it. And what kind of property are you after? A villa, an apartment, or maybe something else?`;
    nextState = 'QUAL';
  } else if (state === 'QUAL') {
    reply = `That works! Roughly what budget range are we looking at for this search?`;
    nextState = 'TIMELINE';
  } else if (state === 'TIMELINE') {
    reply = `Perfect. Would you like to visit one of our top properties this weekend, or are you just exploring for now?`;
    nextState = 'BOOKING';
  } else if (state === 'BOOKING') {
    reply = `Excellent choice. I'll have our lead agent, Sarah, send you the exact location details via WhatsApp right now. We're looking forward to seeing you!`;
    nextState = 'END';
  } else {
    reply = "I've noted all your preferences. One of our specialists will reach out shortly with the best matches. Anything else I can help with?";
  }

  res.json({ reply, nextState, lead });
});

app.get('/api/sync', protect, async (req, res) => {
  try {
    const { email } = req.query;
    if (!email) return res.status(400).json({ error: 'Email required' });
    const snapshot = await DataSnapshot.findOne({ email });
    res.json(snapshot && snapshot.data ? snapshot.data : {});
  } catch (error) {
    res.status(500).json({ error: 'Database Error: ' + error.message });
  }
});

app.post('/api/sync', protect, async (req, res) => {
  try {
    const { email, data } = req.body;
    if (!email || !data) return res.status(400).json({ error: 'Email and data required' });
    await DataSnapshot.findOneAndUpdate({ email }, { email, data }, { upsert: true });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Database Error: ' + error.message });
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// MARKETING - POST /api/marketing/kit
// ──────────────────────────────────────────────────────────────────────────────
app.post('/api/marketing/kit', async (req, res) => {
  try {
    const { propertyId, agentEmail } = req.body;
    if (!propertyId) return res.status(400).json({ error: 'propertyId is required' });

    // Fetch property - in a real app, this would be from DB
    // Here we might need to find it from the agent's data snapshot in MongoDB
    const snapshot = await DataSnapshot.findOne({ email: agentEmail });
    if (!snapshot || !snapshot.data || !snapshot.data.pe_properties) {
      return res.status(404).json({ error: 'Agent properties not found' });
    }

    const properties = typeof snapshot.data.pe_properties === 'string'
      ? JSON.parse(snapshot.data.pe_properties)
      : snapshot.data.pe_properties;

    const prop = properties.find(p => p.id === propertyId);
    if (!prop) return res.status(404).json({ error: 'Property not found' });

    const kitResponse = await generateSocialMarketingKit(prop);
    res.json(kitResponse);
  } catch (error) {
    console.error('Marketing Kit Error:', error.message);
    res.status(500).json({ error: 'Failed to generate kit: ' + error.message });
  }
});



// ──────────────────────────────────────────────────────────────────────────────
// MARKETING - POST /api/marketing/whatsapp-blast  (REAL — Meta WhatsApp API)
// ──────────────────────────────────────────────────────────────────────────────
app.post('/api/marketing/whatsapp-blast', async (req, res) => {
  try {
    const { phone, message } = req.body;
    if (!phone || !message) return res.status(400).json({ error: 'phone and message required' });

    const { sendWhatsAppText } = require('../services/whatsapp');
    const result = await sendWhatsAppText(phone, message);

    console.log(`📱 WhatsApp Blast to ${phone}: ${result.success ? 'SENT' : 'FAILED'}`);
    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// SOCIAL PUBLISH - POST /api/social/publish  (Meta Graph API)
// ──────────────────────────────────────────────────────────────────────────────
app.post('/api/social/publish', async (req, res) => {
  try {
    const { platform, accessToken, mediaUrl, caption, pageId } = req.body;
    if (!platform || !accessToken) return res.status(400).json({ error: 'platform and accessToken required' });

    const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));

    if (platform === 'instagram') {
      const igId = pageId || process.env.META_IG_USER_ID;
      if (!igId) return res.status(400).json({ error: 'META_IG_USER_ID not set' });

      // Step 1: Create container
      const containerRes = await fetch(`https://graph.facebook.com/v19.0/${igId}/media`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image_url: mediaUrl, caption, access_token: accessToken })
      });
      const container = await containerRes.json();
      if (!container.id) return res.status(400).json({ error: 'IG container failed', detail: container });

      // Step 2: Publish
      const publishRes = await fetch(`https://graph.facebook.com/v19.0/${igId}/media_publish`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ creation_id: container.id, access_token: accessToken })
      });
      const published = await publishRes.json();
      return res.json({ success: !!published.id, post_id: published.id, platform: 'instagram' });
    }

    if (platform === 'facebook') {
      const fbPageId = pageId || process.env.META_FB_PAGE_ID;
      if (!fbPageId) return res.status(400).json({ error: 'META_FB_PAGE_ID not set' });

      const postRes = await fetch(`https://graph.facebook.com/v19.0/${fbPageId}/photos`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: mediaUrl, caption, access_token: accessToken, published: true })
      });
      const post = await postRes.json();
      return res.json({ success: !!post.post_id, post_id: post.post_id, platform: 'facebook' });
    }

    return res.status(400).json({ error: 'Platform not supported yet: ' + platform });
  } catch (error) {
    console.error('Social Publish Error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// SERVER
// ──────────────────────────────────────────────────────────────────────────────
if (process.env.NODE_ENV !== 'production' && !process.env.VERCEL) {
  const PORT = process.env.PORT || 5000;
  app.listen(PORT, () => console.log(`PropEdge Server running on port ${PORT}`));
}

module.exports = app;
