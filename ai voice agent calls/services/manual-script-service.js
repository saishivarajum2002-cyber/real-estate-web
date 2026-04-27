// manual-script-service.js
// ─────────────────────────────────────────────────────────────────────────────
// The deterministic "Aria Manual Script Engine".
// Replaces Ollama/GPT with a state-based logic for real estate qualification.
// ─────────────────────────────────────────────────────────────────────────────
const EventEmitter = require('events');
const getProperty = require('../functions/getProperty');
const bookAppointment = require('../functions/bookAppointment');
const transfer_call = require('../functions/transfer_call');

class ManualScriptService extends EventEmitter {
  constructor() {
    super();
    this.sessionState = 'INITIAL'; // INITIAL, IDENTIFY, START, DISCOVERY, QUAL, TIMELINE, BOOKING, END
    this.leadInfo = {};
    this.callSid = null;
    this.history = []; // [{ role: 'Aria', text: '...' }, { role: 'User', text: '...' }]
  }

  setCallSid(sid) { this.callSid = sid; }
  setLeadInfo(info) { this.leadInfo = info; }

  getTranscript() { return this.history; }
  getOutcome() {
    if (this.sessionState === 'END') return 'Conversation Completed';
    if (this.sessionState === 'BOOKING') return 'Interest in Property';
    return 'In Progress';
  }

  /**
   * Main entry point for transcribed text.
   */
  async completion(text, interactionCount) {
    const input = text.toLowerCase();
    this.history.push({ role: 'User', text: text });
    let response = '';

    // ── Global Keyword Checks
    if (this.matches(input, ['human', 'agent', 'person', 'connect', 'talk to'])) {
      this.emit('gptreply', { partialResponse: "Absolutely. One moment while I put you through to our lead agent, they'll be able to help you better from here." }, interactionCount);
      const res = await transfer_call();
      return;
    }

    if (this.matches(input, ['price', 'how much', 'cost', 'where', 'location', 'detail'])) {
      const propData = await getProperty({ location: input, budget: null });
      if (propData.found) {
        const p = propData.properties[0];
        response = `That's a great choice. ${p.name} is in ${p.location} and starts at ${p.price}. `;
        // Keep flow moving
      } else {
        response = "I don't have the exact price list in front of me, but I can check that for you. ";
      }
    }

    // ── State Machine Logic
    switch (this.sessionState) {
      case 'INITIAL':
        if (!this.leadInfo.name) {
          // It's an inbound caller Aria doesn't know yet
          this.leadInfo.name = input.replace('my name is', '').trim();
          response = `It's lovely to meet you, ${this.leadInfo.name}! To help me find the best options for you, are you searching for a home to live in, or is this for an investment?`;
          this.sessionState = 'DISCOVERY';
        } else {
          // Outbound lead who knows Aria
          if (this.matches(input, ['no', 'bad', 'later', 'busy'])) {
            response = "No problem at all. I'll reach out some other time. Have a great day!";
            this.sessionState = 'END';
          } else {
            response += "Great! To get things started, are you looking to buy for yourself or is this more of an investment?";
            this.sessionState = 'DISCOVERY';
          }
        }
        break;

      case 'DISCOVERY':
        // User answered Buy/Invest
        response += this.randomBridge() + "And what kind of property are you after? A villa, an apartment, or maybe something else?";
        this.sessionState = 'QUAL';
        break;

      case 'QUAL':
        // User answered Type (Villa/Apt)
        response += "That works! And roughly what budget range are we looking at for this search?";
        this.sessionState = 'TIMELINE';
        break;

      case 'TIMELINE':
        // User answered Budget
        response += "Perfect. And are you looking to move in quite soon, or just exploring the market for now?";
        this.sessionState = 'BOOKING_TRIAL';
        break;

      case 'BOOKING_TRIAL':
        // User answered Timeline
        try {
          const propData = await getProperty(); // Fetch all active properties
          let propList = "";
          if (propData.found && propData.properties.length > 0) {
            const topProps = propData.properties.slice(0, 3);
            propList = "Regarding our active listings, we have " + 
                       topProps.map(p => `${p.name} in ${p.location}`).join(", and ") + ". ";
          }
          
          response += `Honestly, the best way to get a feel for a place is to see it in person. ${propList}Out of these, or any others you saw on our site, which one would you like to visit?`;
          this.sessionState = 'BOOKING';
        } catch (e) {
          response += "Honestly, the best way is to see it in person. When would you be free this week for a quick visit?";
          this.sessionState = 'BOOKING';
        }
        break;

      case 'BOOKING':
        // User responded with a property name or preference
        if (this.matches(input, ['weekday', 'weekend', 'morning', 'afternoon', 'tomorrow', 'today', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'])) {
          response = "That slot works perfectly. I've noted that down for the visit. I'll have the system send the location details to your WhatsApp right now. We're looking forward to seeing you!";
          // Call booking logic
          const date = new Date().toISOString().split('T')[0];
          await bookAppointment({ date, time: "Assigned via Aria", leadPhone: this.leadInfo.phone });
          this.sessionState = 'END';
        } else {
          response = "Great choice. Would a weekday morning or maybe a weekend afternoon work better for that visit?";
        }
        break;

      default:
        response = "I appreciate that. I'll have our specialist get back to you with more detailed information. Anything else I can help with?";
    }

    this.history.push({ role: 'Aria', text: response });
    this.emit('gptreply', { partialResponse: response }, interactionCount);
  }

  matches(input, keywords) {
    return keywords.some(k => input.includes(k));
  }

  randomBridge() {
    const bridges = [
      "I hear you! ",
      "That makes sense. ",
      "Great choice. ",
      "Interesting! ",
      "Got it. "
    ];
    return bridges[Math.floor(Math.random() * bridges.length)];
  }
}

module.exports = { GptService: ManualScriptService };
