import { Audio } from 'expo-av';
import { io } from 'socket.io-client';
import { Alert } from 'react-native';

class AriaVoiceBridge {
  constructor() {
    this.recording = null;
    this.socket = null;
    this.isTalking = false;
  }

  connect(backendUrl) {
    this.socket = io(backendUrl, { transports: ['websocket'] });
    
    this.socket.on('connect', () => console.log('📱 Connected to Aria AI Engine'));

    // ── ⚡ NEW: HANDLE AUTOMATIC WAKE-UP
    this.socket.on('incoming-lead', async (data) => {
      console.log('⚡ Incoming Lead Signal Received:', data.lead.name);
      
      // Notify the user & start the stream immediately
      Alert.alert('NEW LEAD ARRIVED', `${data.lead.name} is looking at ${data.lead.property_interest || 'a property'}. Aria is starting the conversation now.`);
      
      // Send 'start' event back to server to trigger opening line
      this.socket.emit('start', { lead: data.lead });
      this.startListening();
    });

    this.socket.on('ai-audio-chunk', (base64Audio) => this.playAiVoice(base64Audio));
  }

  async startListening() {
    try {
      await Audio.requestPermissionsAsync();
      await Audio.setAudioModeAsync({ allowsRecordingIOS: true, playsInSilentModeIOS: true });

      const { recording } = await Audio.Recording.createAsync(
        Audio.RecordingOptionsPresets.HIGH_QUALITY
      );
      this.recording = recording;
      
      this.recording.setOnRecordingStatusUpdate((status) => {
        // Here you would implement logic to send raw base64 mic data to the server
        if (status.isRecording) {
           // this.socket.emit('media', { payload: status.metering });
        }
      });

      console.log('🎙️ Aria is listening through your phone mic...');
    } catch (err) {
      console.error('Failed to start recording', err);
    }
  }

  async playAiVoice(base64Audio) {
    this.isTalking = true;
    const { sound } = await Audio.Sound.createAsync(
       { uri: `data:audio/mp3;base64,${base64Audio}` }
    );
    await sound.playAsync();
  }

  async stop() {
    if (this.recording) {
      await this.recording.stopAndUnloadAsync();
      this.recording = null;
    }
    if (this.socket) this.socket.disconnect();
  }
}

export default new AriaVoiceBridge();
