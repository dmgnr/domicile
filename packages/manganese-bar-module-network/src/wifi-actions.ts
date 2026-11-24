import {
  connectWifi,
  disconnectWifi,
  forgetWifi,
  scanWifi,
  setWifiAutoJoin,
  setWifiEnabled,
} from "@domicile-desktop/system-network/wifi";

/** The Wi-Fi service's requests, injectable so tests can see what a panel asks for. */
export const WIFI_ACTIONS = {
  connectWifi,
  disconnectWifi,
  forgetWifi,
  scanWifi,
  setWifiAutoJoin,
  setWifiEnabled,
};

export type WifiActions = typeof WIFI_ACTIONS;
