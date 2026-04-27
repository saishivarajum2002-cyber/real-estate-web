// transfer_call.js
// ─────────────────────────────────────────────────────────────────────────────
// Transfers the active Twilio call to a human real estate agent.
// Set TRANSFER_NUMBER in .env to the agent's phone number (E.164 format).
// ─────────────────────────────────────────────────────────────────────────────
require('dotenv').config();

const transfer_call = async function ({ callSid, reason = 'user_requested' }) {
  console.log(`transfer_call → SID: ${callSid}, reason: ${reason}`.magenta);

  const transferNumber = process.env.TRANSFER_NUMBER;

  if (!transferNumber) {
    console.error('transfer_call → TRANSFER_NUMBER is not set in .env'.red);
    return {
      status: 'failed',
      message: 'No transfer number configured. Please set TRANSFER_NUMBER in your .env file.',
    };
  }

  try {
    const accountSid = process.env.TWILIO_ACCOUNT_SID;
    const authToken  = process.env.TWILIO_AUTH_TOKEN;
    const client     = require('twilio')(accountSid, authToken);

    await client.calls(callSid).update({
      twiml: `<Response><Dial>${transferNumber}</Dial></Response>`,
    });

    console.log(`transfer_call → Call ${callSid} transferred to ${transferNumber}`.green);
    return {
      status: 'success',
      message: 'The call was transferred successfully. Say goodbye to the customer.',
    };
  } catch (err) {
    console.error('transfer_call → Transfer failed:'.red, err.message);
    return {
      status: 'failed',
      message: 'The call could not be transferred. Advise the customer to call back shortly.',
    };
  }
};

module.exports = transfer_call;
