import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";

export type MainTabKey = "home" | "invoice" | "pay" | "payments";

type BottomNavBarProps = {
  active: MainTabKey;
  onChange: (key: MainTabKey) => void;
};

const TABS: Array<{
  key: MainTabKey;
  label: string;
  icon: keyof typeof Ionicons.glyphMap;
  iconActive: keyof typeof Ionicons.glyphMap;
}> = [
  { key: "home", label: "Home", icon: "home-outline", iconActive: "home" },
  {
    key: "invoice",
    label: "Get paid",
    icon: "cash-outline",
    iconActive: "cash",
  },
  {
    key: "pay",
    label: "Pay",
    icon: "paper-plane-outline",
    iconActive: "paper-plane",
  },
  {
    key: "payments",
    label: "Payments",
    icon: "card-outline",
    iconActive: "card",
  },
];

export const BottomNavBar: React.FC<BottomNavBarProps> = ({ active, onChange }) => {
  return (
    <View style={styles.navbar}>
      {TABS.map((tab) => {
        const isActive = active === tab.key;
        return (
          <Pressable
            key={tab.key}
            style={[styles.item, isActive && styles.itemActive]}
            onPress={() => onChange(tab.key)}
          >
            <Ionicons
              name={isActive ? tab.iconActive : tab.icon}
              size={22}
              color={isActive ? "#2563eb" : "#94a3b8"}
            />
            <Text style={[styles.label, isActive && styles.labelActive]}>
              {tab.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
};

const styles = StyleSheet.create({
  navbar: {
    flexDirection: "row",
    justifyContent: "space-around",
    alignItems: "center",
    borderTopWidth: 1,
    borderTopColor: "#e2e8f0",
    backgroundColor: "#ffffff",
    paddingVertical: 12,
    paddingHorizontal: 24,
  },
  item: {
    flex: 1,
    alignItems: "center",
    gap: 4,
  },
  itemActive: {},
  label: {
    fontSize: 13,
    color: "#94a3b8",
    fontWeight: "500",
  },
  labelActive: {
    color: "#2563eb",
  },
});
