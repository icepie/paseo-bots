import { useMemo } from "react";
import { View } from "react-native";
import { qrcodegen } from "./qrcodegen";

/**
 * Renders text as a QR code. Always black on white: phone cameras need the
 * contrast regardless of the app's theme, so this ignores `colors` on purpose.
 */
export function QrCode({ text, size }: { text: string; size: number }) {
  const qr = useMemo(() => qrcodegen.QrCode.encodeText(text, qrcodegen.QrCode.Ecc.MEDIUM), [text]);
  const cell = Math.max(1, Math.floor(size / qr.size));
  const grid = cell * qr.size;
  const rows = [];
  for (let y = 0; y < qr.size; y++) {
    const cells = [];
    for (let x = 0; x < qr.size; x++) {
      cells.push(<View key={x} style={{ width: cell, height: cell, backgroundColor: qr.getModule(x, y) ? "#000000" : "#ffffff" }} />);
    }
    rows.push(
      <View key={y} style={{ flexDirection: "row" }}>
        {cells}
      </View>,
    );
  }
  return (
    <View style={{ width: grid, height: grid, backgroundColor: "#ffffff" }} accessibilityLabel={`QR code for ${text}`}>
      {rows}
    </View>
  );
}
