import React, { useCallback, useMemo, useState } from "react";
import { KeyboardAvoidingView, Platform, SafeAreaView, StyleSheet, View } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";

import { StarknetConnectorProvider, useStarknetConnector } from "./context/StarknetConnector";
import MainPage from "./pages/main";
import PaymentsPage from "./pages/payments";
import { BottomNavBar, MainTabKey } from "./components/BottomNavBar";

const Root: React.FC = () => {
  const { account } = useStarknetConnector();
  const [activeTab, setActiveTab] = useState<MainTabKey>("home");
  const [mainMode, setMainMode] = useState<"home" | "invoice" | "pay">("home");

  const handleTabChange = useCallback((tab: MainTabKey) => {
    setActiveTab(tab);
    if (tab === "home" || tab === "invoice" || tab === "pay") {
      setMainMode(tab);
    }
  }, []);

  const handleMainModeChange = useCallback((mode: "home" | "invoice" | "pay") => {
    setMainMode(mode);
    setActiveTab(mode);
  }, []);

  const mainPage = useMemo(
    () => (
      <MainPage key="main" activeMode={mainMode} onModeChange={handleMainModeChange} />
    ),
    [handleMainModeChange, mainMode],
  );

  const paymentsPage = useMemo(
    () => <PaymentsPage key="payments" isActive={activeTab === "payments"} />,
    [activeTab],
  );

  return (
    <GestureHandlerRootView style={styles.gestureRoot}>
      <SafeAreaView style={styles.safeArea}>
        <KeyboardAvoidingView
          style={styles.keyboard}
          behavior={Platform.OS === "ios" ? "padding" : undefined}
        >
          <View style={styles.container}>
            <View style={styles.content}>
              <View
                style={[styles.scene, activeTab === "payments" && styles.sceneHidden]}
              >
                {mainPage}
              </View>
              <View
                style={[styles.scene, activeTab !== "payments" && styles.sceneHidden]}
              >
                {paymentsPage}
              </View>
            </View>
            {account ? (
              <BottomNavBar active={activeTab} onChange={handleTabChange} />
            ) : null}
          </View>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </GestureHandlerRootView>
  );
};

export default function Index() {
  return (
    <StarknetConnectorProvider>
      <Root />
    </StarknetConnectorProvider>
  );
}

const styles = StyleSheet.create({
  gestureRoot: {
    flex: 1,
    backgroundColor: "#f1f5f9",
  },
  safeArea: {
    flex: 1,
    backgroundColor: "#f1f5f9",
  },
  keyboard: {
    flex: 1,
  },
  container: {
    flex: 1,
    backgroundColor: "#f1f5f9",
  },
  content: {
    flex: 1,
  },
  scene: {
    flex: 1,
  },
  sceneHidden: {
    display: "none",
  },
});
