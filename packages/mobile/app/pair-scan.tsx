import React, { useState } from "react";
import {
  View,
  Text,
  TextInput,
  Pressable,
  StyleSheet,
  Alert,
} from "react-native";
import { useRouter } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";
import { useDaemonStore } from "../stores/daemon-store";
import { QRScanner } from "../components/QRScanner";
import { useThemeContext } from "../lib/theme";
import { LAYOUT } from "../lib/constants";

export default function PairScanScreen() {
  const router = useRouter();
  const { theme } = useThemeContext();
  const pairFromQR = useDaemonStore((s) => s.pairFromQR);
  const [manualInput, setManualInput] = useState("");
  const [scanned, setScanned] = useState(false);
  const [showManual, setShowManual] = useState(false);

  const handleBarCodeScanned = (data: string) => {
    if (scanned) return;
    setScanned(true);
    const result = pairFromQR(data);
    if (result.success && result.hostId) {
      router.replace(`/h/${result.hostId}` as any);
    } else {
      Alert.alert("Pairing Failed", result.error ?? "Invalid QR code");
      setScanned(false);
    }
  };

  const handleManualPair = () => {
    const trimmed = manualInput.trim();
    if (!trimmed) return;
    const result = pairFromQR(trimmed);
    if (result.success && result.hostId) {
      router.replace(`/h/${result.hostId}` as any);
    } else {
      Alert.alert("Pairing Failed", result.error ?? "Invalid pairing data");
    }
  };

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: theme.background }]}>
      <View style={styles.header}>
        <Text style={[styles.title, { color: theme.foreground }]}>
          Pair Daemon
        </Text>
        <Pressable onPress={() => router.back()}>
          <Text style={{ color: theme.primary, fontSize: 16 }}>Cancel</Text>
        </Pressable>
      </View>

      {!showManual ? (
        <View style={styles.scannerContainer}>
          <QRScanner onScan={handleBarCodeScanned} />
          <Pressable
            style={[styles.manualButton, { backgroundColor: theme.surface }]}
            onPress={() => setShowManual(true)}
          >
            <Text style={{ color: theme.primary }}>Enter manually</Text>
          </Pressable>
        </View>
      ) : (
        <View style={styles.manualContainer}>
          <Text style={[styles.label, { color: theme.foregroundMuted }]}>
            Paste the pairing URL from your daemon:
          </Text>
          <TextInput
            style={[
              styles.input,
              {
                backgroundColor: theme.surface,
                color: theme.foreground,
                borderColor: theme.border,
              },
            ]}
            value={manualInput}
            onChangeText={setManualInput}
            placeholder="agentctx://pair?data=..."
            placeholderTextColor={theme.foregroundMuted}
            autoCapitalize="none"
            autoCorrect={false}
            multiline
          />
          <Pressable
            style={[styles.pairButton, { backgroundColor: theme.primary }]}
            onPress={handleManualPair}
          >
            <Text style={{ color: theme.primaryForeground, fontWeight: "600" }}>
              Pair
            </Text>
          </Pressable>
          <Pressable
            style={[styles.manualButton, { backgroundColor: theme.surface }]}
            onPress={() => setShowManual(false)}
          >
            <Text style={{ color: theme.primary }}>Scan QR instead</Text>
          </Pressable>
        </View>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: LAYOUT.screenPaddingH,
    paddingVertical: LAYOUT.screenPaddingV,
  },
  title: {
    fontSize: 20,
    fontWeight: "bold",
  },
  scannerContainer: {
    flex: 1,
    padding: LAYOUT.screenPaddingH,
    gap: 16,
  },
  manualContainer: {
    flex: 1,
    padding: LAYOUT.screenPaddingH,
    gap: 16,
  },
  label: {
    fontSize: 14,
  },
  input: {
    borderWidth: 1,
    borderRadius: LAYOUT.inputRadius,
    padding: 12,
    fontSize: 14,
    minHeight: 80,
    textAlignVertical: "top",
  },
  pairButton: {
    paddingVertical: 14,
    borderRadius: LAYOUT.buttonRadius,
    alignItems: "center",
  },
  manualButton: {
    paddingVertical: 12,
    borderRadius: LAYOUT.buttonRadius,
    alignItems: "center",
  },
});
