/* Copyright 2020 Record Replay Inc. */

// Simple protocol client for use in writing standalone applications.

const { defer } = require("./utils");
const { logError } = require("./logger");
const WebSocket = require("ws");

class ProtocolClient {
  constructor(address, callbacks) {
    this.socket = new WebSocket(address);
    this.callbacks = callbacks;

    this.opened = defer();
    this.socket.on("open", () => this.opened.resolve());

    this.socket.on("close", callbacks.onClose);
    this.socket.on("error", callbacks.onError);
    this.socket.on("message", msg => this.onMessage(JSON.parse(msg)));

    // Internal state.
    this.eventListeners = new Map();
    this.pendingMessages = new Map();
    this.nextMessageId = 1;
  }

  close() {
    this.socket.close();
  }

  addEventListener(event, listener) {
    this.eventListeners.set(event, listener);
  }

  async sendCommand(method, params, sessionId) {
    await this.opened.promise;
    const id = this.nextMessageId++;
    this.socket.send(JSON.stringify({ id, method, params, sessionId }));
    const waiter = defer();
    this.pendingMessages.set(id, waiter);
    return waiter.promise;
  }

  onMessage(msg) {
    if (msg.id) {
      const { resolve, reject } = this.pendingMessages.get(msg.id);
      this.pendingMessages.delete(msg.id);
      if (msg.result) {
        resolve(msg.result);
      } else {
        reject(msg.error);
      }
    } else {
      const handler = this.eventListeners.get(msg.method);
      if (handler) {
        handler(msg.params);
      } else {
        logError("MissingMessageHandler", {}, { method: msg.method });
      }
    }
  }
}

module.exports = ProtocolClient;
