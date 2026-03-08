import React from "react";
import { View, Text, Pressable, StyleSheet } from "react-native";
import { useThemeContext } from "../lib/theme";
import { LAYOUT } from "../lib/constants";

interface QRScannerProps {
  onScan: (data: string) => void;
}

/**
 * QR scanner component.
 *
 * In the real app, this uses expo-camera's CameraView with barcode scanning.
 * For the shell, we render a placeholder with instructions. The actual
 * camera integration requires native build and device access.
 */
export function QRScanner({ onScan }: QRScannerProps) {
  const { theme } = useThemeContext();

  return (
    <View style={[styles.container, { backgroundColor: theme.surfaceElevated, borderColor: theme.border }]}>
      <View style={styles.viewfinder}>
        <View style={[styles.corner, styles.topLeft, { borderColor: theme.primary }]} />
        <View style={[styles.corner, styles.topRight, { borderColor: theme.primary }]} />
        <View style={[styles.corner, styles.bottomLeft, { borderColor: theme.primary }]} />
        <View style={[styles.corner, styles.bottomRight, { borderColor: theme.primary }]} />
      </View>
      <Text style={[styles.instructions, { color: theme.foregroundMuted }]}>
        Point your camera at the daemon's QR code
      </Text>
    </View>
  );
}

const CORNER_SIZE = 24;
const CORNER_WIDTH = 3;

const styles = StyleSheet.create({
  container: {
    flex: 1,
    borderRadius: LAYOUT.cardRadius,
    borderWidth: 1,
    justifyContent: "center",
    alignItems: "center",
    minHeight: 300,
  },
  viewfinder: {
    width: 200,
    height: 200,
    position: "relative",
    marginBottom: 16,
  },
  corner: {
    position: "absolute",
    width: CORNER_SIZE,
    height: CORNER_SIZE,
  },
  topLeft: {
    top: 0,
    left: 0,
    borderTopWidth: CORNER_WIDTH,
    borderLeftWidth: CORNER_WIDTH,
  },
  topRight: {
    top: 0,
    right: 0,
    borderTopWidth: CORNER_WIDTH,
    borderRightWidth: CORNER_WIDTH,
  },
  bottomLeft: {
    bottom: 0,
    left: 0,
    borderBottomWidth: CORNER_WIDTH,
    borderLeftWidth: CORNER_WIDTH,
  },
  bottomRight: {
    bottom: 0,
    right: 0,
    borderBottomWidth: CORNER_WIDTH,
    borderRightWidth: CORNER_WIDTH,
  },
  instructions: {
    fontSize: 14,
    textAlign: "center",
  },
});
