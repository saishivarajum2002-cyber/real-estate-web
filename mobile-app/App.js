import React, { useState, useEffect } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, SafeAreaView, StatusBar } from 'react-native';
import AriaVoiceBridge from './AriaVoiceBridge';

const BACKEND_URL = 'https://YOUR-VERCEL-DOMAIN.vercel.app'; // <--- REPLACE THIS WITH YOUR REAL VERCEL URL!

export default function App() {
  const [isAgentActive, setIsAgentActive] = useState(false);
  const [status, setStatus] = useState('Idle');
  const [hasUpdate, setHasUpdate] = useState(false);

  useEffect(() => {
    // Check for "Over-the-Air" Updates from Vercel
    const checkUpdates = async () => {
      try {
        const res = await fetch(`${BACKEND_URL}/api/mobile/version`);
        const data = await res.json();
        if (data.version > 1.0) { // Current version
          setHasUpdate(true);
        }
      } catch (e) {
        console.log('Update check failed');
      }
    };
    checkUpdates();
  }, []);

  const toggleAgent = () => {
    if (isAgentActive) {
       AriaVoiceBridge.stop();
       setStatus('Idle');
    } else {
       AriaVoiceBridge.connect(BACKEND_URL);
       AriaVoiceBridge.startListening();
       setStatus('Aria is Live & Handling Calls');
    }
    setIsAgentActive(!isAgentActive);
  };

  return (
    <SafeAreaView style={styles.container}>
      <StatusBar barStyle="light-content" />
      <View style={styles.header}>
        <Text style={styles.logo}>PropEdge Agent</Text>
      </View>

      {hasUpdate && (
        <View style={styles.updateBanner}>
          <Text style={styles.updateText}>✨ New AI Personality Update Available!</Text>
        </View>
      )}

      <View style={styles.brainContainer}>
        <View style={[styles.pulse, isAgentActive && styles.pulseActive]} />
        <Text style={styles.brainIcon}>{isAgentActive ? '🧠' : '💤'}</Text>
      </View>

      <View style={styles.statusBox}>
        <Text style={styles.statusText}>{status}</Text>
      </View>

      <TouchableOpacity 
        style={[styles.powerBtn, isAgentActive ? styles.powerBtnOff : styles.powerBtnOn]} 
        onPress={toggleAgent}
      >
        <Text style={styles.powerBtnText}>
          {isAgentActive ? 'Turn Off AI Agent' : 'Activate AI Agent'}
        </Text>
      </TouchableOpacity>

      <Text style={styles.footer}>Connected to SIM: +91 XXX-XXX-XXXX</Text>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#05070a', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 50 },
  header: { marginTop: 20 },
  logo: { color: '#f0c040', fontSize: 24, fontWeight: '900', letterSpacing: 1 },
  brainContainer: { width: 200, height: 200, alignItems: 'center', justifyContent: 'center' },
  brainIcon: { fontSize: 80 },
  pulse: { position: 'absolute', width: 140, height: 140, borderRadius: 70, backgroundColor: 'rgba(240, 192, 64, 0.1)', borderWidth: 1, borderColor: 'rgba(240, 192, 64, 0.3)' },
  pulseActive: { backgroundColor: 'rgba(240, 192, 64, 0.2)', transform: [{ scale: 1.2 }] },
  statusBox: { padding: 20, borderRadius: 12, backgroundColor: 'rgba(255,255,255,0.05)', width: '80%', alignItems: 'center' },
  statusText: { color: '#fff', fontSize: 16, fontWeight: '600' },
  powerBtn: { width: '80%', padding: 20, borderRadius: 16, alignItems: 'center' },
  powerBtnOn: { backgroundColor: '#f0c040' },
  powerBtnOff: { backgroundColor: '#e05060' },
  powerBtnText: { fontWeight: '900', fontSize: 16, color: '#000' },
  updateBanner: { backgroundColor: 'rgba(240, 192, 64, 0.2)', padding: 10, borderRadius: 10, marginBottom: 20, borderWeight: 1, borderColor: '#f0c040' },
  updateText: { color: '#f0c040', fontSize: 12, fontWeight: '800' },
  footer: { color: 'rgba(255,255,255,0.3)', fontSize: 12 }
});
