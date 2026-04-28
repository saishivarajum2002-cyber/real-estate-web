import * as Speech from 'expo-speech';
import Voice from '@react-native-voice/voice';
import { Alert } from 'react-native';

class AriaVoiceBridge {
  constructor() {
    this.isListening = false;
    this.sessionState = 'INITIAL';
    this.leadInfo = {};
    
    // Configure Voice recognition
    Voice.onSpeechResults = this.onSpeechResults.bind(this);
    Voice.onSpeechError = (e) => console.log('Speech Error:', e);
  }

  async connect(backendUrl) {
    // In this $0 mode, we don't need a persistent WebSocket to a laptop!
    // We just talk to the Vercel API when we have a transcript.
    this.backendUrl = backendUrl;
    console.log('📱 $0-Cost Native Aria Bridge Active');
  }

  async handleIncomingLead(lead) {
    this.leadInfo = lead;
    this.sessionState = 'INITIAL';
    
    const openingLine = `Hi ${lead.name || 'there'}! I noticed you were looking at a property on our site. Is now a good time for a quick chat?`;
    
    Alert.alert('NEW LEAD ARRIVED', `Aria is speaking to ${lead.name || 'a buyer'} now.`);
    this.speak(openingLine);
  }

  async speak(text) {
    console.log('Aria Speaking:', text);
    Speech.speak(text, {
      language: 'en',
      pitch: 1.1,
      rate: 0.9,
      onDone: () => this.startListening()
    });
  }

  async startListening() {
    if (this.isListening) return;
    try {
      this.isListening = true;
      await Voice.start('en-US');
      console.log('🎙️ Listening to user...');
    } catch (e) {
      console.error(e);
    }
  }

  async onSpeechResults(e) {
    const speech = e.value[0];
    if (!speech) return;
    
    this.isListening = false;
    await Voice.stop();
    console.log('User said:', speech);

    // Send transcript to Vercel to get the next step in the script
    this.processAILogic(speech);
  }

  async processAILogic(userInput) {
    try {
      // We call the Vercel backend which now hosts the "Manual Script"
      const response = await fetch(`${this.backendUrl}/api/ai/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
           input: userInput,
           state: this.sessionState,
           lead: this.leadInfo
        })
      });
      
      const data = await response.json();
      this.sessionState = data.nextState;
      this.leadInfo = data.lead;
      
      if (data.reply) {
        this.speak(data.reply);
      }
    } catch (err) {
      console.error('Logic Error:', err);
    }
  }

  async stop() {
    Speech.stop();
    Voice.destroy().then(Voice.removeAllListeners);
  }
}

export default new AriaVoiceBridge();
