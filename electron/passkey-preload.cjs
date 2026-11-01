"use strict";
// Preload for the passkey ceremony window ONLY (never for the main UI window).
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("lhPasskey", {
	request: () => ipcRenderer.invoke("lh:passkey:request"),
	finish: (result) => ipcRenderer.invoke("lh:passkey:finish", result),
});
