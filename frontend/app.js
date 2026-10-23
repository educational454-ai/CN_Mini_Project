const SERVER_URL = "wss://shareyou-backend.onrender.com/ws";
const VALID_CODE = /^[A-HJ-NP-Z2-9]{6}$/;
const PEER_CONFIGURATION = {
  iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
};
const FILE_PROTOCOL = "shareyou-file-v1";
const CHAT_PROTOCOL = "shareyou-chat-v1";
// Keep each complete frame below common 64 KiB DataChannel message limits.
const FILE_CHUNK_SIZE = 60 * 1024;
const FILE_HEADER_SIZE = 40;
const MAX_BUFFERED_BYTES = 1024 * 1024;
const BUFFERED_LOW_THRESHOLD = 256 * 1024;
const MAX_FILE_SIZE = 512 * 1024 * 1024;
const TRANSFER_ID_PATTERN = /^[0-9a-f]{32}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const FILE_MAGIC = new Uint8Array([0x53, 0x59, 0x46, 0x31]);

const themeToggle = document.querySelector("#theme-toggle");
const themeColor = document.querySelector('meta[name="theme-color"]');
const connectionIndicator = document.querySelector("#connection-indicator");
const connectionLabel = document.querySelector("#connection-label");
const shareCodeDisplay = document.querySelector("#share-code");
const copyButton = document.querySelector("#copy-code");
const copyLabel = document.querySelector("#copy-label");
const localStatus = document.querySelector("#local-status");
const joinForm = document.querySelector("#join-form");
const peerCodeInput = document.querySelector("#peer-code");
const joinButton = document.querySelector("#join-button");
const pairStatus = document.querySelector("#pair-status");
const messageForm = document.querySelector("#message-form");
const testMessageInput = document.querySelector("#test-message");
const sendMessageButton = document.querySelector("#send-message");
const messageList = document.querySelector("#message-list");
const dataChannelStatus = document.querySelector("#data-channel-status");
const fileInput = document.querySelector("#file-input");
const dropArea = document.querySelector("#drop-area");
const sendFileButton = document.querySelector("#send-file");
const selectedFilePanel = document.querySelector("#selected-file");
const selectedFileName = document.querySelector("#selected-file-name");
const selectedFileDetails = document.querySelector("#selected-file-details");
const clearFileButton = document.querySelector("#clear-file");
const outgoingPanel = document.querySelector("#outgoing-transfer");
const outgoingName = document.querySelector("#outgoing-name");
const outgoingDetails = document.querySelector("#outgoing-details");
const outgoingStatus = document.querySelector("#outgoing-status");
const outgoingProgress = document.querySelector("#outgoing-progress");
const outgoingProgressText = document.querySelector("#outgoing-progress-text");
const cancelOutgoingButton = document.querySelector("#cancel-outgoing");
const incomingPanel = document.querySelector("#incoming-transfer");
const incomingName = document.querySelector("#incoming-name");
const incomingDetails = document.querySelector("#incoming-details");
const incomingStatus = document.querySelector("#incoming-status");
const incomingActions = document.querySelector("#incoming-actions");
const acceptIncomingButton = document.querySelector("#accept-incoming");
const rejectIncomingButton = document.querySelector("#reject-incoming");
const incomingProgressWrap = document.querySelector("#incoming-progress-wrap");
const incomingProgress = document.querySelector("#incoming-progress");
const incomingProgressText = document.querySelector("#incoming-progress-text");
const cancelIncomingButton = document.querySelector("#cancel-incoming");
const saveIncomingButton = document.querySelector("#save-incoming");
const toast = document.querySelector("#toast");

let socket;
let shareCode = "";
let peerCode = "";
let pendingJoinCode = "";
let peerConnection;
let dataChannel;
let offerStarted = false;
let pendingIceCandidates = [];
let toastTimeout;
let reconnectTimeout;
let peerCloseTimeout;
let isPageClosing = false;
let selectedFile = null;
let outgoingTransfer = null;
let outgoingSummary = null;
let incomingTransfer = null;
let progressUpdateAt = 0;

function setServerStatus(status, label) {
  connectionLabel.textContent = label;
  connectionIndicator.classList.toggle("is-connected", status === "connected");
  connectionIndicator.classList.toggle("is-error", status === "error");
  connectionIndicator.dataset.state = status;
  localStatus.textContent = label;
  localStatus.classList.toggle("is-connected", status === "connected");
  localStatus.dataset.state = status;
}

function setPairStatus(label, isConnected = false) {
  pairStatus.textContent = label;
  pairStatus.classList.toggle("is-paired", isConnected);
  const normalizedLabel = label.toLowerCase();
  pairStatus.dataset.state = normalizedLabel.includes("failed") ||
      normalizedLabel.includes("unavailable") ||
      normalizedLabel.includes("disconnected") ||
      normalizedLabel.includes("connection closed") ||
      normalizedLabel.includes("interrupted")
    ? "error"
    : normalizedLabel.includes("connected") || normalizedLabel.includes("paired")
      ? "connected"
      : normalizedLabel.includes("connecting") || normalizedLabel.includes("requesting")
        ? "connecting"
        : "idle";
}

function applyTheme(theme, persist = false) {
  const selectedTheme = theme === "dark" ? "dark" : "light";
  document.documentElement.dataset.theme = selectedTheme;
  themeToggle.setAttribute("aria-pressed", String(selectedTheme === "dark"));
  themeToggle.setAttribute(
    "aria-label",
    `Switch to ${selectedTheme === "dark" ? "light" : "dark"} theme`,
  );
  if (themeColor) {
    themeColor.content = selectedTheme === "dark" ? "#101a1b" : "#f4f7f3";
  }
  if (persist) {
    try {
      localStorage.setItem("shareyou-theme", selectedTheme);
    } catch {
      showMessage("Theme changed, but this browser could not save your preference.");
    }
  }
}

function transferState(status) {
  if (status.startsWith("completed")) return "completed";
  if (status.includes("failed")) return "failed";
  if (status.includes("cancelled")) return "cancelled";
  if (status.includes("rejected")) return "rejected";
  if (status.includes("sending") || status.includes("receiving")) return "active";
  if (status.includes("verifying")) return "verifying";
  return "waiting";
}

function showMessage(message) {
  toast.textContent = message;
  toast.classList.add("is-visible");
  window.clearTimeout(toastTimeout);
  toastTimeout = window.setTimeout(() => {
    toast.classList.remove("is-visible");
  }, 4500);
}

function clearMessage() {
  window.clearTimeout(toastTimeout);
  toast.textContent = "";
  toast.classList.remove("is-visible");
}

function updateJoinButton() {
  joinButton.disabled =
    !socket ||
    socket.readyState !== WebSocket.OPEN ||
    peerCode.length > 0 ||
    pendingJoinCode.length > 0;
}

function updateMessageControls() {
  const isOpen = Boolean(dataChannel && dataChannel.readyState === "open");
  testMessageInput.disabled = !isOpen;
  sendMessageButton.disabled = !isOpen;
  dataChannelStatus.textContent = isOpen ? "DataChannel open" : "Waiting for connection";
  dataChannelStatus.classList.toggle("is-open", isOpen);
  updateFileControls();
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unitIndex]}`;
}

function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return "estimating time";
  if (seconds < 60) return `${Math.ceil(seconds)}s remaining`;
  const minutes = Math.ceil(seconds / 60);
  return `${minutes}m remaining`;
}

function getDataChannelReady() {
  return Boolean(
    dataChannel &&
    dataChannel.readyState === "open" &&
    peerConnection &&
    peerConnection.connectionState === "connected",
  );
}

function updateFileControls() {
  const busy = Boolean(outgoingTransfer);
  sendFileButton.disabled =
    !getDataChannelReady() ||
    !selectedFile ||
    selectedFile.size > MAX_FILE_SIZE ||
    Boolean(busy);
  fileInput.disabled = false;
}

function showSelectedFile(file) {
  selectedFilePanel.hidden = !file;
  if (!file) {
    selectedFileName.textContent = "";
    selectedFileDetails.textContent = "";
    updateFileControls();
    return;
  }

  selectedFileName.textContent = file.name;
  selectedFileDetails.textContent =
    `${formatBytes(file.size)} Â· ${file.type || "Type not provided"}`;
  updateFileControls();
}

function sendFileControl(type, fields = {}) {
  if (!dataChannel || dataChannel.readyState !== "open") {
    return false;
  }
  try {
    dataChannel.send(JSON.stringify({ protocol: FILE_PROTOCOL, type, ...fields }));
    return true;
  } catch {
    showMessage("Could not send a file-transfer control message.");
    return false;
  }
}

function updateOutgoingProgress(force = false) {
  const transfer = outgoingTransfer || outgoingSummary;
  outgoingPanel.hidden = !transfer;
  if (!transfer) return;

  outgoingName.textContent = transfer.name;
  outgoingDetails.textContent =
    `${formatBytes(transfer.size)} Â· ${transfer.mimeType || "Type not provided"}`;
  outgoingStatus.textContent = transfer.status;
  outgoingStatus.dataset.state = transferState(transfer.status);
  outgoingProgress.value = transfer.size === 0
    ? (transfer.status.startsWith("completed") ? 100 : 0)
    : Math.floor((transfer.bytesSent / transfer.size) * 100);

  if (transfer.status === "sending") {
    const percent = transfer.size === 0
      ? 100
      : Math.floor((transfer.bytesSent / transfer.size) * 100);
    const elapsedSeconds = Math.max((performance.now() - transfer.startedAt) / 1000, 0.001);
    const bytesPerSecond = transfer.bytesSent / elapsedSeconds;
    const remaining = bytesPerSecond > 0
      ? (transfer.size - transfer.bytesSent) / bytesPerSecond
      : Number.NaN;
    outgoingProgressText.textContent =
      `${formatBytes(transfer.bytesSent)} / ${formatBytes(transfer.size)} Â· ${percent}% Â· ${formatBytes(bytesPerSecond)}/s Â· ${formatDuration(remaining)}`;
  } else {
    outgoingProgressText.textContent =
      `${formatBytes(transfer.bytesSent)} / ${formatBytes(transfer.size)}`;
  }

  cancelOutgoingButton.hidden = !outgoingTransfer;
  updateFileControls();
}

function updateIncomingProgress() {
  const transfer = incomingTransfer;
  incomingPanel.hidden = !transfer;
  if (!transfer) return;

  incomingName.textContent = transfer.name;
  incomingDetails.textContent =
    `${formatBytes(transfer.size)} Â· ${transfer.mimeType || "Type not provided"}`;
  incomingStatus.textContent = transfer.status;
  incomingStatus.dataset.state = transferState(transfer.status);
  incomingActions.hidden = transfer.status !== "waiting";
  incomingProgressWrap.hidden = !([
    "receiving",
    "verifying",
    "completed",
    "failed",
    "cancelled",
    "rejected",
  ].includes(transfer.status) || transfer.status.startsWith("completed"));
  saveIncomingButton.hidden = true;
  cancelIncomingButton.hidden = !["receiving", "verifying"].includes(transfer.status);
  const percent = transfer.size === 0
    ? (transfer.status.startsWith("completed") ? 100 : 0)
    : Math.floor((transfer.receivedBytes / transfer.size) * 100);
  incomingProgress.value = percent;

  if (transfer.status === "receiving" || transfer.status === "verifying") {
    const elapsedSeconds = Math.max((performance.now() - transfer.startedAt) / 1000, 0.001);
    const bytesPerSecond = transfer.receivedBytes / elapsedSeconds;
    const remaining = bytesPerSecond > 0
      ? (transfer.size - transfer.receivedBytes) / bytesPerSecond
      : Number.NaN;
    incomingProgressText.textContent =
      `${formatBytes(transfer.receivedBytes)} / ${formatBytes(transfer.size)} Â· ${percent}% Â· ${formatBytes(bytesPerSecond)}/s Â· ${formatDuration(remaining)}`;
  } else {
    incomingProgressText.textContent =
      `${formatBytes(transfer.receivedBytes)} / ${formatBytes(transfer.size)} Â· ${percent}%`;
  }
}

function failOutgoingTransfer(message) {
  if (!outgoingTransfer) return;
  outgoingTransfer.cancelWait?.();
  clearOutgoingTimers(outgoingTransfer);
  outgoingSummary = {
    ...outgoingTransfer,
    file: null,
    status: "failed",
  };
  outgoingTransfer = null;
  updateOutgoingProgress(true);
  updateFileControls();
  if (message) showMessage(message);
}

function clearOutgoingTimers(transfer) {
  window.clearTimeout(transfer.approvalTimeout);
  window.clearTimeout(transfer.completionTimeout);
}

function clearIncomingTransfer() {
  if (incomingTransfer) {
    incomingTransfer.chunks = [];
    incomingTransfer.blob = null;
  }
  incomingTransfer = null;
  updateIncomingProgress();
}

function failIncomingTransfer(message, notifyPeer = true) {
  if (!incomingTransfer) {
    showMessage(message);
    return;
  }
  if (incomingTransfer.status.startsWith("completed") ||
      ["failed", "cancelled", "rejected"].includes(incomingTransfer.status)) {
    return;
  }
  const transferId = incomingTransfer.transferId;
  if (notifyPeer) {
    sendFileControl("file-cancel", { transferId, reason: message });
  }
  incomingTransfer.chunks = [];
  incomingTransfer.blob = null;
  incomingTransfer.status = "failed";
  updateIncomingProgress();
  showMessage(message);
}

function stopTransfers(message) {
  if (outgoingTransfer) {
    failOutgoingTransfer(message);
  }
  if (
    incomingTransfer &&
    ["waiting", "receiving", "verifying"].includes(incomingTransfer.status)
  ) {
    failIncomingTransfer(message || "Peer-to-peer connection closed.", false);
  }
}

function makeTransferId() {
  return crypto.randomUUID().replaceAll("-", "").toLowerCase();
}

function waitForDataChannelSpace(channel, transfer) {
  const frameSize = FILE_HEADER_SIZE + Math.min(FILE_CHUNK_SIZE, transfer.size);
  if (channel.readyState !== "open") {
    return Promise.reject(new Error("The peer-to-peer connection closed."));
  }
  if (channel.bufferedAmount + frameSize <= MAX_BUFFERED_BYTES) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    let timeout;
    const cleanup = () => {
      window.clearTimeout(timeout);
      channel.removeEventListener("bufferedamountlow", checkBuffer);
      channel.removeEventListener("close", handleClose);
      channel.removeEventListener("error", handleError);
      if (transfer.cancelWait === cancelWait) {
        transfer.cancelWait = null;
      }
    };
    const checkBuffer = () => {
      if (channel.readyState !== "open") {
        cleanup();
        reject(new Error("The peer-to-peer connection closed."));
      } else if (channel.bufferedAmount + frameSize <= MAX_BUFFERED_BYTES) {
        cleanup();
        resolve();
      }
    };
    const handleClose = () => {
      cleanup();
      reject(new Error("The peer-to-peer connection closed."));
    };
    const handleError = () => {
      cleanup();
      reject(new Error("The DataChannel could not send file data."));
    };
    const cancelWait = () => {
      cleanup();
      reject(new Error("The file transfer was cancelled."));
    };

    transfer.cancelWait = cancelWait;
    channel.bufferedAmountLowThreshold = BUFFERED_LOW_THRESHOLD;
    channel.addEventListener("bufferedamountlow", checkBuffer);
    channel.addEventListener("close", handleClose, { once: true });
    channel.addEventListener("error", handleError, { once: true });
    timeout = window.setTimeout(() => {
      cleanup();
      reject(new Error("Timed out waiting for the DataChannel send buffer."));
    }, 30_000);
    checkBuffer();
  });
}

async function sendFileChunks(transfer, channel) {
  transfer.startedAt = performance.now();
  transfer.status = "sending";
  updateOutgoingProgress(true);

  try {
    for (let index = 0; index < transfer.totalChunks; index += 1) {
      if (outgoingTransfer !== transfer) return;
      if (channel.readyState !== "open") {
        throw new Error("The peer-to-peer connection closed.");
      }

      const start = index * transfer.chunkSize;
      const end = Math.min(start + transfer.chunkSize, transfer.size);
      const chunk = await transfer.file.slice(start, end).arrayBuffer();
      await waitForDataChannelSpace(channel, transfer);
      if (outgoingTransfer !== transfer || channel.readyState !== "open") return;

      // Binary frames use a fixed header: magic, 32-byte transfer ID, index, then payload.
      const frame = new Uint8Array(FILE_HEADER_SIZE + chunk.byteLength);
      frame.set(FILE_MAGIC, 0);
      frame.set(new TextEncoder().encode(transfer.transferId), 4);
      new DataView(frame.buffer).setUint32(36, index);
      frame.set(new Uint8Array(chunk), FILE_HEADER_SIZE);
      channel.send(frame);

      transfer.bytesSent += chunk.byteLength;
      const now = performance.now();
      if (now - progressUpdateAt >= 120 || index === transfer.totalChunks - 1) {
        progressUpdateAt = now;
        updateOutgoingProgress();
      }
    }

    if (outgoingTransfer !== transfer) return;
    transfer.status = "waiting for completion";
    if (!sendFileControl("file-end", {
      transferId: transfer.transferId,
      totalChunks: transfer.totalChunks,
      totalBytes: transfer.bytesSent,
      sha256: transfer.sha256,
    })) {
      throw new Error("Could not announce the end of this file transfer.");
    }
    transfer.completionTimeout = window.setTimeout(() => {
      if (outgoingTransfer !== transfer) return;
      sendFileControl("file-cancel", {
        transferId: transfer.transferId,
        reason: "The receiver did not confirm the completed file.",
      });
      failOutgoingTransfer("Timed out waiting for the receiver to verify the file.");
    }, 300_000);
    updateOutgoingProgress(true);
  } catch (error) {
    if (outgoingTransfer === transfer) {
      sendFileControl("file-cancel", {
        transferId: transfer.transferId,
        reason: "The sender could not finish the transfer.",
      });
      failOutgoingTransfer(
        error instanceof Error ? error.message : "The file transfer failed.",
      );
    }
  }
}

function startOutgoingTransfer() {
  if (!getDataChannelReady() || !selectedFile) {
    showMessage("Connect both devices before sending a file.");
    return;
  }
  if (outgoingTransfer) {
    showMessage("A file transfer is already in progress.");
    return;
  }
  if (selectedFile.size > MAX_FILE_SIZE) {
    showMessage(`This demo supports files up to ${formatBytes(MAX_FILE_SIZE)}.`);
    return;
  }

  const file = selectedFile;
  const transfer = {
    transferId: makeTransferId(),
    file,
    name: file.name,
    size: file.size,
    mimeType: file.type || "application/octet-stream",
    chunkSize: FILE_CHUNK_SIZE,
    totalChunks: Math.ceil(file.size / FILE_CHUNK_SIZE),
    bytesSent: 0,
    startedAt: 0,
    status: "calculating SHA-256",
    sha256: "",
    cancelWait: null,
    announced: false,
  };
  outgoingTransfer = transfer;
  outgoingSummary = null;
  updateOutgoingProgress(true);

  prepareOutgoingTransfer(transfer);
}

async function prepareOutgoingTransfer(transfer) {
  try {
    if (!crypto.subtle) {
      throw new Error("This browser does not support Web Crypto SHA-256.");
    }

    // Web Crypto digest currently needs the whole file in memory; the demo limit bounds this allocation.
    const fileBytes = await transfer.file.arrayBuffer();
    transfer.sha256 = [...new Uint8Array(
      await crypto.subtle.digest("SHA-256", fileBytes),
    )]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");

    if (outgoingTransfer !== transfer) return;
    transfer.status = "waiting for receiver approval";
    selectedFile = null;
    fileInput.value = "";
    showSelectedFile(null);

    if (!sendFileControl("file-start", {
      transferId: transfer.transferId,
      name: transfer.name,
      size: transfer.size,
      mimeType: transfer.mimeType,
      chunkSize: transfer.chunkSize,
      totalChunks: transfer.totalChunks,
      sha256: transfer.sha256,
    })) {
      failOutgoingTransfer("Could not start the file transfer.");
      return;
    }
    transfer.announced = true;
    transfer.approvalTimeout = window.setTimeout(() => {
      if (outgoingTransfer !== transfer) return;
      sendFileControl("file-cancel", {
        transferId: transfer.transferId,
        reason: "The receiver did not respond to the file request.",
      });
      failOutgoingTransfer("Timed out waiting for the receiver to accept the file.");
    }, 120_000);
    updateOutgoingProgress(true);
  } catch (error) {
    if (outgoingTransfer === transfer) {
      failOutgoingTransfer(
        error instanceof Error
          ? `Could not calculate the file checksum: ${error.message}`
          : "Could not calculate the file checksum.",
      );
    }
  }
}

function validIncomingFileStart(message) {
  return (
    typeof message.transferId === "string" &&
    TRANSFER_ID_PATTERN.test(message.transferId) &&
    typeof message.name === "string" &&
    message.name.length > 0 &&
    message.name.length <= 255 &&
    !/[\u0000-\u001f\u007f]/.test(message.name) &&
    Number.isSafeInteger(message.size) &&
    message.size >= 0 &&
    message.size <= MAX_FILE_SIZE &&
    typeof message.mimeType === "string" &&
    message.mimeType.length <= 255 &&
    typeof message.sha256 === "string" &&
    SHA256_PATTERN.test(message.sha256) &&
    message.chunkSize === FILE_CHUNK_SIZE &&
    Number.isSafeInteger(message.totalChunks) &&
    message.totalChunks === Math.ceil(message.size / message.chunkSize)
  );
}

function receiveFileStart(message) {
  if (!validIncomingFileStart(message)) {
    if (typeof message.transferId === "string" &&
        TRANSFER_ID_PATTERN.test(message.transferId)) {
      sendFileControl("file-reject", {
        transferId: message.transferId,
        reason: "The file information is invalid or exceeds the 512 MiB demo limit.",
      });
    }
    showMessage("An invalid or unsupported incoming file was rejected.");
    return;
  }

  if (incomingTransfer && !incomingTransfer.status.startsWith("completed") && ![
    "failed",
    "cancelled",
    "rejected",
  ].includes(incomingTransfer.status)) {
    sendFileControl("file-reject", {
      transferId: message.transferId,
      reason: "Another incoming file is already active.",
    });
    showMessage("Another incoming file is already waiting or has not been saved.");
    return;
  }

  incomingTransfer = {
    transferId: message.transferId,
    name: message.name,
    size: message.size,
    mimeType: message.mimeType || "application/octet-stream",
    chunkSize: message.chunkSize,
    totalChunks: message.totalChunks,
    sha256: message.sha256,
    nextChunk: 0,
    receivedBytes: 0,
    chunks: [],
    endReceived: false,
    startedAt: 0,
    status: "waiting",
    blob: null,
    verificationStarted: false,
    downloadTriggered: false,
  };
  updateIncomingProgress();
}

function acceptIncomingTransfer() {
  if (!incomingTransfer || incomingTransfer.status !== "waiting") return;
  const transfer = incomingTransfer;
  transfer.status = "receiving";
  transfer.startedAt = performance.now();
  if (!sendFileControl("file-accept", { transferId: transfer.transferId })) {
    clearIncomingTransfer();
    showMessage("Could not accept the file because the DataChannel closed.");
    return;
  }
  updateIncomingProgress();
}

function rejectIncomingTransfer() {
  if (!incomingTransfer || incomingTransfer.status !== "waiting") return;
  sendFileControl("file-reject", {
    transferId: incomingTransfer.transferId,
    reason: "The receiver declined the file.",
  });
  incomingTransfer.chunks = [];
  incomingTransfer.status = "rejected";
  updateIncomingProgress();
  showMessage("Incoming file rejected.");
}

async function maybeFinishIncomingTransfer() {
  const transfer = incomingTransfer;
  if (
    !transfer ||
    transfer.status !== "receiving" ||
    transfer.verificationStarted ||
    !transfer.endReceived ||
    transfer.nextChunk !== transfer.totalChunks ||
    transfer.receivedBytes !== transfer.size
  ) {
    return;
  }

  transfer.verificationStarted = true;
  transfer.blob = new Blob(transfer.chunks, { type: transfer.mimeType });
  transfer.chunks = [];
  if (transfer.blob.size !== transfer.size) {
    failIncomingTransfer("The received file size did not match its metadata.");
    return;
  }

  transfer.status = "verifying";
  updateIncomingProgress();

  try {
    if (!crypto.subtle) {
      throw new Error("This browser does not support Web Crypto SHA-256.");
    }
    const fileBytes = await transfer.blob.arrayBuffer();
    const actualChecksum = [...new Uint8Array(
      await crypto.subtle.digest("SHA-256", fileBytes),
    )]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
    if (incomingTransfer !== transfer || transfer.status !== "verifying") return;
    if (actualChecksum !== transfer.sha256) {
      failIncomingTransfer("The received file failed SHA-256 integrity verification.");
      return;
    }

    if (!downloadIncomingFile(transfer)) {
      failIncomingTransfer("The verified file could not be prepared for download.");
      return;
    }
    transfer.status = "completed Â· SHA-256 verified";
    updateIncomingProgress();
    sendFileControl("file-complete", {
      transferId: transfer.transferId,
      totalBytes: transfer.receivedBytes,
      totalChunks: transfer.nextChunk,
      sha256: actualChecksum,
      verified: true,
    });
    showMessage(`Verified and downloaded ${transfer.name}.`);
  } catch (error) {
    if (incomingTransfer === transfer && transfer.status === "verifying") {
      failIncomingTransfer(
        error instanceof Error
          ? `Could not verify the received file: ${error.message}`
          : "Could not verify the received file.",
      );
    }
  }
}

function receiveBinaryChunk(buffer) {
  if (!(buffer instanceof ArrayBuffer)) {
    failIncomingTransfer("Received file data in an unsupported format.");
    return;
  }
  const bytes = new Uint8Array(buffer);
  const transfer = incomingTransfer;
  if (bytes.byteLength < FILE_HEADER_SIZE) {
    failIncomingTransfer("Unexpected file data arrived without an accepted transfer.");
    return;
  }
  if (
    FILE_MAGIC.some((byte, index) => bytes[index] !== byte)
  ) {
    failIncomingTransfer("The received file chunk had an invalid header.");
    return;
  }

  const transferId = new TextDecoder().decode(bytes.subarray(4, 36));
  const chunkIndex = new DataView(buffer).getUint32(36);
  if (!transfer || transfer.status !== "receiving") {
    if (transfer && transfer.transferId === transferId &&
        transfer.status.startsWith("completed")) {
      return;
    }
    sendFileControl("file-cancel", {
      transferId,
      reason: "File data arrived before the receiver accepted an active transfer.",
    });
    if (!transfer || !["completed", "failed", "cancelled", "rejected"].includes(transfer.status)) {
      showMessage("Unexpected file data arrived without an accepted transfer.");
    }
    return;
  }
  if (transferId !== transfer.transferId || chunkIndex !== transfer.nextChunk) {
    failIncomingTransfer("File chunks arrived out of sequence or for another transfer.");
    return;
  }

  const payloadSize = bytes.byteLength - FILE_HEADER_SIZE;
  const expectedSize = Math.min(
    transfer.chunkSize,
    transfer.size - transfer.receivedBytes,
  );
  if (payloadSize !== expectedSize || payloadSize <= 0) {
    failIncomingTransfer("A file chunk had an inconsistent size.");
    return;
  }

  transfer.chunks.push(new Blob([bytes.subarray(FILE_HEADER_SIZE)]));
  transfer.receivedBytes += payloadSize;
  transfer.nextChunk += 1;
  const now = performance.now();
  if (now - progressUpdateAt >= 120 || transfer.nextChunk === transfer.totalChunks) {
    progressUpdateAt = now;
    updateIncomingProgress();
  }
  maybeFinishIncomingTransfer();
}

function cancelOutgoingTransfer() {
  if (!outgoingTransfer) return;
  outgoingTransfer.cancelWait?.();
  clearOutgoingTimers(outgoingTransfer);
  if (outgoingTransfer.announced) {
    sendFileControl("file-cancel", {
      transferId: outgoingTransfer.transferId,
      reason: "The sender cancelled the transfer.",
    });
  }
  outgoingSummary = { ...outgoingTransfer, file: null, status: "cancelled" };
  outgoingTransfer = null;
  updateOutgoingProgress(true);
}

function cancelIncomingTransfer() {
  if (!incomingTransfer) return;
  sendFileControl("file-cancel", {
    transferId: incomingTransfer.transferId,
    reason: "The receiver cancelled the transfer.",
  });
  incomingTransfer.chunks = [];
  incomingTransfer.blob = null;
  incomingTransfer.status = "cancelled";
  updateIncomingProgress();
  showMessage("Incoming file transfer cancelled.");
}

function downloadIncomingFile(transfer) {
  if (!transfer || transfer.downloadTriggered || !transfer.blob) {
    return false;
  }

  const safeName = transfer.name
    .replace(/[\\/]/g, "_")
    .replace(/[\u0000-\u001f\u007f]/g, "_");
  const objectUrl = URL.createObjectURL(transfer.blob);
  const downloadLink = document.createElement("a");
  downloadLink.href = objectUrl;
  downloadLink.download = safeName || "shared-file";
  document.body.append(downloadLink);
  downloadLink.click();
  downloadLink.remove();
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
  transfer.downloadTriggered = true;
  transfer.blob = null;
  return true;
}

function handleFileControl(message) {
  const transferId = message.transferId;

  if (message.type === "file-start") {
    receiveFileStart(message);
    return;
  }

  if (typeof transferId !== "string" || !TRANSFER_ID_PATTERN.test(transferId)) {
    showMessage("Received a malformed file-transfer control message.");
    return;
  }

  if (message.type === "file-accept") {
    if (
      outgoingTransfer &&
      outgoingTransfer.transferId === transferId &&
      outgoingTransfer.status === "waiting for receiver approval"
    ) {
      window.clearTimeout(outgoingTransfer.approvalTimeout);
      sendFileChunks(outgoingTransfer, dataChannel);
    }
    return;
  }

  if (message.type === "file-reject") {
    if (outgoingTransfer && outgoingTransfer.transferId === transferId) {
      clearOutgoingTimers(outgoingTransfer);
      outgoingSummary = {
        ...outgoingTransfer,
        file: null,
        status: "rejected",
      };
      outgoingTransfer = null;
      updateOutgoingProgress(true);
      showMessage(
        typeof message.reason === "string"
          ? `The receiver declined the file: ${message.reason}`
          : "The receiver declined the file.",
      );
    }
    return;
  }

  if (message.type === "file-end") {
    if (!incomingTransfer || incomingTransfer.transferId !== transferId) {
      sendFileControl("file-cancel", {
        transferId,
        reason: "No matching incoming transfer exists.",
      });
      return;
    }
    if (
      incomingTransfer.status !== "receiving" ||
      !Number.isSafeInteger(message.totalBytes) ||
      !Number.isSafeInteger(message.totalChunks) ||
      message.totalBytes !== incomingTransfer.size ||
      message.totalChunks !== incomingTransfer.totalChunks ||
      message.sha256 !== incomingTransfer.sha256
    ) {
      failIncomingTransfer("The file completion information did not match the accepted file.");
      return;
    }
    incomingTransfer.endReceived = true;
    maybeFinishIncomingTransfer();
    return;
  }

  if (message.type === "file-complete") {
    if (!outgoingTransfer || outgoingTransfer.transferId !== transferId) return;
    if (
      outgoingTransfer.status !== "waiting for completion" ||
      message.totalBytes !== outgoingTransfer.size ||
      message.totalChunks !== outgoingTransfer.totalChunks ||
      outgoingTransfer.bytesSent !== outgoingTransfer.size ||
      message.sha256 !== outgoingTransfer.sha256 ||
      message.verified !== true
    ) {
      failOutgoingTransfer("The receiver reported an inconsistent file completion.");
      return;
    }
    clearOutgoingTimers(outgoingTransfer);
    outgoingSummary = {
      ...outgoingTransfer,
      file: null,
      status: "completed Â· SHA-256 verified",
    };
    outgoingTransfer = null;
    updateOutgoingProgress(true);
    return;
  }

  if (message.type === "file-cancel") {
    const reason = typeof message.reason === "string"
      ? message.reason
      : "The other device cancelled the transfer.";
    if (outgoingTransfer && outgoingTransfer.transferId === transferId) {
      clearOutgoingTimers(outgoingTransfer);
      outgoingSummary = { ...outgoingTransfer, file: null, status: "cancelled" };
      outgoingTransfer = null;
      updateOutgoingProgress(true);
    }
    if (incomingTransfer && incomingTransfer.transferId === transferId) {
      incomingTransfer.chunks = [];
      incomingTransfer.blob = null;
      incomingTransfer.status = "cancelled";
      updateIncomingProgress();
    }
    showMessage(reason);
    return;
  }

  showMessage("Received an unknown file-transfer message.");
}

function appendChatMessage(text, isSent) {
  const emptyMessage = messageList.querySelector(".empty-messages");
  if (emptyMessage) {
    emptyMessage.remove();
  }

  const messageElement = document.createElement("div");
  messageElement.className = `chat-message${isSent ? " is-sent" : ""}`;
  messageElement.textContent = `${isSent ? "You" : "Peer"}: ${text}`;
  messageList.append(messageElement);
  messageList.scrollTop = messageList.scrollHeight;
}

function sendSignal(type, fields) {
  if (!socket || socket.readyState !== WebSocket.OPEN || !peerCode) {
    showMessage("Signaling is unavailable. Check that the server is connected and devices are paired.");
    return false;
  }

  try {
    socket.send(JSON.stringify({ type, ...fields }));
    return true;
  } catch {
    showMessage("Could not send a signaling message to the server.");
    return false;
  }
}

function closePeerConnection() {
  const oldChannel = dataChannel;
  const oldConnection = peerConnection;
  window.clearTimeout(peerCloseTimeout);
  stopTransfers("Peer-to-peer connection closed before the file transfer finished.");
  dataChannel = null;
  peerConnection = null;
  offerStarted = false;
  pendingIceCandidates = [];
  updateMessageControls();

  if (oldChannel) {
    oldChannel.onopen = null;
    oldChannel.onclose = null;
    oldChannel.onerror = null;
    oldChannel.onmessage = null;
    oldChannel.close();
  }
  if (oldConnection) {
    oldConnection.onicecandidate = null;
    oldConnection.ondatachannel = null;
    oldConnection.oniceconnectionstatechange = null;
    oldConnection.onconnectionstatechange = null;
    oldConnection.close();
  }
}

function failPeerConnection(message) {
  closePeerConnection();
  setPairStatus("Peer-to-peer connection failed");
  showMessage(`${message} Reconnecting to the signaling server so you can try again.`);
  if (socket && socket.readyState < WebSocket.CLOSING) {
    socket.close();
  }
}

function setDataChannel(channel) {
  if (dataChannel && dataChannel !== channel) {
    dataChannel.close();
  }
  dataChannel = channel;
  channel.binaryType = "arraybuffer";

  channel.onopen = () => {
    if (dataChannel !== channel) return;
    clearMessage();
    setPairStatus("Peer-to-peer connected", true);
    updateMessageControls();
    testMessageInput.focus();
  };

  channel.onmessage = (event) => {
    if (dataChannel !== channel) return;
    if (typeof event.data !== "string") {
      receiveBinaryChunk(event.data);
      return;
    }

    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      appendChatMessage(event.data, false);
      return;
    }

    if (message && message.protocol === CHAT_PROTOCOL && message.type === "chat") {
      if (typeof message.text === "string") {
        appendChatMessage(message.text, false);
      }
    } else if (message && message.protocol === FILE_PROTOCOL) {
      handleFileControl(message);
    } else {
      // Accept plain text from the earlier chat-only version of the frontend.
      appendChatMessage(event.data, false);
    }
  };

  channel.onerror = () => {
    if (dataChannel === channel) {
      showMessage("The peer-to-peer data channel encountered an error.");
      stopTransfers("DataChannel error interrupted the file transfer.");
    }
  };

  channel.onclose = () => {
    if (dataChannel !== channel) return;
    dataChannel = null;
    updateMessageControls();
    if (peerCode) {
      stopTransfers("DataChannel closed before the file transfer finished.");
      setPairStatus("Peer-to-peer connection closed");
      peerCloseTimeout = window.setTimeout(() => {
        if (peerCode && !dataChannel) {
          failPeerConnection(
            "The peer-to-peer data channel closed unexpectedly.",
          );
        }
      }, 1500);
    }
  };

  updateMessageControls();
}

function createPeerConnection() {
  if (peerConnection) {
    return peerConnection;
  }

  const connection = new RTCPeerConnection(PEER_CONFIGURATION);
  peerConnection = connection;

  // ICE candidates are sent to the paired browser through the signaling WebSocket.
  connection.onicecandidate = (event) => {
    if (connection !== peerConnection || !event.candidate) return;
    sendSignal("ice-candidate", { candidate: event.candidate.toJSON() });
  };

  connection.ondatachannel = (event) => {
    if (connection !== peerConnection) return;
    if (event.channel.label !== "shareyou-data") {
      event.channel.close();
      showMessage("Received an unexpected data channel.");
      return;
    }
    setDataChannel(event.channel);
  };

  connection.onconnectionstatechange = () => {
    if (connection !== peerConnection) return;

    if (connection.connectionState === "failed") {
      failPeerConnection(
        "The peer-to-peer connection failed. Check network access and try pairing again.",
      );
    } else if (connection.connectionState === "disconnected") {
      setPairStatus("Peer-to-peer connection interrupted");
    } else if (
      connection.connectionState === "connecting" ||
      connection.connectionState === "new"
    ) {
      setPairStatus("Connecting peer-to-peer");
    } else if (
      connection.connectionState === "connected" &&
      (!dataChannel || dataChannel.readyState !== "open")
    ) {
      setPairStatus("Connecting peer-to-peer");
    } else if (
      connection.connectionState === "connected" &&
      dataChannel.readyState === "open"
    ) {
      setPairStatus("Peer-to-peer connected", true);
    }
  };

  connection.oniceconnectionstatechange = () => {
    if (connection !== peerConnection || connection.iceConnectionState !== "failed") {
      return;
    }
    failPeerConnection(
      "ICE could not find a working network path. Check network access and try pairing again.",
    );
  };

  return connection;
}

// ICE can arrive before the offer/answer sets a remote description; hold it until then.
async function applyPendingIceCandidates(connection) {
  if (connection !== peerConnection || !connection.remoteDescription) {
    return;
  }

  while (pendingIceCandidates.length > 0) {
    const candidate = pendingIceCandidates.shift();
    await connection.addIceCandidate(candidate);
  }
}

async function startOffer() {
  if (offerStarted || !peerCode || !pendingJoinCode) {
    return;
  }

  offerStarted = true;
  pendingJoinCode = "";
  const connection = createPeerConnection();
  setPairStatus("Connecting peer-to-peer");

  try {
    // The client that entered the other code creates the DataChannel and SDP offer.
    setDataChannel(connection.createDataChannel("shareyou-data", { ordered: true }));
    const offer = await connection.createOffer();
    await connection.setLocalDescription(offer);
    if (connection === peerConnection) {
      sendSignal("offer", { sdp: connection.localDescription.sdp });
    }
  } catch {
    if (connection === peerConnection) {
      failPeerConnection(
        "Could not create the WebRTC offer. Check browser support and try pairing again.",
      );
    }
  }
}

async function handleOffer(message) {
  const connection = createPeerConnection();
  if (offerStarted || connection.signalingState !== "stable") {
    showMessage("Ignored a duplicate or unexpected WebRTC offer.");
    return;
  }

  setPairStatus("Connecting peer-to-peer");
  try {
    // The receiving browser applies the offer, then returns an SDP answer.
    await connection.setRemoteDescription({ type: "offer", sdp: message.sdp });
    await applyPendingIceCandidates(connection);
    const answer = await connection.createAnswer();
    await connection.setLocalDescription(answer);
    if (connection === peerConnection) {
      sendSignal("answer", { sdp: connection.localDescription.sdp });
    }
  } catch {
    if (connection === peerConnection) {
      failPeerConnection(
        "Could not accept the WebRTC offer. Try disconnecting and pairing again.",
      );
    }
  }
}

async function handleAnswer(message) {
  const connection = peerConnection;
  if (!connection || connection.signalingState !== "have-local-offer") {
    showMessage("Received an answer when no WebRTC offer was waiting.");
    return;
  }

  try {
    await connection.setRemoteDescription({ type: "answer", sdp: message.sdp });
    await applyPendingIceCandidates(connection);
  } catch {
    if (connection === peerConnection) {
      failPeerConnection("Could not apply the WebRTC answer. Try pairing again.");
    }
  }
}

async function handleIceCandidate(message) {
  const connection = createPeerConnection();
  try {
    const candidate = message.candidate
      ? new RTCIceCandidate(message.candidate)
      : null;

    if (!connection.remoteDescription) {
      pendingIceCandidates.push(candidate);
    } else {
      await connection.addIceCandidate(candidate);
    }
  } catch {
    if (connection === peerConnection) {
      showMessage("A network connection candidate could not be applied.");
    }
  }
}

async function handleServerMessage(message) {
  if (!message || typeof message !== "object" || typeof message.type !== "string") {
    showMessage("The server sent an unexpected message.");
    return;
  }

  if (message.type === "share_code" && typeof message.code === "string") {
    shareCode = message.code;
    shareCodeDisplay.textContent = shareCode;
    copyButton.disabled = false;
    localStatus.textContent = "Your code is ready to share";
    return;
  }

  if (message.type === "paired" && typeof message.peer_code === "string") {
    if (peerCode && peerCode !== message.peer_code) {
      closePeerConnection();
    } else if (peerCode === message.peer_code) {
      return;
    }

    clearMessage();
    peerCode = message.peer_code;
    setPairStatus("Devices paired", true);
    updateJoinButton();
    if (pendingJoinCode === peerCode) {
      await startOffer();
    }
    return;
  }

  if (message.type === "offer" || message.type === "answer" ||
      message.type === "ice-candidate") {
    if (!peerCode || message.from_code !== peerCode) {
      showMessage("Ignored a signaling message from an unpaired device.");
      return;
    }

    if (message.type === "offer" && typeof message.sdp === "string") {
      await handleOffer(message);
    } else if (message.type === "answer" && typeof message.sdp === "string") {
      await handleAnswer(message);
    } else if (message.type === "ice-candidate" &&
        (message.candidate === null || typeof message.candidate === "object")) {
      await handleIceCandidate(message);
    } else {
      showMessage("Received an incomplete WebRTC signaling message.");
    }
    return;
  }

  if (message.type === "error") {
    pendingJoinCode = "";
    updateJoinButton();
    showMessage(
      typeof message.message === "string"
        ? message.message
        : "The server could not complete that request.",
    );
    if (!peerCode) {
      setPairStatus("Not paired");
    }
    return;
  }

  if (message.type === "peer_disconnected") {
    if (!peerCode || message.peer_code !== peerCode) {
      return;
    }
    closePeerConnection();
    peerCode = "";
    pendingJoinCode = "";
    peerCodeInput.value = "";
    setPairStatus("Not paired");
    updateJoinButton();
    showMessage("The other device disconnected. You can pair with another code.");
  }
}

function connectToServer() {
  setServerStatus("connecting", "Connecting to server");
  const currentSocket = new WebSocket(SERVER_URL);
  socket = currentSocket;

  currentSocket.addEventListener("open", () => {
    if (socket !== currentSocket) return;
    window.clearTimeout(reconnectTimeout);
    setServerStatus("connected", "Signaling server connected");
    updateJoinButton();
  });

  currentSocket.addEventListener("message", (event) => {
    if (socket !== currentSocket) return;
    try {
      const message = JSON.parse(event.data);
      handleServerMessage(message).catch(() => {
        failPeerConnection("A WebRTC signaling step failed. Try pairing again.");
      });
    } catch {
      showMessage("The server sent a message that could not be read.");
    }
  });

  currentSocket.addEventListener("error", () => {
    if (socket !== currentSocket) return;
    closePeerConnection();
    setServerStatus("error", "Could not reach signaling server");
    setPairStatus("Signaling server unavailable");
    showMessage("Could not connect to the backend. Make sure it is running on port 8000.");
  });

  currentSocket.addEventListener("close", () => {
    if (socket !== currentSocket) return;
    closePeerConnection();
    shareCode = "";
    peerCode = "";
    pendingJoinCode = "";
    shareCodeDisplay.textContent = "------";
    copyButton.disabled = true;
    setServerStatus("error", "Signaling server disconnected");
    setPairStatus("Not paired");
    updateJoinButton();
    if (!isPageClosing) {
      reconnectTimeout = window.setTimeout(connectToServer, 1800);
    }
  });
}

joinForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const requestedCode = peerCodeInput.value.trim().toUpperCase();

  if (!VALID_CODE.test(requestedCode)) {
    showMessage("Enter a valid six-character code. O, 0, I, and 1 are not used.");
    peerCodeInput.focus();
    return;
  }

  if (!socket || socket.readyState !== WebSocket.OPEN) {
    showMessage("The signaling server is not connected yet.");
    return;
  }

  if (requestedCode === shareCode) {
    showMessage("That is your own share code. Enter a different device's code.");
    peerCodeInput.focus();
    return;
  }

  pendingJoinCode = requestedCode;
  setPairStatus("Requesting connectionâ€¦");
  updateJoinButton();
  socket.send(JSON.stringify({ type: "join", code: requestedCode }));
});

peerCodeInput.addEventListener("input", () => {
  const cursor = peerCodeInput.selectionStart;
  peerCodeInput.value = peerCodeInput.value.toUpperCase().replace(/[^A-Z0-9]/g, "");
  peerCodeInput.setSelectionRange(cursor, cursor);
});

messageForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const text = testMessageInput.value.trim();
  if (!text || !dataChannel || dataChannel.readyState !== "open") {
    return;
  }

  try {
    // Chat and file-control JSON have separate protocol markers on the DataChannel.
    dataChannel.send(JSON.stringify({
      protocol: CHAT_PROTOCOL,
      type: "chat",
      text,
    }));
    appendChatMessage(text, true);
    testMessageInput.value = "";
    testMessageInput.focus();
  } catch {
    showMessage("The test message could not be sent. Check the peer connection.");
  }
});

themeToggle.addEventListener("click", () => {
  const nextTheme = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  applyTheme(nextTheme, true);
});

fileInput.addEventListener("change", () => {
  selectedFile = fileInput.files?.[0] || null;
  showSelectedFile(selectedFile);
  if (selectedFile && selectedFile.size > MAX_FILE_SIZE) {
    showMessage(`This demo supports files up to ${formatBytes(MAX_FILE_SIZE)}.`);
  }
});

dropArea.addEventListener("dragenter", (event) => {
  event.preventDefault();
  dropArea.classList.add("is-dragging");
});

dropArea.addEventListener("dragover", (event) => {
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
  dropArea.classList.add("is-dragging");
});

dropArea.addEventListener("dragleave", (event) => {
  if (!dropArea.contains(event.relatedTarget)) {
    dropArea.classList.remove("is-dragging");
  }
});

dropArea.addEventListener("drop", (event) => {
  event.preventDefault();
  dropArea.classList.remove("is-dragging");
  const files = event.dataTransfer?.files;
  if (!files?.length) return;
  if (files.length > 1) {
    showMessage("Choose one file at a time for this transfer.");
  }
  selectedFile = files[0];
  fileInput.value = "";
  showSelectedFile(selectedFile);
  if (selectedFile.size > MAX_FILE_SIZE) {
    showMessage(`This demo supports files up to ${formatBytes(MAX_FILE_SIZE)}.`);
  }
});

clearFileButton.addEventListener("click", () => {
  selectedFile = null;
  fileInput.value = "";
  showSelectedFile(null);
});

sendFileButton.addEventListener("click", startOutgoingTransfer);
cancelOutgoingButton.addEventListener("click", cancelOutgoingTransfer);
acceptIncomingButton.addEventListener("click", acceptIncomingTransfer);
rejectIncomingButton.addEventListener("click", rejectIncomingTransfer);
cancelIncomingButton.addEventListener("click", cancelIncomingTransfer);
copyButton.addEventListener("click", async () => {
  if (!shareCode) {
    return;
  }

  try {
    await navigator.clipboard.writeText(shareCode);
    copyLabel.textContent = "Copied";
    window.setTimeout(() => {
      copyLabel.textContent = "Copy";
    }, 1600);
  } catch {
    showMessage("Clipboard access is unavailable. Select and copy the code instead.");
  }
});

window.addEventListener("beforeunload", () => {
  isPageClosing = true;
  window.clearTimeout(reconnectTimeout);
  closePeerConnection();
  if (socket && socket.readyState < WebSocket.CLOSING) {
    socket.close();
  }
});

applyTheme(document.documentElement.dataset.theme || "dark");
updateJoinButton();
updateMessageControls();
connectToServer();

