"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export type ObdConnectionStatus =
  | "idle"
  | "requesting"
  | "connecting"
  | "connected"
  | "initializing"
  | "live"
  | "disconnected"
  | "unsupported"
  | "error";

type ObdMetrics = {
  speed: number | null;
  rpm: number | null;
  coolant: number | null;
  voltage: number | null;
};

type ObdCharacteristic = EventTarget & {
  value?: DataView;
  startNotifications: () => Promise<ObdCharacteristic>;
  stopNotifications?: () => Promise<ObdCharacteristic>;
  writeValue?: (value: BufferSource) => Promise<void>;
  writeValueWithoutResponse?: (value: BufferSource) => Promise<void>;
};

type ObdService = {
  getCharacteristic: (uuid: number) => Promise<ObdCharacteristic>;
};

type ObdGattServer = {
  getPrimaryService: (uuid: number) => Promise<ObdService>;
};

type ObdDevice = EventTarget & {
  id?: string;
  name?: string;
  gatt?: {
    connect: () => Promise<ObdGattServer>;
    disconnect: () => void;
  };
};

type BluetoothNavigator = Navigator & {
  bluetooth?: {
    requestDevice: (options: {
      acceptAllDevices?: boolean;
      filters?: Array<{ namePrefix?: string; services?: number[] }>;
      optionalServices: number[];
    }) => Promise<ObdDevice>;
    /**
     * 一度許可した機器の一覧。Chrome では実験機能なので、無い場合もある。
     * (chrome://flags の experimental-web-platform-features と
     *  web-bluetooth-new-permissions-backend を有効にすると使える)
     */
    getDevices?: () => Promise<ObdDevice[]>;
  };
};

type PendingCommand = {
  session: number;
  command: string;
  resolve: (response: string) => void;
  reject: (error: Error) => void;
  timer: number;
};

/**
 * Bluetoothの一覧に出てくるアダプタの名前。
 * 実機(CARISTA)の一覧表示が「Carista」だったので、これで絞り込む。
 */
const DEVICE_NAME_PREFIX = "Carista";

const SERVICE_UUID = 0xfff0;
const NOTIFY_UUID = 0xfff1;
const WRITE_UUID = 0xfff2;

/** 起動してから最初に自動接続を試すまでの待ち時間。 */
const AUTO_CONNECT_DELAY = 5_000;
/** 失敗したときに、次を試すまでの間隔。 */
const AUTO_CONNECT_RETRY_MS = 15_000;
/** 自動で試す回数の上限(これを超えたら手動で押してもらう)。 */
const AUTO_CONNECT_MAX_TRIES = 20;
/** 前に選んだ機器を覚えておく場所。 */
const OBD_DEVICE_ID_KEY = "zcar-obd-device-id";

const GATT_TIMEOUT = 10_000;
const WRITE_TIMEOUT = 4_000;
const COMMAND_TIMEOUT = 3_500;
const RESET_TIMEOUT = 8_000;
const ECU_SEARCH_TIMEOUT = 25_000;
const PID_COMMAND_GAP = 160;
const POLL_CYCLE_GAP = 220;

const EMPTY_METRICS: ObdMetrics = {
  speed: null,
  rpm: null,
  coolant: null,
  voltage: null,
};

const wait = (milliseconds: number) =>
  new Promise<void>((resolve) => window.setTimeout(resolve, milliseconds));

class ObdStageError extends Error {
  readonly label: string;

  constructor(code: string, label: string, detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = "ObdStageError";
    this.label = label;
  }
}

function withTimeout<T>(promise: Promise<T>, milliseconds: number, code: string) {
  let timer = 0;
  const timeout = new Promise<never>((_, reject) => {
    timer = window.setTimeout(() => reject(new Error(code)), milliseconds);
  });

  return Promise.race([promise, timeout]).finally(() => {
    window.clearTimeout(timer);
  });
}

function cleanResponse(response: string) {
  return response.replace(/\0/g, "").replace(/\s+/g, " ").trim();
}

function compactHex(response: string) {
  return response.toUpperCase().replace(/[^0-9A-F]/g, "");
}

function pidBytes(response: string, pid: string, count: number) {
  const compact = compactHex(response);
  const marker = `41${pid}`;
  const index = compact.lastIndexOf(marker);
  if (index < 0) return null;

  const payload = compact.slice(
    index + marker.length,
    index + marker.length + count * 2,
  );
  if (payload.length !== count * 2) return null;

  const bytes = Array.from({ length: count }, (_, byteIndex) =>
    Number.parseInt(payload.slice(byteIndex * 2, byteIndex * 2 + 2), 16),
  );
  return bytes.every(Number.isFinite) ? bytes : null;
}

function isElmFailure(response: string) {
  const upper = response.toUpperCase();
  return (
    upper.includes("UNABLE TO CONNECT") ||
    (upper.includes("BUS INIT") && upper.includes("ERROR")) ||
    upper.includes("BUS ERROR") ||
    upper.includes("CAN ERROR") ||
    upper.includes("STOPPED") ||
    upper.trim() === "?"
  );
}

function responseDetail(response: string) {
  return cleanResponse(response).slice(0, 100) || "EMPTY RESPONSE";
}

export function useObd2() {
  const [status, setStatus] = useState<ObdConnectionStatus>("idle");
  const [metrics, setMetrics] = useState<ObdMetrics>(EMPTY_METRICS);
  const [deviceName, setDeviceName] = useState("CARISTA OBD2");
  const [connectionLabel, setConnectionLabel] = useState("OBD2 STANDBY");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<number | null>(null);
  /**
   * 押さずにつなげる環境かどうか。
   * Chrome の getDevices() があるかで判断する(flagが要る実験機能)。
   * null は「まだ調べていない」。
   */
  const [autoSupported, setAutoSupported] = useState<boolean | null>(null);

  const sessionRef = useRef(0);
  const connectingRef = useRef(false);
  const deviceRef = useRef<ObdDevice | null>(null);
  const notifyRef = useRef<ObdCharacteristic | null>(null);
  const writeRef = useRef<ObdCharacteristic | null>(null);
  const disconnectHandlerRef = useRef<((event: Event) => void) | null>(null);
  const bufferRef = useRef("");
  const pendingRef = useRef<PendingCommand | null>(null);
  /** 一度つながった機器。clearTransport で消さずに覚えておく(自動再接続用)。 */
  const knownDeviceRef = useRef<ObdDevice | null>(null);
  const autoTimerRef = useRef<number | null>(null);
  const autoTriesRef = useRef(0);
  /** 画面を閉じたあとに自動接続が動かないようにする印。 */
  const autoStoppedRef = useRef(false);
  /** 絞り込みで見つからなかったときに、次の1回だけ全部出すための印。 */
  const showAllDevicesRef = useRef(false);
  /** 下で作る関数を、それより前の場所から呼ぶための入れ物。 */
  const autoConnectRef = useRef<(() => Promise<void>) | null>(null);
  const scheduleAutoConnectRef = useRef<((delay: number) => void) | null>(null);
  const statusRef = useRef<ObdConnectionStatus>("idle");

  const handleNotification = useCallback((event: Event) => {
    if (event.target !== notifyRef.current) return;

    const value = (event.target as ObdCharacteristic).value;
    if (!value) return;

    const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    bufferRef.current += new TextDecoder().decode(bytes).replace(/\0/g, "");

    let promptIndex = bufferRef.current.indexOf(">");
    while (promptIndex >= 0) {
      const frame = bufferRef.current.slice(0, promptIndex);
      bufferRef.current = bufferRef.current.slice(promptIndex + 1);

      const pending = pendingRef.current;
      if (pending && pending.session === sessionRef.current) {
        window.clearTimeout(pending.timer);
        pendingRef.current = null;
        pending.resolve(frame);
      }

      promptIndex = bufferRef.current.indexOf(">");
    }

    if (bufferRef.current.length > 8_192) {
      bufferRef.current = bufferRef.current.slice(-4_096);
    }
  }, []);

  const clearTransport = useCallback(
    (reason: string) => {
      sessionRef.current += 1;
      connectingRef.current = false;

      const pending = pendingRef.current;
      if (pending) {
        window.clearTimeout(pending.timer);
        pendingRef.current = null;
        pending.reject(new Error(reason));
      }

      const notify = notifyRef.current;
      if (notify) {
        notify.removeEventListener("characteristicvaluechanged", handleNotification);
        void notify.stopNotifications?.().catch(() => undefined);
      }

      const device = deviceRef.current;
      const disconnectHandler = disconnectHandlerRef.current;
      if (device && disconnectHandler) {
        device.removeEventListener("gattserverdisconnected", disconnectHandler);
      }

      try {
        device?.gatt?.disconnect();
      } catch {
        // The adapter may already be disconnected.
      }

      deviceRef.current = null;
      notifyRef.current = null;
      writeRef.current = null;
      disconnectHandlerRef.current = null;
      bufferRef.current = "";

      return sessionRef.current;
    },
    [handleNotification],
  );

  const setPhase = useCallback(
    (
      session: number,
      nextStatus: ObdConnectionStatus,
      label: string,
    ) => {
      if (session !== sessionRef.current) return false;
      setStatus(nextStatus);
      setConnectionLabel(label);
      return true;
    },
    [],
  );

  const sendCommand = useCallback(
    async (session: number, command: string, timeout = COMMAND_TIMEOUT) => {
      if (session !== sessionRef.current) {
        throw new Error("OBD_SESSION_ENDED");
      }
      if (pendingRef.current) {
        throw new Error("OBD_COMMAND_BUSY");
      }

      const characteristic = writeRef.current;
      if (!characteristic) {
        throw new Error("OBD_WRITE_UNAVAILABLE");
      }

      bufferRef.current = "";
      let resolveResponse!: (response: string) => void;
      let rejectResponse!: (error: Error) => void;
      const responsePromise = new Promise<string>((resolve, reject) => {
        resolveResponse = resolve;
        rejectResponse = reject;
      });
      void responsePromise.catch(() => undefined);

      const timer = window.setTimeout(() => {
        const pending = pendingRef.current;
        if (pending?.session === session && pending.command === command) {
          pendingRef.current = null;
          pending.reject(new Error(`OBD_TIMEOUT_${command}`));
        }
      }, timeout);

      pendingRef.current = {
        session,
        command,
        resolve: resolveResponse,
        reject: rejectResponse,
        timer,
      };

      const payload = new TextEncoder().encode(`${command}\r`);
      try {
        if (characteristic.writeValueWithoutResponse) {
          try {
            await withTimeout(
              characteristic.writeValueWithoutResponse(payload),
              WRITE_TIMEOUT,
              `OBD_WRITE_TIMEOUT_${command}`,
            );
          } catch (error) {
            if (
              error instanceof DOMException &&
              error.name === "NotSupportedError" &&
              characteristic.writeValue
            ) {
              await withTimeout(
                characteristic.writeValue(payload),
                WRITE_TIMEOUT,
                `OBD_WRITE_TIMEOUT_${command}`,
              );
            } else {
              throw error;
            }
          }
        } else if (characteristic.writeValue) {
          await withTimeout(
            characteristic.writeValue(payload),
            WRITE_TIMEOUT,
            `OBD_WRITE_TIMEOUT_${command}`,
          );
        } else {
          throw new Error("OBD_WRITE_UNAVAILABLE");
        }
      } catch (error) {
        const pending = pendingRef.current;
        if (pending?.session === session && pending.command === command) {
          window.clearTimeout(pending.timer);
          pendingRef.current = null;
          pending.reject(
            error instanceof Error ? error : new Error("OBD_WRITE_FAILED"),
          );
        }
        throw error;
      }

      return responsePromise;
    },
    [],
  );

  const initializeAdapter = useCallback(
    async (session: number) => {
      setPhase(session, "initializing", "CARISTA READY");

      const resetResponse = await sendCommand(session, "ATZ", RESET_TIMEOUT);
      if (isElmFailure(resetResponse)) {
        throw new ObdStageError(
          "CARISTA_RESET_FAILED",
          "CARISTA RESET FAILED - TAP OBD2",
          responseDetail(resetResponse),
        );
      }
      await wait(750);

      // Keep initialization minimal. The response parser already tolerates
      // linefeeds, spaces, and headers, so those optional ELM commands are not
      // allowed to block a valid CARISTA connection.
      const setupCommands = ["ATE0", "ATSP0"];
      for (const command of setupCommands) {
        if (session !== sessionRef.current) throw new Error("OBD_SESSION_ENDED");
        const response = await sendCommand(session, command);
        if (isElmFailure(response) || !response.toUpperCase().includes("OK")) {
          throw new ObdStageError(
            `CARISTA_SETUP_FAILED_${command}`,
            "CARISTA SETUP FAILED - TAP OBD2",
            responseDetail(response),
          );
        }
      }

      setPhase(session, "initializing", "SEARCHING TANTO ECU");
      // The original working flow did not reject a prompt-terminated NO DATA
      // response here. Some vehicles answer the live PIDs even when the broad
      // supported-PID query is inconclusive, so continue into direct polling.
      await sendCommand(session, "0100", ECU_SEARCH_TIMEOUT);
      setPhase(session, "connected", "READING TANTO DATA");
    },
    [sendCommand, setPhase],
  );

  const markVehicleData = useCallback(
    (session: number, patch: Partial<ObdMetrics>) => {
      if (session !== sessionRef.current) return;
      setMetrics((current) => ({ ...current, ...patch }));
      setStatus("live");
      setConnectionLabel("TANTO LIVE DATA");
      setErrorMessage(null);
      setLastUpdatedAt(Date.now());
    },
    [],
  );

  const pollVehicle = useCallback(
    async (session: number) => {
      let cycle = 0;
      let missedCoreCycles = 0;

      try {
        while (session === sessionRef.current) {
          const patch: Partial<ObdMetrics> = {};
          let receivedVehiclePid = false;

          const speedResponse = await sendCommand(session, "010D");
          const speed = pidBytes(speedResponse, "0D", 1);
          if (speed) {
            patch.speed = speed[0];
            receivedVehiclePid = true;
          } else if (isElmFailure(speedResponse)) {
            throw new Error(`ELM_STOPPED_010D:${responseDetail(speedResponse)}`);
          }

          await wait(PID_COMMAND_GAP);

          const rpmResponse = await sendCommand(session, "010C");
          const rpm = pidBytes(rpmResponse, "0C", 2);
          if (rpm) {
            patch.rpm = Math.round((rpm[0] * 256 + rpm[1]) / 4);
            receivedVehiclePid = true;
          } else if (isElmFailure(rpmResponse)) {
            throw new Error(`ELM_STOPPED_010C:${responseDetail(rpmResponse)}`);
          }

          cycle += 1;
          if (cycle === 1 || cycle % 6 === 0) {
            await wait(PID_COMMAND_GAP);
            const coolantResponse = await sendCommand(session, "0105");
            const coolant = pidBytes(coolantResponse, "05", 1);
            if (coolant) {
              patch.coolant = coolant[0] - 40;
              receivedVehiclePid = true;
            } else if (isElmFailure(coolantResponse)) {
              throw new Error(`ELM_STOPPED_0105:${responseDetail(coolantResponse)}`);
            }

            await wait(PID_COMMAND_GAP);
            const voltageResponse = await sendCommand(session, "ATRV");
            const voltage = voltageResponse.match(/(\d+(?:\.\d+)?)\s*V/i);
            if (voltage) patch.voltage = Number.parseFloat(voltage[1]);
            if (isElmFailure(voltageResponse)) {
              throw new Error(`ELM_STOPPED_ATRV:${responseDetail(voltageResponse)}`);
            }
          }

          if (receivedVehiclePid) {
            missedCoreCycles = 0;
            markVehicleData(session, patch);
          } else {
            missedCoreCycles += 1;
            if (Object.keys(patch).length > 0 && session === sessionRef.current) {
              setMetrics((current) => ({ ...current, ...patch }));
            }
            if (missedCoreCycles >= 3) {
              setPhase(session, "connected", "WAITING FOR TANTO DATA");
            }
          }

          await wait(POLL_CYCLE_GAP);
        }
      } catch (error) {
        if (session !== sessionRef.current) return;
        clearTransport("OBD_DATA_SESSION_ENDED");
        setStatus("error");
        setConnectionLabel("OBD2 RECONNECTING");
        scheduleAutoConnectRef.current?.(3_000);
        setErrorMessage(
          error instanceof Error ? error.message : "OBD_POLLING_FAILED",
        );
      }
    },
    [clearTransport, markVehicleData, sendCommand, setPhase],
  );

  /**
   * 機器が決まってからの接続処理。手動(機器を選んでもらう)と
   * 自動(覚えている機器につなぐ)で共通。
   */
  const openConnection = useCallback(
    async (
      session: number,
      selection: Promise<ObdDevice>,
      manual: boolean,
    ): Promise<boolean> => {
      setMetrics(EMPTY_METRICS);
      setLastUpdatedAt(null);
      setStatus("requesting");
      setConnectionLabel(manual ? "SELECT CARISTA" : "OBD2 AUTO CONNECT");
      setErrorMessage(null);

      try {
        const device = await selection;
        if (session !== sessionRef.current) return false;
        if (!device.gatt) {
          throw new ObdStageError(
            "BLUETOOTH_GATT_UNAVAILABLE",
            "CARISTA GATT UNAVAILABLE - TAP OBD2",
          );
        }

        deviceRef.current = device;
        setDeviceName(device.name || "CARISTA OBD2");
        setPhase(session, "connecting", "BLUETOOTH CONNECTING");

        const handleDisconnect = () => {
          if (session !== sessionRef.current) return;
          clearTransport("BLUETOOTH_DISCONNECTED");
          setStatus("disconnected");
          setConnectionLabel("OBD2 RECONNECTING");
          setErrorMessage("BLUETOOTH_DISCONNECTED");
          // 切れたら、覚えている機器につなぎ直しに行く。
          scheduleAutoConnectRef.current?.(1_500);
        };
        disconnectHandlerRef.current = handleDisconnect;
        device.addEventListener("gattserverdisconnected", handleDisconnect);

        const server = await withTimeout(
          device.gatt.connect(),
          GATT_TIMEOUT,
          "BLUETOOTH_CONNECT_TIMEOUT",
        );
        if (session !== sessionRef.current) return false;

        setPhase(session, "connecting", "CARISTA SERVICE");
        const service = await withTimeout(
          server.getPrimaryService(SERVICE_UUID),
          GATT_TIMEOUT,
          "CARISTA_SERVICE_TIMEOUT",
        );
        if (session !== sessionRef.current) return false;

        setPhase(session, "connecting", "CARISTA NOTIFY");
        const notify = await withTimeout(
          service.getCharacteristic(NOTIFY_UUID),
          GATT_TIMEOUT,
          "CARISTA_NOTIFY_CHARACTERISTIC_TIMEOUT",
        );
        const write = await withTimeout(
          service.getCharacteristic(WRITE_UUID),
          GATT_TIMEOUT,
          "CARISTA_WRITE_CHARACTERISTIC_TIMEOUT",
        );
        if (session !== sessionRef.current) return false;

        notifyRef.current = notify;
        writeRef.current = write;
        notify.addEventListener("characteristicvaluechanged", handleNotification);
        await withTimeout(
          notify.startNotifications(),
          GATT_TIMEOUT,
          "CARISTA_NOTIFY_START_TIMEOUT",
        );
        if (session !== sessionRef.current) return false;

        await wait(300);
        if (session !== sessionRef.current) return false;

        setPhase(session, "connected", "CARISTA READY");
        await initializeAdapter(session);
        if (session !== sessionRef.current) return false;

        connectingRef.current = false;
        knownDeviceRef.current = device;
        autoTriesRef.current = 0;
        try {
          if (device.id) localStorage.setItem(OBD_DEVICE_ID_KEY, device.id);
        } catch {
          // 保存できなくても、この画面を開いている間は覚えている。
        }
        void pollVehicle(session);
        return true;
      } catch (error) {
        if (error instanceof DOMException && error.name === "NotFoundError") {
          if (session === sessionRef.current) {
            clearTransport("BLUETOOTH_SELECTION_CANCELLED");
            setStatus("idle");
            setConnectionLabel("OBD2 STANDBY");
            setErrorMessage(null);
          }
          return false;
        }
        if (session !== sessionRef.current) return false;

        // 自動接続の失敗は、まだ車に近づいていないだけのことが多いので
        // 赤い失敗表示にせず、静かに次を待つ。
        if (!manual) {
          clearTransport("OBD_AUTO_CONNECT_FAILED");
          setStatus("idle");
          setConnectionLabel("OBD2 AUTO RETRY");
          setErrorMessage(null);
          return false;
        }

        const label =
          error instanceof ObdStageError
            ? error.label
            : error instanceof Error && error.message.includes("SERVICE")
              ? "CARISTA SERVICE FAILED - TAP OBD2"
              : error instanceof Error && error.message.includes("NOTIFY")
                ? "CARISTA NOTIFY FAILED - TAP OBD2"
                : error instanceof Error && error.message.includes("WRITE")
                  ? "CARISTA WRITE FAILED - TAP OBD2"
                  : error instanceof Error && error.message.includes("ATZ")
                    ? "CARISTA RESET TIMEOUT - TAP OBD2"
                    : error instanceof Error && error.message.includes("0100")
                      ? "TANTO ECU TIMEOUT - TAP OBD2"
                      : "CARISTA CONNECTION FAILED - TAP OBD2";

        clearTransport("OBD_CONNECTION_ABORTED");
        setStatus("error");
        setConnectionLabel(label);
        setErrorMessage(
          error instanceof Error ? error.message : "OBD_CONNECTION_FAILED",
        );
        return false;
      } finally {
        connectingRef.current = false;
      }
    }, [
    clearTransport,
    handleNotification,
    initializeAdapter,
    pollVehicle,
    setPhase,
  ]);

  /** 手動でつなぐ(四隅の CONNECT から呼ばれる)。機器を選ぶ画面が出る。 */
  const connect = useCallback(async () => {
    const bluetooth = (navigator as BluetoothNavigator).bluetooth;
    if (!bluetooth) {
      setStatus("unsupported");
      setConnectionLabel("CHROME BLUETOOTH UNAVAILABLE");
      setErrorMessage("WEB_BLUETOOTH_UNSUPPORTED");
      return;
    }

    if (connectingRef.current) return;

    // 手動で押したときは、自動接続の待ち回数をやり直す。
    autoTriesRef.current = 0;
    if (autoTimerRef.current !== null) {
      window.clearTimeout(autoTimerRef.current);
      autoTimerRef.current = null;
    }

    const session = clearTransport("OBD_RECONNECTING");
    connectingRef.current = true;

    let selection: Promise<ObdDevice>;
    try {
      // ふだんは Carista だけを出す(周りの機器が並ぶと押し間違える)。
      // 見つからなかった次の1回だけは、全部出して選べるようにする。
      selection = showAllDevicesRef.current
        ? bluetooth.requestDevice({
            acceptAllDevices: true,
            optionalServices: [SERVICE_UUID],
          })
        : bluetooth.requestDevice({
            filters: [
              { namePrefix: DEVICE_NAME_PREFIX },
              { services: [SERVICE_UUID] },
            ],
            optionalServices: [SERVICE_UUID],
          });
    } catch (error) {
      connectingRef.current = false;
      setStatus("error");
      setConnectionLabel("BLUETOOTH REQUEST FAILED - TAP OBD2");
      setErrorMessage(
        error instanceof Error ? error.message : "BLUETOOTH_REQUEST_FAILED",
      );
      return;
    }

    const connected = await openConnection(session, selection, true);
    // 絞り込みで選べなかったときは、次の1回だけ全部出す。
    showAllDevicesRef.current = connected ? false : !showAllDevicesRef.current;
  }, [clearTransport, openConnection]);

  /**
   * 覚えている機器を探す。
   * 1) この画面で一度つないだ機器
   * 2) Chrome が覚えている許可済みの機器(getDevices。実験機能なので無い場合もある)
   */
  const findKnownDevice = useCallback(async (): Promise<ObdDevice | null> => {
    if (knownDeviceRef.current) return knownDeviceRef.current;

    const bluetooth = (navigator as BluetoothNavigator).bluetooth;
    if (!bluetooth?.getDevices) return null;

    try {
      const devices = await bluetooth.getDevices();
      if (devices.length === 0) return null;

      let savedId = "";
      try {
        savedId = localStorage.getItem(OBD_DEVICE_ID_KEY) || "";
      } catch {
        // 読めなくても、下の「1台だけなら」で拾える。
      }

      const matched = savedId
        ? devices.find((device) => device.id === savedId)
        : undefined;
      if (matched) return matched;

      // 名前が Carista のものがあれば、それを選ぶ。
      const named = devices.filter((device) =>
        (device.name || "")
          .toLowerCase()
          .startsWith(DEVICE_NAME_PREFIX.toLowerCase()),
      );
      if (named.length === 1) return named[0];

      // 許可した機器が1台だけなら、それで間違いない。
      return devices.length === 1 ? devices[0] : null;
    } catch {
      return null;
    }
  }, []);

  /** 覚えている機器へ、押さずにつなぎに行く。 */
  const autoConnect = useCallback(async () => {
    if (autoStoppedRef.current) return;
    if (connectingRef.current) return;

    const now = statusRef.current;
    if (now === "live" || now === "connected" || now === "initializing") return;
    if (!(navigator as BluetoothNavigator).bluetooth) return;

    const device = await findKnownDevice();
    // 覚えている機器が無いときは、最初の1回だけ手で選んでもらう必要がある。
    if (!device || !device.gatt) return;
    if (autoStoppedRef.current || connectingRef.current) return;

    autoTriesRef.current += 1;
    const session = clearTransport("OBD_AUTO_RECONNECTING");
    connectingRef.current = true;

    const connected = await openConnection(session, Promise.resolve(device), false);
    if (
      !connected &&
      !autoStoppedRef.current &&
      autoTriesRef.current < AUTO_CONNECT_MAX_TRIES
    ) {
      scheduleAutoConnectRef.current?.(AUTO_CONNECT_RETRY_MS);
    }
  }, [clearTransport, findKnownDevice, openConnection]);

  const scheduleAutoConnect = useCallback((delay: number) => {
    if (autoStoppedRef.current) return;
    if (autoTimerRef.current !== null) {
      window.clearTimeout(autoTimerRef.current);
    }
    autoTimerRef.current = window.setTimeout(() => {
      autoTimerRef.current = null;
      void autoConnectRef.current?.();
    }, delay);
  }, []);

  useEffect(() => {
    autoConnectRef.current = autoConnect;
    scheduleAutoConnectRef.current = scheduleAutoConnect;
  }, [autoConnect, scheduleAutoConnect]);

  useEffect(() => {
    statusRef.current = status;
  }, [status]);

  useEffect(() => {
    const bluetooth = (navigator as BluetoothNavigator).bluetooth;
    setAutoSupported(typeof bluetooth?.getDevices === "function");
  }, []);

  // 起動して少ししたら、覚えている機器に自動でつなぎに行く。
  // つながらなければ少し待ってまた試す(上限あり)。
  useEffect(() => {
    autoStoppedRef.current = false;
    scheduleAutoConnect(AUTO_CONNECT_DELAY);
    return () => {
      autoStoppedRef.current = true;
      if (autoTimerRef.current !== null) {
        window.clearTimeout(autoTimerRef.current);
        autoTimerRef.current = null;
      }
    };
  }, [scheduleAutoConnect]);

  const disconnect = useCallback(() => {
    clearTransport("OBD_DISCONNECTED");
    setStatus("disconnected");
    setConnectionLabel("OBD2 DISCONNECTED");
    setErrorMessage(null);
  }, [clearTransport]);

  useEffect(
    () => () => {
      autoStoppedRef.current = true;
      clearTransport("OBD_UNMOUNTED");
    },
    [clearTransport],
  );

  return {
    status,
    autoSupported,
    metrics,
    deviceName,
    connectionLabel,
    errorMessage,
    lastUpdatedAt,
    connect,
    disconnect,
  };
}
