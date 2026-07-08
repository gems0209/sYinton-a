// WebSocket wrapper with exponential-backoff reconnect (1s, 2s, 4s, …, max 10s).
export class WPSocket {
  constructor(url) {
    this.url = url;
    this.handlers = new Map(); // type -> [fn]
    this.backoff = 1000;
    this.open = false;
    this.onstatus = () => {};
    this._outbox = []; // messages sent while connecting (not timesync)
    this._connect();
  }

  _connect() {
    this.ws = new WebSocket(this.url);
    this.ws.onopen = () => {
      this.open = true;
      this.backoff = 1000;
      this.onstatus('open');
      const queued = this._outbox.splice(0);
      for (const raw of queued) { try { this.ws.send(raw); } catch { /* ignore */ } }
      this._emit('_open', {}); // main.js resyncs clock + rejoins here
    };
    this.ws.onmessage = (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      if (msg && typeof msg.type === 'string') this._emit(msg.type, msg);
    };
    this.ws.onclose = () => {
      if (this.open) this.onstatus('closed');
      this.open = false;
      setTimeout(() => this._connect(), this.backoff);
      this.backoff = Math.min(this.backoff * 2, 10000);
    };
    this.ws.onerror = () => {
      try { this.ws.close(); } catch { /* ignore */ }
    };
  }

  on(type, fn) {
    if (!this.handlers.has(type)) this.handlers.set(type, []);
    this.handlers.get(type).push(fn);
  }

  _emit(type, msg) {
    for (const fn of this.handlers.get(type) || []) {
      try { fn(msg); } catch (err) { console.error('ws handler', type, err); }
    }
  }

  send(obj) {
    const raw = JSON.stringify(obj);
    if (this.open) {
      try { this.ws.send(raw); } catch { /* ignore */ }
    } else if (obj.type !== 'timesync') {
      // Don't drop user intent (create/join/…) while the socket is still
      // connecting; timesync pings are worthless once stale, so those drop.
      this._outbox.push(raw);
    }
  }
}
