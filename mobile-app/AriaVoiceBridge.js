import { Audio } from 'expo-av';
import { io } from 'socket.io-client';

class AriaVoiceBridge {
  constructor() {
    this.recording = null;
    this.socket = null;
    this.isTalking = false;
  }

  connect(backendUrl) {
    this.socket = io(backendUrl, { transports: ['websocket'] });
    this.socket.on('connect', () => console.log('Connected to Aria AI'));
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
      
      // Monitor volume/audio levels for activity detection if needed
      console.log('Aria is listening...');
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
